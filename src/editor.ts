import { t } from "./i18n";
import { Annotation, EditorState, Extension, Prec, StateField } from "@codemirror/state";
import { Decoration, DecorationSet, EditorView, ViewPlugin, ViewUpdate, WidgetType } from "@codemirror/view";
import { editorInfoField, editorLivePreviewField, MarkdownView, Plugin } from "obsidian";
import { renderTable, TableController, trackLivePreviewHistoryViewport } from "./renderer";
import { createDefaultTable, TableDocument } from "./model";
import { FencedBlock, readTable, readTableId, scanFencedBlocks, serializeTableBody, TABLE_CODE_BLOCK_LANGUAGE } from "./storage";

const tableCellSave = Annotation.define<{ path: string; tableId: string }>();

class TableWidget extends WidgetType {
  controller?: TableController;
  private measuredHeight = -1;
  get estimatedHeight(): number { return this.measuredHeight; }
  constructor(readonly plugin: Plugin, public body: string, readonly path: string, readonly id: string,
    readonly locateEmpty: (view: EditorView, id: string) => FencedBlock | undefined, readonly emptyTable?: TableDocument) { super(); }
  eq(other: TableWidget): boolean { return this.body === other.body && this.path === other.path && this.id === other.id; }
  toDOM(view: EditorView): HTMLElement {
    const root = view.dom.ownerDocument.adoptNode(createDiv());
    root.className = "tablebase-root tb-live-preview";
    this.controller = renderTable(this.plugin, this.body, {
      sourcePath: this.path,
      root,
      editorView: view,
      emptyTable: this.emptyTable,
      emptyBlockStart: () => this.locateEmpty(view, this.id)?.startLine,
      onLayout: () => view.requestMeasure(),
      save: async (expectedBody, table) => {
        const blocks = expectedBody.trim() ? scanFencedBlocks(view.state.doc.toString()).filter((block) => {
          if (block.language !== TABLE_CODE_BLOCK_LANGUAGE) return false;
          return readTableId(block.body) === this.id;
        }) : [this.locateEmpty(view, this.id)].filter((block): block is FencedBlock => !!block);
        if (blocks.length !== 1) throw new Error(t("The table was removed or its ID occurs more than once in this note."));
        const block = blocks[0];
        if (block.body.trim() !== expectedBody.trim()) throw new Error(t("This table changed elsewhere. Reload it before saving."));
        const json = serializeTableBody(table);
        const fromLine = view.state.doc.line(block.startLine + 1);
        const toLine = view.state.doc.line(block.endLine + 1);
        const insert = "\n" + json.split("\n").map((line) => block.indent + line).join("\n") + "\n";
        const previousBody = this.body;
        const markdownView = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
        if (markdownView?.file?.path !== this.path) throw new Error(t("The source note is no longer available."));
        this.body = json;
        try {
          // A document change rebuilds CodeMirror's height map before DOM measurement.
          // Without this estimate, a tall table can shrink to one line and leave the viewport.
          const height = root.offsetHeight;
          if (height > 0) this.measuredHeight = height;
          // The renderer owns viewport preservation across this transaction and
          // layout. Restoring the raw editor offset here would override its cell anchor.
          view.dispatch({
            changes: { from: fromLine.to, to: toLine.from, insert },
            scrollIntoView: false,
            annotations: tableCellSave.of({ path: this.path, tableId: this.id }),
          });
        } catch (error) {
          this.body = previousBody;
          throw error;
        }
        return json;
      },
    });
    return root;
  }
  ignoreEvent(): boolean { return true; }
  destroy(): void { this.controller?.destroy(); }
}

function pathOf(state: EditorState): string { return state.field(editorInfoField, false)?.file?.path ?? ""; }

export function tableEditorExtension(plugin: Plugin): Extension {
  const locateEmpty = (view: EditorView, id: string): FencedBlock | undefined => {
    let startLine: number | undefined;
    view.state.field(decorations).between(0, view.state.doc.length, (from, _to, decoration) => {
      const widget = (decoration.spec as { widget?: unknown }).widget;
      if (widget instanceof TableWidget && widget.id === id) startLine = view.state.doc.lineAt(from).number - 1;
    });
    return scanFencedBlocks(view.state.doc.toString()).find((block) => block.language === TABLE_CODE_BLOCK_LANGUAGE
      && block.startLine === startLine && !block.body.trim());
  };
  const build = (state: EditorState, previous = Decoration.none, preserve?: { path: string; tableId: string }): DecorationSet => {
    if (!state.field(editorLivePreviewField, false)) return Decoration.none;
    const path = pathOf(state); if (!path) return Decoration.none;
    let retainedWidget: TableWidget | undefined;
    if (preserve?.path === path) previous.between(0, state.doc.length, (_from, _to, decoration) => {
      const widget = (decoration.spec as { widget?: unknown }).widget;
      if (widget instanceof TableWidget && widget.path === preserve.path && widget.id === preserve.tableId) retainedWidget = widget;
    });
    let retainedWidgetUsed = false;
    const ranges = scanFencedBlocks(state.doc.toString()).filter((block) => block.language === TABLE_CODE_BLOCK_LANGUAGE).flatMap((block) => {
      try {
        const from = state.doc.line(block.startLine + 1).from;
        const to = state.doc.line(block.endLine + 1).to;
        let emptyTable: TableDocument | undefined;
        if (!block.body.trim()) {
          previous.between(from, to, (oldFrom, oldTo, decoration) => {
            const widget = (decoration.spec as { widget?: unknown }).widget;
            if (widget instanceof TableWidget && oldFrom === from && oldTo === to && widget.path === path && !widget.body.trim()) emptyTable = widget.emptyTable;
          });
          emptyTable ??= createDefaultTable();
        }
        const table = emptyTable ?? readTable(block.body);
        const keepCurrentWidget = !retainedWidgetUsed && retainedWidget?.id === table.tableId;
        const widget = keepCurrentWidget ? retainedWidget! : new TableWidget(plugin, block.body.trim(), path, table.tableId, locateEmpty, emptyTable);
        if (keepCurrentWidget) {
          retainedWidgetUsed = true;
          widget.body = block.body.trim();
        }
        return [Decoration.replace({ block: true, widget }).range(from, to)];
      } catch { return []; } // Leave malformed JSON accessible for repair.
    });
    return Decoration.set(ranges, true);
  };
  const decorations = StateField.define<DecorationSet>({
    create: (state) => build(state),
    update(value, transaction) {
      if (transaction.docChanged || transaction.startState.field(editorLivePreviewField, false) !== transaction.state.field(editorLivePreviewField, false)
        || pathOf(transaction.startState) !== pathOf(transaction.state)) {
        return build(transaction.state, value.map(transaction.changes), transaction.annotation(tableCellSave));
      }
      return value;
    },
    // Take precedence over Obsidian's generic fenced-block preview so edits keep
    // the existing widget, focus and open controls rather than replacing it.
    provide: (field) => Prec.highest(EditorView.decorations.from(field)),
  });
  const historyViewport = ViewPlugin.fromClass(class {
    private tracker?: ReturnType<typeof trackLivePreviewHistoryViewport>;
    constructor(private readonly view: EditorView) {
      this.trackIfNeeded();
    }
    private trackIfNeeded() {
      const state = this.view.state;
      const isLivePreview = !!state.field(editorLivePreviewField, false);
      const path = pathOf(state);
      const hasTable = state.field(decorations).size > 0;
      if (isLivePreview && hasTable && path && !this.tracker) {
        this.tracker = trackLivePreviewHistoryViewport(plugin.app, path, this.view);
      } else if (!isLivePreview && this.tracker) {
        this.tracker.destroy();
        this.tracker = undefined;
      }
    }
    update(update: ViewUpdate) {
      const modeChanged = update.startState.field(editorLivePreviewField, false) !== update.state.field(editorLivePreviewField, false);
      if (update.docChanged || modeChanged) this.trackIfNeeded();
      if (update.docChanged) {
        this.tracker?.onDocumentChange(
          update.startState.doc.toString(),
          update.state.doc.toString(),
          pathOf(update.state),
          !!update.state.field(editorLivePreviewField, false),
        );
      }
    }
    destroy() { this.tracker?.destroy(); }
  });
  return [decorations, EditorView.atomicRanges.of((view) => view.state.field(decorations)), historyViewport];
}
