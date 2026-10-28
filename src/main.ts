import { errorMessage, setLanguage, t } from "./i18n";
import { App, getLanguage, MarkdownRenderChild, MarkdownView, Menu, Notice, Plugin, PluginSettingTab } from "obsidian";
import type { SettingDefinitionItem } from "obsidian";
import { createDefaultTable, TableDocument } from "./model";
import { applyMarkdownExportToNote, insertBlockAfter, readTable, readTableId, scanFencedBlocks, serializeTable, TABLE_CODE_BLOCK_LANGUAGE } from "./storage";
import { confirmMarkdownReplacement, renderTable, showImportPreview } from "./renderer";
import { tableEditorExtension } from "./editor";
import { DEFAULT_SETTINGS, normalizeSuperTableSettings, SuperTableSettings } from "./settings";
import { convertSuperTableToMarkdown } from "./markdown-export";
import { prepareTablePaste } from "./table-copy";

interface EditorBlock {
  start: number;
  end: number;
  language: string;
  body: string;
  indent: string;
}

function findBlockAtCursor(editor: MarkdownView["editor"], languages: string[]): EditorBlock | null {
  const lineAtCursor = editor.getCursor().line;
  let line = 0;
  while (line < editor.lineCount()) {
    const opening = editor.getLine(line).match(/^\s*(`{3,}|~{3,})\s*([\w-]+)?[^\r\n]*$/);
    if (!opening) { line++; continue; }
    const marker = opening[1];
    const indent = editor.getLine(line).match(/^\s*/)?.[0] ?? "";
    const language = (opening[2] || "").toLowerCase();
    let end = line + 1;
    while (end < editor.lineCount() && !new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(editor.getLine(end))) end++;
    if (end >= editor.lineCount()) break;
    if (lineAtCursor >= line && lineAtCursor <= end && languages.includes(language)) {
      const body = Array.from({ length: Math.max(0, end - line - 1) }, (_, index) => editor.getLine(line + index + 1)).join("\n");
      return { start: line, end, language, body, indent };
    }
    line = end + 1;
  }
  return null;
}

function findMarkdownTableAtCursor(editor: MarkdownView["editor"]): EditorBlock | null {
  let current = editor.getCursor().line;
  const isRow = (line: number) => line >= 0 && line < editor.lineCount() && editor.getLine(line).includes("|");
  if (!isRow(current)) return null;
  let start = current;
  let end = current;
  while (isRow(start - 1)) start--;
  while (isRow(end + 1)) end++;
  if (end - start < 1) return null;
  const body = Array.from({ length: end - start + 1 }, (_, index) => editor.getLine(start + index)).join("\n");
  const indent = editor.getLine(start).match(/^\s*/)?.[0] ?? "";
  return { start, end, language: "markdown-table", body, indent };
}

function insertTable(editor: MarkdownView["editor"]): void {
  const table = createDefaultTable();
  const cursor = editor.getCursor();
  const block = serializeTable(table);
  const line = editor.getLine(cursor.line);
  const before = line.slice(0, cursor.ch);
  const after = line.slice(cursor.ch);
  const prefix = before.trim() ? "\n" : "";
  const suffix = after.trim() ? "\n" : "";
  editor.replaceRange(`${prefix}${block}${suffix}`, cursor);
  const startLine = cursor.line + (prefix ? 1 : 0);
  editor.setCursor({ line: startLine + block.split("\n").length - 1, ch: 0 });
}

function addImportedTable(editor: MarkdownView["editor"], block: EditorBlock, table: TableDocument): void {
  const cursorBlock = block.language === "markdown-table"
    ? findMarkdownTableAtCursor(editor)
    : findBlockAtCursor(editor, [block.language]);
  if (!cursorBlock || cursorBlock.start !== block.start || cursorBlock.end !== block.end || cursorBlock.body !== block.body) {
    new Notice(t("The source changed while the import preview was open. Run the command again."));
    return;
  }
  insertBlockAfter(editor, block.end, serializeTable(table), block.indent);
}

function applyEditorTextUpdate(editor: MarkdownView["editor"], before: string, after: string): void {
  let from = 0;
  while (from < before.length && from < after.length && before[from] === after[from]) from++;
  let beforeEnd = before.length;
  let afterEnd = after.length;
  while (beforeEnd > from && afterEnd > from && before[beforeEnd - 1] === after[afterEnd - 1]) {
    beforeEnd--;
    afterEnd--;
  }
  const positionAt = (text: string, offset: number) => {
    const lines = text.slice(0, offset).split(/\r\n|\n/);
    return { line: lines.length - 1, ch: lines[lines.length - 1]?.length ?? 0 };
  };
  editor.replaceRange(after.slice(from, afterEnd), positionAt(before, from), positionAt(before, beforeEnd));
}

export default class SuperTablePlugin extends Plugin {
  // Keep plugin preferences separate from Plugin.settings, introduced in Obsidian 1.13.0.
  superTableSettings: SuperTableSettings = { ...DEFAULT_SETTINGS };

  async saveSettings(): Promise<void> {
    await this.saveData(this.superTableSettings);
  }

  async onload(): Promise<void> {
    let language = "en";
    try { language = getLanguage(); } catch { /* Default to English if settings cannot be read. */ }
    setLanguage(language);
    this.superTableSettings = normalizeSuperTableSettings(await this.loadData());
    this.manifest.description = t("Create editable data tables with typed fields, date formats, grouping, and multiple named views over shared records.");
    this.addSettingTab(new SuperTableSettingTab(this.app, this));
    this.registerEditorExtension(tableEditorExtension(this));
    this.registerMarkdownCodeBlockProcessor(TABLE_CODE_BLOCK_LANGUAGE, (source, element, context) => {
      const createController = () => renderTable(this, source, {
        sourcePath: context.sourcePath, root: element, emptySection: () => context.getSectionInfo(element),
      });
      class TableChild extends MarkdownRenderChild {
        controller?: ReturnType<typeof renderTable>;
        onload(): void {
          this.controller = createController();
        }
        onunload(): void { this.controller?.destroy(); }
      }
      context.addChild(new TableChild(element));
    });

    this.addRibbonIcon("table", t("Insert Super Table"), () => {
      const view = this.app.workspace.getActiveViewOfType(MarkdownView);
      if (!view) { new Notice(t("Open a Markdown note to insert a table.")); return; }
      insertTable(view.editor);
    });

    this.addCommand({
      id: "insert-table",
      name: t("Insert table"),
      editorCallback: (editor) => insertTable(editor),
    });

    this.addCommand({
      id: "import-smart-table",
      name: t("Import Smart Table block"),
      callback: async () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) { new Notice(t("Open a Markdown note and place the cursor inside a Smart Table block.")); return; }
        const block = findBlockAtCursor(view.editor, ["smart-table"]);
        if (!block) { new Notice(t("Place the cursor inside a smart-table code block first.")); return; }
        await showImportPreview(this.app, block.body, "smart-table", async (table) => addImportedTable(view.editor, block, table));
      },
    });

    this.addCommand({
      id: "convert-markdown-table",
      name: t("Convert Markdown table to Super Table"),
      callback: async () => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (!view) { new Notice(t("Open a Markdown note and place the cursor inside a Markdown table.")); return; }
        const block = findMarkdownTableAtCursor(view.editor);
        if (!block) { new Notice(t("Place the cursor inside a Markdown table first.")); return; }
        await showImportPreview(this.app, block.body, "markdown", async (table) => addImportedTable(view.editor, block, table));
      },
    });

    this.addCommand({
      id: "convert-to-markdown",
      name: t("Convert Super Table to Markdown"),
      editorCallback: async (editor) => {
        const block = findBlockAtCursor(editor, [TABLE_CODE_BLOCK_LANGUAGE]);
        if (!block) { new Notice(t("Place the cursor inside a Super Table code block first.")); return; }
        try {
          const source = editor.getValue();
          const sourceBlock = scanFencedBlocks(source).find((candidate) => candidate.language === TABLE_CODE_BLOCK_LANGUAGE
            && candidate.startLine === block.start && candidate.endLine === block.end);
          if (!sourceBlock) throw new Error(t("The table block was not found in the note."));
          const sourceLines = source.split(/\r?\n/);
          const sourceBlockText = sourceLines.slice(sourceBlock.startLine, sourceBlock.endLine + 1).join("\n");
          const table = readTable(sourceBlock.body);
          const markdown = convertSuperTableToMarkdown(table);
          const decision = await confirmMarkdownReplacement(this.app, table, markdown);
          if (!decision.confirmed) return;

          const current = editor.getValue();
          const currentLines = current.split(/\r?\n/);
          const matches = scanFencedBlocks(current).filter((candidate) => candidate.language === TABLE_CODE_BLOCK_LANGUAGE
            && readTableId(candidate.body) === table.tableId);
          if (matches.length > 1) throw new Error(t("This note contains more than one block with the same table ID."));
          if (!matches.length) throw new Error(t("The table block was not found in the note."));
          const currentBlock = matches[0];
          const currentBlockText = currentLines.slice(currentBlock.startLine, currentBlock.endLine + 1).join("\n");
          if (currentBlockText !== sourceBlockText) {
            throw new Error(t("The source changed while the Markdown replacement dialog was open. Run the command again."));
          }

          const updated = applyMarkdownExportToNote(current, table.tableId, sourceBlock.body, markdown, decision.replace);
          if (updated === current) return;
          applyEditorTextUpdate(editor, current, updated);
        } catch (error) {
          new Notice(t("Could not convert Super Table to Markdown: {message}", { message: errorMessage(error) }), 8000);
        }
      },
    });

    this.registerEvent(this.app.workspace.on("editor-paste", (event, editor) => {
      if (event.defaultPrevented || !event.clipboardData) return;
      const target = event.target instanceof Element ? event.target : null;
      const active = target?.ownerDocument.activeElement;
      const editable = target?.closest("[contenteditable='true']");
      if (target?.closest(".tablebase-root, input, textarea, select")
        || active?.closest(".tablebase-root, input, textarea, select")
        || editable && !editable.classList.contains("cm-content")) return;
      const selections = editor.listSelections();
      if (selections.length !== 1) return;
      const selection = selections[0];
      const anchor = editor.posToOffset(selection.anchor);
      const head = editor.posToOffset(selection.head);
      const replacement = prepareTablePaste(editor.getValue(), event.clipboardData.getData("text/plain"), Math.min(anchor, head), Math.max(anchor, head));
      if (replacement === null) return;
      event.preventDefault();
      // Match the host paste origin so rapid consecutive copies undo separately.
      editor.replaceSelection(replacement, "input.paste");
    }));

    this.registerEvent(this.app.workspace.on("editor-menu", (menu: Menu, editor) => {
      const smart = findBlockAtCursor(editor, ["smart-table"]);
      if (smart) menu.addItem((item) => item.setTitle(t("Import Smart Table into Super Table")).setIcon("table").onClick(() => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view) void showImportPreview(this.app, smart.body, "smart-table", async (table) => addImportedTable(view.editor, smart, table));
      }));
      const markdown = findMarkdownTableAtCursor(editor);
      if (markdown) menu.addItem((item) => item.setTitle(t("Convert Markdown table to Super Table")).setIcon("table").onClick(() => {
        const view = this.app.workspace.getActiveViewOfType(MarkdownView);
        if (view) void showImportPreview(this.app, markdown.body, "markdown", async (table) => addImportedTable(view.editor, markdown, table));
      }));
    }));
  }
}

class SuperTableSettingTab extends PluginSettingTab {
  constructor(app: App, private readonly plugin: SuperTablePlugin) { super(app, plugin); }

  getSettingDefinitions(): SettingDefinitionItem[] {
    return [{
      name: t("Attachment image paste location"),
      desc: t("Choose where images pasted into attachment cells are saved. This does not affect device imports."),
      control: {
        type: "dropdown", key: "attachmentImagePasteLocation", defaultValue: "obsidian",
        options: {
          obsidian: t("Use Obsidian attachment settings"),
          "note-folder": t("Use sibling 附件/<note name>/ folder"),
        },
      },
    }];
  }

  getControlValue(key: string): unknown {
    return key === "attachmentImagePasteLocation" ? this.plugin.superTableSettings.attachmentImagePasteLocation : undefined;
  }

  async setControlValue(key: string, value: unknown): Promise<void> {
    if (key !== "attachmentImagePasteLocation") return;
    this.plugin.superTableSettings.attachmentImagePasteLocation = value === "note-folder" ? "note-folder" : "obsidian";
    await this.plugin.saveSettings();
  }

}
