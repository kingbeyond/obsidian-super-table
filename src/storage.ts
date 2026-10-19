import { errorMessage, t } from "./i18n";
import { MarkdownSectionInformation, MarkdownView, Notice, Plugin, TFile } from "obsidian";
import { normalizeTable, TableDocument } from "./model";

export const TABLE_CODE_BLOCK_LANGUAGE = "super-table";

interface TableWriteHistoryEntry {
  tableId: string;
  beforeBody: string;
  afterBody: string;
  redoEmptySection?: MarkdownSectionInformation;
}

interface TableWriteHistory {
  undo: TableWriteHistoryEntry[];
  redo: TableWriteHistoryEntry[];
}

const readingViewHistory = new Map<string, TableWriteHistory>();
const MAX_READING_VIEW_HISTORY = 30;
let recentReadingViewWritePath: string | null = null;
const readingViewHistoryActionsInFlight = new Set<string>();

export interface FencedBlock {
  language: string;
  startLine: number;
  endLine: number;
  body: string;
  marker: string;
  indent: string;
}

export function scanFencedBlocks(text: string): FencedBlock[] {
  const lines = text.split(/\r?\n/);
  const blocks: FencedBlock[] = [];
  for (let i = 0; i < lines.length; i++) {
    const opening = lines[i].match(/^\s*(`{3,}|~{3,})\s*([\w-]+)?[^\r\n]*$/);
    if (!opening) continue;
    const marker = opening[1];
    const indent = lines[i].match(/^\s*/)?.[0] ?? "";
    const language = (opening[2] || "").toLowerCase();
    for (let j = i + 1; j < lines.length; j++) {
      if (new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(lines[j])) {
        const body = lines.slice(i + 1, j).map((line) => indent && line.startsWith(indent) ? line.slice(indent.length) : line).join("\n");
        blocks.push({ language, startLine: i, endLine: j, body, marker, indent });
        i = j;
        break;
      }
    }
  }
  return blocks;
}

export function serializeTableBody(table: TableDocument): string {
  const properties = Object.entries(table).flatMap(([key, value]) => {
    // Keep escaped newlines and nested values inside each record's physical line.
    const body = key === "records" && table.records.length
      ? `[\n${table.records.map((record) => `    ${JSON.stringify(record)}`).join(",\n")}\n  ]`
      : JSON.stringify(value);
    if (body === undefined) return [];
    return [`  ${JSON.stringify(key)}:${body}`];
  });
  return `{\n${properties.join(",\n")}\n}`;
}

function wrapTableBody(body: string): string {
  return `\`\`\`${TABLE_CODE_BLOCK_LANGUAGE}\n${body}\n\`\`\``;
}

export function serializeTable(table: TableDocument): string {
  return wrapTableBody(serializeTableBody(table));
}

export function readTable(source: string): TableDocument {
  return normalizeTable(JSON.parse(source));
}

/** Read only the top-level table ID without parsing the records and field data. */
export function readTableId(source: string): string | null {
  let index = 0;
  const skipWhitespace = () => { while (/\s/.test(source[index] ?? "")) index++; };
  const readString = (): string | null => {
    if (source[index] !== '"') return null;
    const start = index++;
    while (index < source.length) {
      const character = source[index++];
      if (character === "\\") index++;
      else if (character === '"') {
        try { return JSON.parse(source.slice(start, index)) as string; }
        catch { return null; }
      }
    }
    return null;
  };
  const skipValue = (): boolean => {
    if (source[index] === '"') return readString() !== null;
    let depth = 0;
    let inString = false;
    let escaped = false;
    while (index < source.length) {
      const character = source[index];
      if (inString) {
        if (escaped) escaped = false;
        else if (character === "\\") escaped = true;
        else if (character === '"') inString = false;
        index++;
        continue;
      }
      if (character === '"') { inString = true; index++; continue; }
      if (character === "{" || character === "[") { depth++; index++; continue; }
      if (character === "}" || character === "]") {
        if (depth === 0) return false;
        depth--; index++;
        if (depth === 0) return true;
        continue;
      }
      if (character === "," && depth === 0) return true;
      index++;
    }
    return depth === 0;
  };

  skipWhitespace();
  if (source[index++] !== "{") return null;
  while (index < source.length) {
    skipWhitespace();
    if (source[index] === "}" || index >= source.length) return null;
    const key = readString();
    if (key === null) return null;
    skipWhitespace();
    if (source[index++] !== ":") return null;
    skipWhitespace();
    if (key === "tableId") return readString();
    if (!skipValue()) return null;
    skipWhitespace();
    if (source[index] !== ",") return null;
    index++;
  }
  return null;
}

function locateEmptyTableBlock(text: string, section?: MarkdownSectionInformation | null): FencedBlock {
  // An unsaved empty block has no ID. Require a current source snapshot and an
  // unambiguous renderer section instead of guessing among identical blocks.
  if (!section || text.replace(/\r\n/g, "\n") !== section.text.replace(/\r\n/g, "\n")) {
    throw new Error(t("The table changed elsewhere since it was opened. Reload it before saving to avoid overwriting newer data."));
  }
  const blocks = scanFencedBlocks(text).filter((block) => block.language === TABLE_CODE_BLOCK_LANGUAGE
    && block.startLine >= section.lineStart && block.endLine <= section.lineEnd);
  if (blocks.length !== 1 || blocks[0].body.trim()) throw new Error(t("The table block was not found in the note."));
  return blocks[0];
}

export function replaceTableBlockInText(text: string, tableId: string, expectedBody: string, replacement: string, emptySection?: MarkdownSectionInformation | null): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const blocks = scanFencedBlocks(text).filter((block) => block.language === TABLE_CODE_BLOCK_LANGUAGE);
  const matches = blocks.filter((block) => {
    try { return readTable(block.body).tableId === tableId; } catch { return false; }
  });
  if (expectedBody.trim() && matches.length !== 1) throw new Error(matches.length ? t("This note contains more than one block with the same table ID.") : t("The table block was not found in the note."));
  const block = expectedBody.trim() ? matches[0] : locateEmptyTableBlock(text, emptySection);
  if (block.body.trim() !== expectedBody.trim()) throw new Error(t("The table changed elsewhere since it was opened. Reload it before saving to avoid overwriting newer data."));
  const indented = replacement.split("\n").map((line) => `${block.indent}${line}`);
  lines.splice(block.startLine, block.endLine - block.startLine + 1, ...indented);
  return lines.join(newline);
}

export function applyMarkdownExportToNote(
  text: string,
  tableId: string,
  expectedBody: string,
  markdown: string,
  replace: boolean,
  emptySection?: MarkdownSectionInformation | null,
  emptyBlockStartLine?: number,
): string {
  const newline = text.includes("\r\n") ? "\r\n" : "\n";
  const lines = text.split(/\r?\n/);
  const tableBlocks = scanFencedBlocks(text).filter((block) => block.language === TABLE_CODE_BLOCK_LANGUAGE);
  const idMatches = tableBlocks.filter((candidate) => readTableId(candidate.body) === tableId);
  if (idMatches.length > 1) throw new Error(t("This note contains more than one block with the same table ID."));
  let block: FencedBlock;
  if (expectedBody.trim()) {
    if (!idMatches.length) throw new Error(t("The table block was not found in the note."));
    block = idMatches[0];
  } else {
    if (idMatches.length) throw new Error(t("The table ID is already used by another block."));
    if (emptyBlockStartLine !== undefined) {
      const target = tableBlocks.find((candidate) => candidate.startLine === emptyBlockStartLine && !candidate.body.trim());
      if (!target) throw new Error(t("The table block was not found in the note."));
      block = target;
    } else if (emptySection) {
      block = locateEmptyTableBlock(text, emptySection);
    } else {
      const emptyBlocks = tableBlocks.filter((candidate) => !candidate.body.trim());
      if (emptyBlocks.length !== 1) throw new Error(t("An empty Super Table block could not be located unambiguously."));
      block = emptyBlocks[0];
    }
  }
  if (block.body.trim() !== expectedBody.trim()) {
    throw new Error(t("The table changed elsewhere since it was opened. Reload it before saving to avoid overwriting newer data."));
  }

  const markdownLines = markdown.replace(/\r\n?/g, "\n").replace(/\n+$/, "").split("\n")
    .map((line) => `${block.indent}${line}`);
  if (replace) {
    lines.splice(block.startLine, block.endLine - block.startLine + 1, ...markdownLines);
  } else {
    const followingLines = lines.slice(block.endLine + 1);
    const insertion = ["", ...markdownLines];
    if (followingLines[0] !== "") insertion.push("");
    lines.splice(block.endLine + 1, 0, ...insertion);
  }
  return lines.join(newline);
}

export async function writeMarkdownExport(
  plugin: Plugin,
  sourcePath: string,
  tableId: string,
  expectedBody: string,
  markdown: string,
  replace: boolean,
  renderedElement?: HTMLElement,
  emptySection?: MarkdownSectionInformation | null,
): Promise<void> {
  const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
  if (!(file instanceof TFile)) throw new Error(t("The source note is no longer available."));
  if (!plugin.app.vault.process) throw new Error(t("This Obsidian version does not provide safe note updates."));
  await plugin.app.vault.process(file, (current) => applyMarkdownExportToNote(current, tableId, expectedBody, markdown, replace, emptySection));
  if (renderedElement) renderedElement.dataset.tablebaseSaving = "true";
}

function locateTableInEditor(editor: MarkdownView["editor"], tableId: string): { start: number; end: number; body: string; indent: string } {
  const blocks: Array<{ start: number; end: number; body: string; indent: string }> = [];
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
    if (language === TABLE_CODE_BLOCK_LANGUAGE) {
      const body = Array.from({ length: Math.max(0, end - line - 1) }, (_, index) => {
        const value = editor.getLine(line + index + 1);
        return indent && value.startsWith(indent) ? value.slice(indent.length) : value;
      }).join("\n");
      blocks.push({ start: line, end, body, indent });
    }
    line = end + 1;
  }
  const matches = blocks.filter((block) => {
    try { return readTable(block.body).tableId === tableId; } catch { return false; }
  });
  if (matches.length !== 1) throw new Error(matches.length ? t("This note contains duplicate table IDs.") : t("The table is no longer present in the editor."));
  return matches[0];
}

export async function persistTable(
  plugin: Plugin,
  sourcePath: string,
  tableId: string,
  expectedBody: string,
  table: TableDocument,
  renderedElement?: HTMLElement,
  emptySection?: MarkdownSectionInformation | null,
): Promise<string> {
  const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
  if (!(file instanceof TFile)) throw new Error(t("The source note is no longer available."));
  const nextBody = serializeTableBody(table);
  const replacement = wrapTableBody(nextBody);
  const active = plugin.app.workspace.getActiveViewOfType(MarkdownView);
  if (active?.file?.path === sourcePath && active.getMode() === "source") {
    const empty = expectedBody.trim() ? null : locateEmptyTableBlock(active.editor.getValue(), emptySection);
    const block = empty ? { start: empty.startLine, end: empty.endLine, body: empty.body, indent: empty.indent } : locateTableInEditor(active.editor, tableId);
    if (block.body.trim() !== expectedBody.trim()) throw new Error(t("The table changed elsewhere since it was opened. Reload it before saving to avoid overwriting newer data."));
    const close = active.editor.getLine(block.end);
    const indented = replacement.split("\n").map((line) => `${block.indent}${line}`).join("\n");
    // Use the editor in source mode so the table change participates in
    // Obsidian's normal undo history. Preview mode is saved through Vault.process below.
    active.editor.replaceRange(indented, { line: block.start, ch: 0 }, { line: block.end, ch: close.length });
    if (renderedElement) renderedElement.dataset.tablebaseSaving = "true";
    return nextBody;
  }
  if (!plugin.app.vault.process) throw new Error(t("This Obsidian version does not provide safe note updates."));
  let nextDocument = "";
  await plugin.app.vault.process(file, (current) => {
    nextDocument = replaceTableBlockInText(current, tableId, expectedBody, replacement, emptySection);
    return nextDocument;
  });
  if (expectedBody.trim() !== nextBody.trim()) {
    const history = readingViewHistory.get(sourcePath) ?? { undo: [], redo: [] };
    history.undo.push({ tableId, beforeBody: expectedBody, afterBody: nextBody });
    if (history.undo.length > MAX_READING_VIEW_HISTORY) history.undo.shift();
    history.redo.length = 0;
    readingViewHistory.set(sourcePath, history);
    recentReadingViewWritePath = sourcePath;
  }
  if (renderedElement) renderedElement.dataset.tablebaseSaving = "true";
  return nextBody;
}

export function hasReadingViewTableHistory(sourcePath: string, direction: "undo" | "redo"): boolean {
  const history = readingViewHistory.get(sourcePath);
  return !!history?.[direction].length;
}

export function hasRecentReadingViewTableWrite(sourcePath: string): boolean {
  return recentReadingViewWritePath === sourcePath;
}

export function markRecentReadingViewTableWrite(sourcePath: string): void {
  recentReadingViewWritePath = sourcePath;
}

export function clearRecentReadingViewTableWrite(): void {
  recentReadingViewWritePath = null;
}

/** Undo or redo the latest safe Reading view table write without touching other note content. */
export async function applyReadingViewTableHistory(
  plugin: Plugin,
  sourcePath: string,
  direction: "undo" | "redo",
): Promise<string | null> {
  const history = readingViewHistory.get(sourcePath);
  const from = history?.[direction];
  const entry = from?.[from.length - 1];
  if (!history || !from || !entry || readingViewHistoryActionsInFlight.has(sourcePath)) return null;
  const file = plugin.app.vault.getAbstractFileByPath(sourcePath);
  if (!(file instanceof TFile) || !plugin.app.vault.process) throw new Error(t("This Obsidian version does not provide safe note updates."));

  const expectedBody = direction === "undo" ? entry.afterBody : entry.beforeBody;
  const replacementBody = direction === "undo" ? entry.beforeBody : entry.afterBody;
  let nextDocument = "";
  readingViewHistoryActionsInFlight.add(sourcePath);
  try {
    await plugin.app.vault.process(file, (current) => {
      let emptySection: MarkdownSectionInformation | undefined;
      let targetStart: number | undefined;
      if (expectedBody.trim()) {
        const matches = scanFencedBlocks(current).filter((block) => block.language === TABLE_CODE_BLOCK_LANGUAGE).filter((block) => {
          try { return readTable(block.body).tableId === entry.tableId; } catch { return false; }
        });
        if (matches.length === 1) targetStart = matches[0].startLine;
      } else {
        emptySection = entry.redoEmptySection;
      }
      nextDocument = replaceTableBlockInText(current, entry.tableId, expectedBody, wrapTableBody(replacementBody), emptySection);
      if (!replacementBody.trim() && targetStart !== undefined) {
        const endLine = targetStart + wrapTableBody(replacementBody).split("\n").length - 1;
        entry.redoEmptySection = { text: nextDocument, lineStart: targetStart, lineEnd: endLine };
      }
      return nextDocument;
    });

    from.pop();
    const to = history[direction === "undo" ? "redo" : "undo"];
    to.push(entry);
    if (to.length > MAX_READING_VIEW_HISTORY) to.shift();
    recentReadingViewWritePath = sourcePath;
    return replacementBody;
  } finally {
    readingViewHistoryActionsInFlight.delete(sourcePath);
  }
}

export function insertBlockAfter(editor: MarkdownView["editor"], endLine: number, text: string, indent = ""): void {
  const indented = text.split("\n").map((line) => `${indent}${line}`).join("\n");
  const insert = `\n\n${indented}`;
  editor.replaceRange(insert, { line: endLine, ch: editor.getLine(endLine).length });
  editor.setCursor({ line: endLine + insert.split("\n").length - 1, ch: 0 });
}

export function showSaveError(error: unknown): void {
  const message = errorMessage(error);
  new Notice(t("Super Table could not save: {message}", { message: message }), 8000);
}
