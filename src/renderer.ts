import { activeFilterConditions, emptyFilters, filterReferencesOptions } from "./filters";
import { attachFilterSession, closeFilterPopover, refreshFilterPopover, toggleFilterPopover, FilterSession } from "./filter-popover";
import { colorLabel, errorMessage, matchesTranslation, t } from "./i18n";
import { App, Component, MarkdownRenderer, MarkdownSectionInformation, MarkdownView, Menu, Modal, Notice, Platform, Plugin, requestUrl, TFile } from "obsidian";
import { EditorView } from "@codemirror/view";
import {
  CellValue, clampWidth, cloneValue, createDefaultTable, DataGroup, DATE_DISPLAY_FORMATS, DateDisplayFormat, dateValueFromPicker, defaultCell, defaultFieldWidth, fieldTypeLabel,
  FIELD_TYPES, Field, FieldType, filterAndSortRows, formatDateValue, groupRows, makeId, newField, parseDateEditorValue,
  nextOptionColor, OPTION_COLORS, RecordRow, SelectOption, TableDocument, TableView, viewUsesFieldForProjection,
} from "./model";
import { applyReadingViewTableHistory, clearRecentReadingViewTableWrite, hasRecentReadingViewTableWrite, hasReadingViewTableHistory, markRecentReadingViewTableWrite, persistTable, readTable, showSaveError } from "./storage";
import { convertMarkdownTable, convertSmartTable } from "./import";
import { convertSuperTableToMarkdown, createMarkdownExportFile } from "./markdown-export";
import { captureRows, clipboardValues, linkEditorFields, parseWebLink, RowClipboard, moveRelative, serializeWebLink, valueFromLabel } from "./interaction";
import { node as el, configMenuItem, control, icon, fieldIcon, menuAction, submenu, showMenu, promptForm, confirmDialog, FormField, PromptFormOptions } from "./ui";
import { findMarkdownTaskMarkers, needsMarkdownRendering, safeMarkdownEmbeds, setMarkdownTaskState } from "./markdown";
import { markdownPreviewCache } from "./markdown-preview";
import { rememberedView, rememberView } from "./view-state";
import { attachmentIcon, AttachmentCellController, renderAttachmentCell } from "./attachments";
import { attachmentFileNameWithSuffix, noteNamedAttachmentFolder, pastedImageFileName, SuperTableSettings } from "./settings";
import { attachSearchState, CellMatch, findCells } from "./search";
import { cancelViewportRestorations, followViewportTarget, hasHistoryViewportRestoration, registerViewportRestoration } from "./viewport";

interface PendingTableFocus {
  cell?: { rowId: string; fieldId: string };
}
const pendingTableFocus = new WeakMap<Document, Map<string, PendingTableFocus>>();

let accessibleLabelSequence = 0;
let rowClipboardText: string | null = null;

interface CellClipboard {
  type: FieldType;
  value: CellValue;
  text: string;
  options: SelectOption[];
}

// Keep the structured value alongside the system text clipboard so same-type cells
// can preserve option IDs, arrays, booleans and canonical date values.
let cellClipboard: CellClipboard | null = null;

function hiddenAccessibleLabel(text: string): HTMLSpanElement {
  const label = el("span", "tb-sr-only", text);
  label.id = `tb-accessible-label-${++accessibleLabelSequence}`;
  return label;
}

function clipboardImageFile(clipboardData: DataTransfer | null): File | null {
  if (!clipboardData) return null;
  for (const item of Array.from(clipboardData.items ?? [])) {
    if (item.kind !== "file" || !item.type.toLowerCase().startsWith("image/")) continue;
    const file = item.getAsFile();
    if (file) return file;
  }
  return Array.from(clipboardData.files ?? []).find((file) => file.type.toLowerCase().startsWith("image/")) ?? null;
}

async function ensureAttachmentFolder(app: App, folderPath: string): Promise<void> {
  const segments = folderPath.split("/").filter(Boolean);
  let current = "";
  for (const segment of segments) {
    current = current ? `${current}/${segment}` : segment;
    const existing = app.vault.getAbstractFileByPath(current);
    if (existing instanceof TFile) throw new Error(t("A file already exists where an attachment folder is needed: {path}", { path: current }));
    if (existing) continue;
    try {
      await app.vault.createFolder(current);
    } catch (error) {
      const created = app.vault.getAbstractFileByPath(current);
      if (!created || created instanceof TFile) throw error;
    }
  }
}

async function createUniqueAttachmentFile(app: App, folderPath: string, fileName: string, data: ArrayBuffer): Promise<TFile> {
  for (let suffix = 0; suffix < 1000; suffix++) {
    const candidate = attachmentFileNameWithSuffix(fileName, suffix);
    const path = `${folderPath}/${candidate}`;
    if (app.vault.getAbstractFileByPath(path)) continue;
    try {
      return await app.vault.createBinary(path, data);
    } catch (error) {
      if (app.vault.getAbstractFileByPath(path)) continue;
      throw error;
    }
  }
  throw new Error(t("Could not find an unused attachment filename."));
}

async function createObsidianAttachmentFile(app: App, sourcePath: string, fileName: string, data: ArrayBuffer): Promise<TFile> {
  for (let attempt = 0; attempt < 100; attempt++) {
    const path = await app.fileManager.getAvailablePathForAttachment(fileName, sourcePath);
    try {
      return await app.vault.createBinary(path, data);
    } catch (error) {
      if (app.vault.getAbstractFileByPath(path)) continue;
      throw error;
    }
  }
  throw new Error(t("Could not find an unused attachment filename."));
}

function optionFor(field: Field, id: unknown): SelectOption | undefined {
  return field.options?.find((option) => option.id === String(id ?? ""));
}

function displayValue(field: Field, value: CellValue): string {
  if (field.type === "checkbox") return value === true ? t("Checked") : t("Unchecked");
  if (["select", "status"].includes(field.type)) return optionFor(field, value)?.label ?? String(value ?? "");
  if (field.type === "multiselect") {
    return (Array.isArray(value) ? value : []).map((id) => optionFor(field, id)?.label ?? id).join(", ");
  }
  if (field.type === "date") return formatDateValue(value, field.dateFormat ?? "iso-date");
  if (field.type === "attachment") return JSON.stringify(Array.isArray(value) ? value.map(String) : []);
  return value == null ? "" : String(value);
}

function fieldToText(field: Field, value: CellValue): string {
  if (field.type === "checkbox") return value === true ? "TRUE" : "FALSE";
  return displayValue(field, value);
}

function visibleFields(table: TableDocument, view: TableView): Field[] {
  if (!view.visibleFieldIds) return table.fields;
  return table.fields.filter((field) => view.visibleFieldIds!.includes(field.id));
}

function shownRows(table: TableDocument, view: TableView): { rows: RecordRow[]; groups: DataGroup[] | null } {
  const rows = filterAndSortRows(table, view);
  if (!view.group) return { rows, groups: null };
  const groups = groupRows(table, view, rows);
  return { rows: groups.flatMap((group) => group.rows), groups };
}

function groupLayoutSnapshot(table: TableDocument, view: TableView): string | null {
  if (!view.group) return null;
  const { groups } = shownRows(table, view);
  return JSON.stringify({
    fieldId: view.group.fieldId,
    direction: view.group.direction,
    groups: groups?.map((group) => [group.key, group.rows.map((row) => row.id)]) ?? [],
  });
}

function csvEscape(value: string): string {
  // The current CSV export implementation preserves exported values unchanged.
  return /[",\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function tsvEscape(value: string): string {
  return /["\t\n\r]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value;
}

function normalizePageTitle(value: string | null | undefined): string {
  return (value ?? "").replace(/[\s\u200b]+/gu, " ").trim();
}

function extractLinkPageTitle(html: string, href: string): string {
  const page = new DOMParser().parseFromString(html, "text/html");
  const metaContent = (selector: string) => page.querySelector<HTMLMetaElement>(selector)?.content;
  const hostname = new URL(href).hostname.replace(/^www\./i, "").toLowerCase();
  const siteName = normalizePageTitle(metaContent('meta[property="og:site_name"]')) || (hostname === "github.com" ? "GitHub" : "");
  const pageTitle = normalizePageTitle(page.title) || normalizePageTitle(metaContent('meta[property="og:title"]')) || normalizePageTitle(metaContent('meta[name="twitter:title"]'));
  if (!pageTitle || !siteName) return pageTitle;
  let title = pageTitle;
  const siteNameAtEnd = title.slice(-siteName.length).toLocaleLowerCase() === siteName.toLocaleLowerCase();
  const textBeforeSiteName = title.slice(0, -siteName.length);
  if (siteNameAtEnd && /[\s\-–—:|·]$/u.test(textBeforeSiteName)) title = textBeforeSiteName.replace(/[\s\-–—:|·]+$/u, "").trimEnd();
  if (title.toLocaleLowerCase() === siteName.toLocaleLowerCase()) return title;
  const hasSitePrefix = title.slice(0, siteName.length).toLocaleLowerCase() === siteName.toLocaleLowerCase();
  const hasPrefixSeparator = /^\s*[-–—:|·]/u.test(title.slice(siteName.length));
  return hasSitePrefix && hasPrefixSeparator ? title : `${siteName} - ${title}`;
}

async function fetchLinkPageTitle(href: string): Promise<string> {
  let timeoutId: number | undefined;
  const timeout = new Promise<never>((_resolve, reject) => {
    timeoutId = window.setTimeout(() => reject(new Error("Link title request timed out.")), 15_000);
  });
  try {
    const response = await Promise.race([
      requestUrl({ url: href, method: "GET", throw: false, headers: { Accept: "text/html,application/xhtml+xml" } }),
      timeout,
    ]);
    if (response.status < 200 || response.status >= 400) throw new Error(`Request failed with status ${response.status}.`);
    const contentType = Object.entries(response.headers).find(([name]) => name.toLowerCase() === "content-type")?.[1] ?? "";
    if (contentType && !/text\/html|application\/xhtml\+xml/i.test(contentType)) throw new Error("The response is not an HTML page.");
    const title = extractLinkPageTitle(response.text, href);
    if (!title) throw new Error("The page has no title.");
    return title;
  } finally {
    if (timeoutId !== undefined) window.clearTimeout(timeoutId);
  }
}

async function writeClipboard(text: string): Promise<void> {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch {
      // Electron can expose the async API even when its clipboard write is denied.
      // Fall through to the user-gesture-based copy command below.
    }
  }
  const area = el("textarea", "tb-clipboard-helper");
  const previousFocus = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  area.value = text;
  document.body.append(area);
  try {
    area.select();
    if (!document.execCommand("copy")) throw new Error(t("Clipboard access is unavailable."));
  } finally {
    area.remove();
    if (previousFocus?.isConnected) previousFocus.focus({ preventScroll: true });
  }
}

async function downloadCsv(fields: Field[], rows: RecordRow[], fileName: string): Promise<void> {
  const output = [fields.map((field) => csvEscape(field.name)).join(",")];
  rows.forEach((row) => output.push(fields.map((field) => csvEscape(fieldToText(field, row.values[field.id]))).join(",")));
  const content = "\uFEFF" + output.join("\r\n");
  const file = new File([content], fileName, { type: "text/csv;charset=utf-8" });
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: t("Super Table CSV export") });
    return;
  }
  const blob = new Blob([content], { type: "text/csv;charset=utf-8" });
  const link = el("a");
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

async function downloadMarkdown(table: TableDocument, fields: Field[], rows: RecordRow[], fileName: string): Promise<void> {
  const content = createMarkdownExportFile(table, fields, rows);
  const file = new File([content], fileName, { type: "text/markdown;charset=utf-8" });
  if (navigator.share && navigator.canShare?.({ files: [file] })) {
    await navigator.share({ files: [file], title: t("Super Table Markdown export") });
    return;
  }
  const blob = new Blob([content], { type: "text/markdown;charset=utf-8" });
  const link = el("a");
  link.href = URL.createObjectURL(blob);
  link.download = fileName;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(link.href), 1000);
}

type ExportScope = "current" | "all";

export function createExportFileName(viewName: string, scope: ExportScope, extension: "csv" | "md"): string {
  const base = scope === "all" ? `${viewName} - ${t("All data")}` : viewName;
  // eslint-disable-next-line no-control-regex -- Intentionally replace C0 controls in exported filenames.
  const safeBase = base.replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/\s+/g, " ").trim().replace(/[. ]+$/g, "");
  return `${safeBase || t("Super Table export")}.${extension}`;
}

interface CellConversion { value: CellValue; lost: boolean }

function hasCellValue(field: Field, value: CellValue): boolean {
  if (field.type === "checkbox") return value === true;
  if (field.type === "multiselect" || field.type === "attachment") return Array.isArray(value) && value.length > 0;
  return value != null && value !== "";
}

function optionLabels(field: Field, value: CellValue): string[] {
  if (["select", "status", "multiselect"].includes(field.type)) {
    const ids = field.type === "multiselect" ? (Array.isArray(value) ? value : []) : [value];
    return ids.map((id) => optionFor(field, id)?.label ?? String(id ?? "")).filter(Boolean);
  }
  if (field.type === "attachment") return (Array.isArray(value) ? value : []).map(String).filter(Boolean);
  const text = field.type === "date" ? String(value ?? "") : displayValue(field, value);
  return text ? [text] : [];
}

function choicesForDraft(field: Field, records: RecordRow[]): SelectOption[] {
  const options = (field.options ?? []).map((option) => ({ ...option }));
  records.forEach((row) => {
    optionLabels(field, row.values[field.id]).forEach((label) => {
      if (!options.some((option) => option.label === label)) options.push({ id: makeId("option"), label, color: nextOptionColor(options.length) });
    });
  });
  return options;
}

function convertCell(field: Field, type: FieldType, value: CellValue, options: SelectOption[] = []): CellConversion {
  const raw = value == null ? "" : String(value);
  const text = field.type === "date" ? raw : displayValue(field, value);
  const multipleValueLoss = (field.type === "multiselect" || field.type === "attachment") && Array.isArray(value) && value.length > 1;
  if (["select", "status", "multiselect"].includes(type)) {
    const labels = optionLabels(field, value);
    const ids = labels.map((label) => {
      const old = (field.type === "select" || field.type === "status" || field.type === "multiselect")
        ? (Array.isArray(value) ? value : [value]).map((id) => optionFor(field, id)).find((candidate) => candidate?.label === label)
        : undefined;
      return options.find((option) => old?.id === option.id)?.id ?? options.find((option) => option.label === label)?.id;
    }).filter((id): id is string => !!id);
    const ordered = [...new Set(ids)].sort((a, b) => options.findIndex((option) => option.id === a) - options.findIndex((option) => option.id === b));
    const lost = ordered.length !== labels.length || (type !== "multiselect" && ordered.length > 1);
    return { value: type === "multiselect" ? ordered : ordered[0] ?? "", lost };
  }
  if (type === "checkbox") {
    const normalized = text.trim().toLowerCase();
    if (["true", "yes", "1", "x", "[x]", "checked", "done"].includes(normalized) || matchesTranslation(normalized, "Checked") || matchesTranslation(normalized, "Done")) return { value: true, lost: multipleValueLoss };
    if (["false", "no", "0", "[ ]", "[]", "unchecked", "todo"].includes(normalized) || matchesTranslation(normalized, "Unchecked") || matchesTranslation(normalized, "Todo")) return { value: false, lost: multipleValueLoss };
    return { value: false, lost: !!text };
  }
  if (type === "number") {
    if (!text.trim()) return { value: "", lost: false };
    const number = Number(text);
    return Number.isFinite(number) ? { value: number, lost: multipleValueLoss } : { value: "", lost: true };
  }
  if (type === "date") {
    if (!text) return { value: "", lost: false };
    const match = text.match(/^(\d{4})[-/](\d{2})[-/](\d{2})(?:[T ](\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?))?$/);
    if (!match) return { value: "", lost: true };
    const [, year, month, day, time] = match;
    return { value: `${year}-${month}-${day}${time ? `T${time}` : ""}`, lost: multipleValueLoss };
  }
  if (type === "attachment") {
    if (field.type === "attachment") return { value: Array.isArray(value) ? value.map(String) : [], lost: false };
    return { value: [], lost: hasCellValue(field, value) };
  }
  if (type === "text" || type === "link") return { value: text, lost: multipleValueLoss };
  return { value: text, lost: multipleValueLoss };
}

function dateFormatHasTime(format: DateDisplayFormat): boolean {
  return format === "iso-datetime" || format === "slash-datetime" || format === "time";
}

function dateFilterKind(format: DateDisplayFormat): "date" | "datetime" | "time" {
  return format === "time" ? "time" : dateFormatHasTime(format) ? "datetime" : "date";
}

function datePickerValue(raw: string, inputType: "date" | "datetime-local" | "time"): string {
  const match = raw.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](.+))?$/);
  if (!match) return "";
  if (inputType === "date") return match[1];
  if (inputType === "time") return match[2]?.slice(0, 5) ?? "00:00";
  return `${match[1]}T${(match[2] ?? "00:00").slice(0, 5)}`;
}

export interface RenderContext {
  sourcePath: string;
  root: HTMLElement;
  editorView?: EditorView;
  save?: (expectedBody: string, table: TableDocument) => Promise<string>;
  onLayout?: () => void;
  emptyTable?: TableDocument;
  emptySection?: () => MarkdownSectionInformation | null;
  emptyBlockStart?: () => number | undefined;
}

export interface TableController { destroy(): void }
interface DisplayConfigSnapshot {
  fields: TableDocument["fields"];
  visibleIds: Set<string>;
}
interface DisplayConfigSession {
  snapshot(viewId: string): DisplayConfigSnapshot | null;
  trigger(): HTMLButtonElement | null;
  toggleField(viewId: string, fieldId: string): Promise<boolean>;
  moveField(sourceId: string, targetId: string, after: boolean): Promise<boolean>;
}
interface OpenDisplayConfigPopover {
  id: string;
  close(restoreFocus?: boolean): void;
  refresh(): void;
}
interface OpenGroupConfigPopover {
  panelId: string;
  close(restoreFocus?: boolean, preserveOpenState?: boolean): void;
  refresh(): void;
}
const displayConfigSessions = new Map<string, DisplayConfigSession>();
const openDisplayConfigPopovers = new Map<string, OpenDisplayConfigPopover>();
const openGroupConfigPopovers = new Map<string, OpenGroupConfigPopover>();
const collapsedByTable = new Map<string, Set<string>>();
const openGroupsByTable = new Set<string>();
const activeCellByTable = new Map<string, { rowId: string; fieldId: string }>();
let rowClipboard: RowClipboard | null = null;

interface LivePreviewTableWrite {
  sourcePath: string;
  beforeDocument: string;
  afterDocument: string;
}

const livePreviewTableWrites: LivePreviewTableWrite[] = [];
const MAX_LIVE_PREVIEW_TABLE_WRITES = 30;

function livePreviewEditorView(root: HTMLElement): EditorView | null {
  const editorRoot = root.closest<HTMLElement>(".cm-editor");
  return editorRoot ? EditorView.findFromDOM(editorRoot) : EditorView.findFromDOM(root);
}

function editorDocumentFingerprint(text: string): string {
  let first = 0x811c9dc5;
  let second = 0x9e3779b9;
  for (let i = 0; i < text.length; i++) {
    const code = text.charCodeAt(i);
    first = Math.imul(first ^ code, 0x01000193);
    second = Math.imul(second ^ code, 0x85ebca6b);
  }
  return `${text.length}:${first >>> 0}:${second >>> 0}`;
}

function recordLivePreviewTableWrite(sourcePath: string, beforeDocument: string, afterDocument: string): void {
  if (beforeDocument === afterDocument) return;
  livePreviewTableWrites.push({
    sourcePath,
    beforeDocument: editorDocumentFingerprint(beforeDocument),
    afterDocument: editorDocumentFingerprint(afterDocument),
  });
  if (livePreviewTableWrites.length > MAX_LIVE_PREVIEW_TABLE_WRITES) {
    livePreviewTableWrites.splice(0, livePreviewTableWrites.length - MAX_LIVE_PREVIEW_TABLE_WRITES);
  }
}

function isLivePreviewTableHistoryTransition(sourcePath: string, fromFingerprint: string, toFingerprint: string): boolean {
  return livePreviewTableWrites.some((write) => write.sourcePath === sourcePath &&
    (write.afterDocument === fromFingerprint && write.beforeDocument === toFingerprint ||
      write.beforeDocument === fromFingerprint && write.afterDocument === toFingerprint));
}

export interface LivePreviewHistoryViewportTracker {
  onDocumentChange(beforeDocument: string, afterDocument: string, sourcePath: string, isLivePreview: boolean): void;
  destroy(): void;
}

/** Keep a Live Preview viewport stable when Obsidian's native history changes a table block. */
export function trackLivePreviewHistoryViewport(
  app: App,
  initialSourcePath: string,
  editorView: EditorView,
): LivePreviewHistoryViewportTracker {
  const doc = editorView.dom.ownerDocument;
  const win = doc.defaultView;
  const activeView = app.workspace?.getActiveViewOfType?.(MarkdownView);
  if (!win) {
    return { onDocumentChange() {}, destroy() {} };
  }

  const mutationRoot = activeView?.containerEl.contains(editorView.dom)
    ? activeView.containerEl
    : editorView.dom.closest<HTMLElement>(".markdown-source-view") ?? editorView.dom.parentElement ?? doc.body;
  const scrollable = new Set<HTMLElement>([editorView.scrollDOM]);
  for (let parent = editorView.scrollDOM.parentElement; parent; parent = parent.parentElement) {
    const style = win.getComputedStyle(parent);
    const scrollsVertically = /auto|scroll|overlay/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 1;
    const scrollsHorizontally = /auto|scroll|overlay/.test(style.overflowX) && parent.scrollWidth > parent.clientWidth + 1;
    if (scrollsVertically || scrollsHorizontally) scrollable.add(parent);
    if (parent === mutationRoot) break;
  }
  const documentScroller = doc.scrollingElement as HTMLElement | null;
  if (documentScroller && (documentScroller.scrollHeight > documentScroller.clientHeight + 1 ||
      documentScroller.scrollWidth > documentScroller.clientWidth + 1)) scrollable.add(documentScroller);

  const capture = (): ScrollPositionSnapshot[] => [...scrollable].map((element) => ({
    element,
    left: element.scrollLeft,
    top: element.scrollTop,
  }));
  const restore = (positions: ScrollPositionSnapshot[]) => positions.forEach(({ element, left, top }) => {
    if (!element.isConnected) return;
    if (Math.abs(element.scrollLeft - left) > 1) element.scrollLeft = left;
    if (Math.abs(element.scrollTop - top) > 1) element.scrollTop = top;
  });

  let sourcePath = initialSourcePath;
  let stableDocument = editorDocumentFingerprint(editorView.state.doc.toString());
  let stablePositions = capture();
  let pending: { targetDocument: string; positions: ScrollPositionSnapshot[] } | null = null;
  let settleTimer: number | null = null;
  let expiryTimer: number | null = null;
  let releaseRestoration: (() => void) | undefined;

  const currentDocument = () => editorView.state.doc.toString();
  const activePathMatches = () => app.workspace?.getActiveViewOfType?.(MarkdownView)?.file?.path === sourcePath;
  const settlePending = () => {
    if (!pending) return;
    const targetDocument = pending.targetDocument;
    clearPendingTimers();
    observer.disconnect();
    pending = null;
    releaseRestoration?.(); releaseRestoration = undefined;
    stableDocument = targetDocument;
    stablePositions = capture();
  };
  const clearPendingTimers = () => {
    if (settleTimer !== null) win.clearTimeout(settleTimer);
    if (expiryTimer !== null) win.clearTimeout(expiryTimer);
    settleTimer = null;
    expiryTimer = null;
  };
  const scheduleSettle = () => {
    if (settleTimer !== null) win.clearTimeout(settleTimer);
    settleTimer = win.setTimeout(settlePending, 180);
  };
  const restorePending = () => {
    if (!pending || !activePathMatches()) return;
    restore(pending.positions);
    scheduleSettle();
  };
  const observer = new win.MutationObserver(restorePending);
  const beginRestore = (targetDocument: string) => {
    if (pending?.targetDocument === targetDocument) {
      restorePending();
      return;
    }
    // Focused table history already preserves its cell anchor. Native note history
    // needs the offset fallback only when no table controller owns this transition.
    if (hasHistoryViewportRestoration(editorView.dom, cancelPendingForUserInput)) {
      stableDocument = targetDocument; stablePositions = capture();
      return;
    }
    const positions = pending?.positions ?? stablePositions;
    cancelViewportRestorations(editorView.dom);
    pending = { targetDocument, positions };
    releaseRestoration = registerViewportRestoration(mutationRoot, "history", cancelPendingForUserInput);
    observer.observe(mutationRoot, { childList: true, subtree: true, characterData: true });
    restorePending();
    if (expiryTimer !== null) win.clearTimeout(expiryTimer);
    expiryTimer = win.setTimeout(settlePending, 1500);
  };
  const onScroll = () => {
    if (!activePathMatches()) return;
    if (pending) {
      restorePending();
      return;
    }
    const currentText = currentDocument();
    const current = editorDocumentFingerprint(currentText);
    if (current !== stableDocument && isLivePreviewTableHistoryTransition(sourcePath, stableDocument, current)) {
      beginRestore(current);
      return;
    }
    if (current === stableDocument) stablePositions = capture();
  };
  const cancelPendingForUserInput = () => {
    if (!pending) return;
    clearPendingTimers();
    observer.disconnect();
    pending = null;
    releaseRestoration?.(); releaseRestoration = undefined;
    stableDocument = editorDocumentFingerprint(currentDocument());
    stablePositions = capture();
  };
  const cancelForScrollKey = (event: KeyboardEvent) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) cancelPendingForUserInput();
  };

  scrollable.forEach((element) => element.addEventListener("scroll", onScroll, { passive: true }));
  win.addEventListener("scroll", onScroll, true);
  doc.addEventListener("wheel", cancelPendingForUserInput, true);
  doc.addEventListener("touchstart", cancelPendingForUserInput, true);
  doc.addEventListener("pointerdown", cancelPendingForUserInput, true);
  doc.addEventListener("keydown", cancelForScrollKey, true);

  return {
    onDocumentChange(beforeDocument, afterDocument, nextSourcePath, isLivePreview) {
      if (beforeDocument === afterDocument) return;
      const beforeFingerprint = editorDocumentFingerprint(beforeDocument);
      const afterFingerprint = editorDocumentFingerprint(afterDocument);
      if (nextSourcePath !== sourcePath || !isLivePreview || !activePathMatches()) {
        cancelPendingForUserInput();
        sourcePath = nextSourcePath;
        stableDocument = afterFingerprint;
        stablePositions = capture();
        return;
      }
      const trackedTransition = isLivePreviewTableHistoryTransition(sourcePath, beforeFingerprint, afterFingerprint);
      if (trackedTransition) {
        stableDocument = afterFingerprint;
        beginRestore(afterFingerprint);
        return;
      }
      if (pending && pending.targetDocument !== afterFingerprint) cancelPendingForUserInput();
      stableDocument = afterFingerprint;
      stablePositions = capture();
    },
    destroy() {
      cancelPendingForUserInput();
      clearPendingTimers();
      observer.disconnect();
      scrollable.forEach((element) => element.removeEventListener("scroll", onScroll));
      win.removeEventListener("scroll", onScroll, true);
      doc.removeEventListener("wheel", cancelPendingForUserInput, true);
      doc.removeEventListener("touchstart", cancelPendingForUserInput, true);
      doc.removeEventListener("pointerdown", cancelPendingForUserInput, true);
      doc.removeEventListener("keydown", cancelForScrollKey, true);
    },
  };
}

interface ScrollPositionSnapshot {
  element: HTMLElement;
  left: number;
  top: number;
}

function tableRootsInMode(container: HTMLElement, tableId: string, isLivePreview: boolean): HTMLElement[] {
  // Obsidian retains a hidden editor beside Reading View. Its copy of the
  // table must never become the viewport anchor after a preview block rebuild.
  const otherMode = isLivePreview ? ".markdown-preview-view" : ".markdown-source-view";
  return [...container.querySelectorAll<HTMLElement>(".tablebase-root[data-table-id]")]
    .filter((candidate) => candidate.dataset.tableId === tableId && !candidate.closest(otherMode));
}

/** Preserve Obsidian's note viewport while a save rebuilds Reading View content or the Live Preview widget. */
function preserveNoteViewportScroll(
  app: App,
  sourcePath: string,
  root: HTMLElement,
  activeCellElement: HTMLTableCellElement | null,
  isLivePreview: boolean,
  options: { editorView?: EditorView; anchorToTableHeader?: boolean; preserveScrollPosition?: boolean; history?: boolean } = {},
): { finish(): void; cancel(): void } | null {
  const view = app.workspace?.getActiveViewOfType?.(MarkdownView);
  if (view?.file?.path !== sourcePath || (view.getMode() !== "preview" && !isLivePreview)) return null;
  const doc = root.ownerDocument;
  const win = doc.defaultView;
  if (!win) return null;
  cancelViewportRestorations(root);
  const tableId = root.dataset.tableId;
  const visibleBounds = view.containerEl.getBoundingClientRect();
  const tableToolbar = options.anchorToTableHeader ? root.querySelector<HTMLElement>(".tb-toolbar") : null;
  const columnHeader = options.anchorToTableHeader ? root.querySelector<HTMLElement>(".tb-grid thead") : null;
  const toolbarBounds = tableToolbar?.getBoundingClientRect();
  const columnHeaderBounds = columnHeader?.getBoundingClientRect();
  // The sticky toolbar can remain visible after the column headings have scrolled away.
  const visibleHeaderTop = Math.max(visibleBounds.top, toolbarBounds?.bottom ?? visibleBounds.top);
  const headerFullyVisible = !!toolbarBounds && !!columnHeaderBounds
    && toolbarBounds.top >= visibleBounds.top - 1
    && columnHeaderBounds.top >= visibleHeaderTop - 1
    && columnHeaderBounds.bottom <= visibleBounds.bottom + 1;
  const fallbackHeaderTop = columnHeaderBounds && columnHeaderBounds.top < visibleHeaderTop
    ? visibleHeaderTop
    : visibleBounds.top + (toolbarBounds?.height ?? 0);
  const visibleRows = [...root.querySelectorAll<HTMLTableRowElement>("tr.tb-data-row")]
    .filter((row) => {
      const bounds = row.getBoundingClientRect();
      return bounds.bottom > visibleBounds.top && bounds.top < visibleBounds.bottom;
    });
  const anchorCell = activeCellElement?.isConnected && root.contains(activeCellElement)
    ? activeCellElement
    : visibleRows[0]?.querySelector<HTMLTableCellElement>("td.tb-cell") ?? null;
  const useTableHeaderAnchor = !!columnHeader;
  const anchorRowId = useTableHeaderAnchor ? undefined : anchorCell?.parentElement?.dataset.rowId;
  const anchorFieldId = useTableHeaderAnchor ? undefined : anchorCell?.dataset.fieldId;
  const anchorTop = useTableHeaderAnchor
    ? (headerFullyVisible ? columnHeaderBounds.top : fallbackHeaderTop)
    : (anchorCell ?? root).getBoundingClientRect().top;
  const tableScrollLeft = root.querySelector<HTMLElement>(".tb-table-scroll")?.scrollLeft ?? 0;

  const scrollable = new Set<HTMLElement>();
  for (let parent = root.parentElement; parent && view.containerEl.contains(parent); parent = parent.parentElement) {
    const style = win.getComputedStyle(parent);
    const scrollsVertically = /auto|scroll|overlay/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 1;
    const scrollsHorizontally = /auto|scroll|overlay/.test(style.overflowX) && parent.scrollWidth > parent.clientWidth + 1;
    if (scrollsVertically || scrollsHorizontally) scrollable.add(parent);
    if (parent === view.containerEl) break;
  }
  const editorScroll = options.editorView?.scrollDOM ?? (isLivePreview ? livePreviewEditorView(root)?.scrollDOM : null);
  if (editorScroll) scrollable.add(editorScroll);
  const documentScroller = doc.scrollingElement as HTMLElement | null;
  if (documentScroller && (documentScroller.scrollHeight > documentScroller.clientHeight + 1 || documentScroller.scrollWidth > documentScroller.clientWidth + 1)) {
    scrollable.add(documentScroller);
  }

  const positions: ScrollPositionSnapshot[] = [...scrollable].map((element) => ({
    element,
    left: element.scrollLeft,
    top: element.scrollTop,
  }));

  const currentRoot = (): HTMLElement | null => {
    if (root.isConnected) return root;
    if (!tableId) return null;
    return tableRootsInMode(view.containerEl, tableId, isLivePreview)[0] ?? null;
  };
  const currentAnchor = (): HTMLElement | null => {
    const tableRoot = currentRoot();
    if (!tableRoot) return null;
    if (useTableHeaderAnchor) return tableRoot.querySelector<HTMLElement>(".tb-grid thead") ?? tableRoot;
    if (anchorRowId && anchorFieldId) {
      const cell = [...tableRoot.querySelectorAll<HTMLTableCellElement>("td.tb-cell")]
        .find((candidate) => candidate.dataset.fieldId === anchorFieldId && candidate.parentElement?.dataset.rowId === anchorRowId);
      if (cell) return cell;
    }
    return tableRoot;
  };
  const verticalScroller = (element: HTMLElement): HTMLElement | null => {
    for (let parent = element.parentElement; parent && view.containerEl.contains(parent); parent = parent.parentElement) {
      const style = win.getComputedStyle(parent);
      if (/auto|scroll|overlay/.test(style.overflowY) && parent.scrollHeight > parent.clientHeight + 1) return parent;
      if (parent === view.containerEl) break;
    }
    const documentScroller = doc.scrollingElement as HTMLElement | null;
    return documentScroller && documentScroller.scrollHeight > documentScroller.clientHeight + 1 ? documentScroller : null;
  };
  let stopped = false;
  let finished = false;
  let restoreFrame: number | null = null;
  let settleTimer: number | null = null;
  let expiryTimer: number | null = null;
  let releaseRestoration: (() => void) | undefined;

  const restore = () => {
    if (stopped) return;
    const tableRoot = currentRoot();
    const tableScroll = tableRoot?.querySelector<HTMLElement>(".tb-table-scroll");
    if (tableScroll && Math.abs(tableScroll.scrollLeft - tableScrollLeft) > 1) tableScroll.scrollLeft = tableScrollLeft;
    positions.forEach(({ element, left }) => {
      if (!element.isConnected) return;
      if (Math.abs(element.scrollLeft - left) > 1) element.scrollLeft = left;
    });

    const anchor = currentAnchor();
    // Filters can remove the anchor row or move it far down when OR reveals more rows.
    // Keep the note offset instead of following that record through the new result set.
    if (anchor && !options.preserveScrollPosition) {
      const offset = anchor.getBoundingClientRect().top - anchorTop;
      const scroller = verticalScroller(anchor);
      if (scroller && Math.abs(offset) > 1) scroller.scrollTop += offset;
    } else {
      positions.forEach(({ element, top }) => {
        if (element.isConnected && Math.abs(element.scrollTop - top) > 1) element.scrollTop = top;
      });
    }
  };
  const stop = () => {
    if (stopped) return;
    stopped = true;
    releaseRestoration?.(); releaseRestoration = undefined;
    observer.disconnect();
    if (restoreFrame !== null) win.cancelAnimationFrame(restoreFrame);
    positions.forEach(({ element }) => element.removeEventListener("scroll", scheduleRestore));
    if (settleTimer !== null) win.clearTimeout(settleTimer);
    if (expiryTimer !== null) win.clearTimeout(expiryTimer);
    doc.removeEventListener("wheel", cancelForUserInput, true);
    doc.removeEventListener("touchstart", cancelForUserInput, true);
    doc.removeEventListener("pointerdown", cancelForUserInput, true);
    doc.removeEventListener("keydown", cancelForScrollKey, true);
  };
  const scheduleRestore = () => {
    if (stopped) return;
    if (restoreFrame === null) {
      restoreFrame = win.requestAnimationFrame(() => {
        restoreFrame = null;
        restore();
      });
    }
    if (finished) {
      if (settleTimer !== null) win.clearTimeout(settleTimer);
      settleTimer = win.setTimeout(stop, 180);
    }
  };
  const cancelForUserInput = () => stop();
  const cancelForScrollKey = (event: KeyboardEvent) => {
    if (["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "].includes(event.key)) stop();
  };
  const observer = new win.MutationObserver(scheduleRestore);
  releaseRestoration = registerViewportRestoration(view.containerEl, options.history ? "history" : "save", stop);
  positions.forEach(({ element }) => element.addEventListener("scroll", scheduleRestore, { passive: true }));
  observer.observe(view.containerEl, { childList: true, subtree: true, characterData: true });
  doc.addEventListener("wheel", cancelForUserInput, true);
  doc.addEventListener("touchstart", cancelForUserInput, true);
  doc.addEventListener("pointerdown", cancelForUserInput, true);
  doc.addEventListener("keydown", cancelForScrollKey, true);
  expiryTimer = win.setTimeout(stop, 1500);
  return {
    cancel: stop,
    finish() {
      if (stopped) return;
      finished = true;
      scheduleRestore();
      if (settleTimer !== null) win.clearTimeout(settleTimer);
      settleTimer = win.setTimeout(stop, 180);
    },
  };
}

function pickAttachments(app: App, sourcePath: string): Promise<string[] | null> {
  return new Promise((resolve) => {
    class AttachmentModal extends Modal {
      selected = new Set<string>();
      result: string[] | null = null;
      query = "";
      list = el("div", "tb-attachment-picker-list");
      status = el("div", "tb-attachment-picker-count");
      search = el("input", "tb-input tb-attachment-picker-search");
      importInput = el("input", "tb-attachment-picker-file-input");

      onOpen(): void {
        this.setTitle(t("Choose attachments"));
        this.modalEl.classList.add("tb-ui-surface", "tb-attachment-picker-modal");
        this.contentEl.classList.add("tb-dialog", "tb-attachment-picker");
        this.search.type = "search";
        this.search.placeholder = t("Search files…");
        const searchLabel = hiddenAccessibleLabel(t("Search files…"));
        this.search.setAttribute("aria-labelledby", searchLabel.id);
        this.search.oninput = () => { this.query = this.search.value.trim().toLocaleLowerCase(); this.drawList(); };
        this.importInput.type = "file"; this.importInput.multiple = true; this.importInput.hidden = true;
        this.importInput.onchange = () => { void this.importFiles([...this.importInput.files ?? []]); };
        const actions = el("div", "tb-dialog-actions");
        const importButton = control(t("Import from device"), "file-up", "tb-attachment-picker-import");
        importButton.onclick = () => this.importInput.click();
        const cancel = control(t("Cancel")); cancel.onclick = () => this.close();
        const add = control(t("Add selected"), "paperclip"); add.classList.add("mod-cta");
        add.onclick = () => { this.result = [...this.selected]; this.close(); };
        [importButton, cancel, add].forEach((button) => {
          button.removeAttribute("aria-label");
          button.querySelector(".tb-control-icon")?.setAttribute("aria-hidden", "true");
        });
        const submitActions = el("div", "tb-attachment-picker-submit-actions");
        submitActions.append(cancel, add);
        actions.append(importButton, submitActions);
        this.contentEl.append(searchLabel, this.search, this.status, this.list, this.importInput);
        this.contentEl.append(actions);
        this.drawList(); this.search.focus();
      }

      drawList(): void {
        const active = this.list.ownerDocument.activeElement as HTMLElement | null;
        const focusedPath = active && this.list.contains(active) ? active.closest<HTMLElement>(".tb-attachment-picker-file")?.dataset.path : undefined;
        const scrollTop = this.list.scrollTop;
        const all = app.vault.getFiles();
        const matching = all.filter((file) => !this.query || file.path.toLocaleLowerCase().includes(this.query) || file.name.toLocaleLowerCase().includes(this.query));
        const shown = matching.slice(0, 100);
        this.status.textContent = t("Showing {shown} of {total} files · {selected} selected", { shown: shown.length, total: matching.length, selected: this.selected.size });
        this.list.replaceChildren();
        if (!matching.length) this.list.append(el("div", "tb-attachment-picker-empty", t("No matching files.")));
        shown.forEach((file) => {
          const row = control("", attachmentIcon(file.path), `tb-attachment-picker-file${this.selected.has(file.path) ? " is-selected" : ""}`);
          row.dataset.path = file.path;
          row.removeAttribute("aria-label");
          row.setAttribute("aria-pressed", String(this.selected.has(file.path)));
          row.querySelector(".tb-control-icon")?.setAttribute("aria-hidden", "true");
          const pathLabel = el("span", "tb-attachment-picker-path", file.path);
          pathLabel.id = makeId("tb-attachment-picker-path");
          row.setAttribute("aria-labelledby", pathLabel.id);
          const check = icon("check", "tb-attachment-picker-check");
          check.setAttribute("aria-hidden", "true");
          row.append(pathLabel, check);
          row.onclick = () => {
            if (this.selected.has(file.path)) this.selected.delete(file.path); else this.selected.add(file.path);
            this.drawList();
          };
          this.list.append(row);
        });
        if (focusedPath) {
          [...this.list.querySelectorAll<HTMLButtonElement>(".tb-attachment-picker-file")].find((row) => row.dataset.path === focusedPath)?.focus({ preventScroll: true });
        }
        this.list.scrollTop = scrollTop;
      }

      async importFiles(files: File[]): Promise<void> {
        for (const external of files) {
          try {
            const path = await app.fileManager.getAvailablePathForAttachment(external.name, sourcePath);
            const imported = await app.vault.createBinary(path, await external.arrayBuffer());
            this.selected.add(imported.path);
          } catch (error) {
            new Notice(t("Could not import {name}: {message}", { name: external.name, message: errorMessage(error) }));
          }
        }
        this.importInput.value = "";
        this.drawList();
      }

      onClose(): void { resolve(this.result); }
    }
    new AttachmentModal(app).open();
  });
}

export function renderTable(plugin: Plugin, source: string, context: RenderContext): TableController {
  let table: TableDocument;
  try { table = source.trim() ? readTable(source) : context.emptyTable ?? createDefaultTable(); }
  catch (error) { renderInvalidBlock(context.root, source, error); return { destroy() {} }; }
  const root = context.root;
  root.classList.add("tablebase-root");
  root.dataset.tableId = table.tableId;
  root.tabIndex = -1;
  const tableKey = `${context.sourcePath}\u0000${table.tableId}`;
  const markdownPreviews = markdownPreviewCache(plugin, root.ownerDocument, context.sourcePath);
  let expectedBody = source.trim();
  let activeViewId = rememberedView(plugin.app, tableKey) ?? table.defaultViewId;
  let groupPanelOpen = openGroupsByTable.has(tableKey);
  let selectionMode = false;
  let activeCell = activeCellByTable.get(tableKey);
  let activeCellElement: HTMLTableCellElement | null = null;
  let activeHeaderId: string | undefined;
  let editingHeaderId: string | undefined;
  let pointerDownHeaderId: string | null = null;
  let pointerDownHeaderWasActive = false;
  const cellActions = new WeakMap<HTMLTableCellElement, { render: () => HTMLElement[]; deactivate?: () => void; nodes?: HTMLElement[] }>();
  const textCellEditors = new WeakMap<HTMLTableCellElement, () => void>();
  const cellEditors = new WeakMap<HTMLTableCellElement, () => void>();
  const attachmentCells = new Map<HTMLTableCellElement, AttachmentCellController>();
  let pointerDownWillOpenAttachments = false;
  let lastPointerEditableCell: HTMLTableCellElement | null = null;
  let pointerDownCell: HTMLTableCellElement | null = null;
  let pointerDownWasCellControl = false;
  let pointerDownWillEditCell = false;
  const rowElementsById = new Map<string, HTMLTableRowElement>();
  const selectedRows = new Set<string>();
  const collapsed = collapsedByTable.get(tableKey) ?? new Set<string>();
  collapsedByTable.set(tableKey, collapsed);
  let destroyed = false;
  let saveQueue: Promise<unknown> = Promise.resolve();
  let multiSelectPicker: {
    panel: HTMLDivElement;
    anchor: HTMLButtonElement;
    rowId: string;
    fieldId: string;
    triggerId: string;
    onPointerDown: (event: PointerEvent) => void;
    onFocusIn: (event: FocusEvent) => void;
    onKeyDown: (event: KeyboardEvent) => void;
    position: () => void;
  } | null = null;
  const markdownLifecycle = new Component(); markdownLifecycle.load();
  const markdownComponents = new Map<HTMLTableCellElement, Component>();
  const markdownRenderers = new WeakMap<Element, () => void>();
  const textEditorDisposers = new Set<() => void>();
  const linkEditorClosers = new Set<(restoreFocus?: boolean) => void>();
  const openTableMenus = new Set<Menu>();
  const pendingLinkOpenTimers = new WeakMap<HTMLTableCellElement, number>();
  let markdownObserver: IntersectionObserver | null = null;
  let markdownGeneration = 0;
  const currentView = (): TableView => {
    const view = table.views.find((view) => view.id === activeViewId) ?? table.views.find((view) => view.id === table.defaultViewId) ?? table.views[0];
    // Ignore unresolved projections in the UI while retaining their stored configuration.
    const sort = view.sort && table.fields.some((field) => field.id === view.sort!.fieldId) ? view.sort : undefined;
    const group = view.group && table.fields.some((field) => field.id === view.group!.fieldId) ? view.group : undefined;
    return sort === view.sort && group === view.group ? view : { ...view, sort, group };
  };
  const searchSession = attachSearchState(plugin, root, tableKey, currentView().id);
  const search = searchSession.state;
  let searchMatches: CellMatch[] = [];
  const highlightedSearchCells = new Set<HTMLElement>();
  let searchFrame: number | null = null;
  const prompt = (title: string, fields: FormField[], label?: string, options?: PromptFormOptions) => promptForm(plugin.app, title, fields, label, options);
  const confirm = (title: string, message: string, label?: string) => confirmDialog(plugin.app, title, message, label);
  const report = (error: unknown) => { new Notice(errorMessage(error)); };
  const scrollProxy = el("div", "tb-floating-scrollbar");
  scrollProxy.setAttribute("role", "scrollbar"); scrollProxy.setAttribute("aria-orientation", "horizontal");
  scrollProxy.setAttribute("aria-label", t("Horizontal table scrollbar")); scrollProxy.tabIndex = 0; scrollProxy.hidden = true;
  const scrollSpacer = el("div", "tb-floating-scrollbar-spacer"); scrollProxy.append(scrollSpacer);
  root.ownerDocument.body.append(scrollProxy);
  const scrollRegionId = `tb-scroll-${table.tableId}`;
  let proxyFrame: number | null = null;
  let observedScrollWrap: HTMLElement | null = null;
  let observedGrid: HTMLElement | null = null;
  let viewportScrollElement: HTMLElement | null = null;
  let proxyResizeObserver: ResizeObserver | null = null;
  const viewportWindow = root.ownerDocument.defaultView ?? window;

  function releaseMarkdownCell(cell: HTMLTableCellElement): void {
    const component = markdownComponents.get(cell);
    if (!component) return;
    markdownComponents.delete(cell);
    markdownLifecycle.removeChild(component);
  }

  function clearMarkdownCells(): void {
    markdownGeneration++;
    markdownObserver?.disconnect(); markdownObserver = null;
    [...markdownComponents.keys()].forEach(releaseMarkdownCell);
  }

  function disposeTextEditors(): void {
    [...textEditorDisposers].forEach((dispose) => dispose());
  }

  function closeLinkEditors(restoreFocus = false): void {
    [...linkEditorClosers].forEach((close) => close(restoreFocus));
  }

  function observeMarkdownContent(element: HTMLElement, renderNow: () => void): void {
    if (!markdownObserver) { queueMicrotask(renderNow); return; }
    markdownRenderers.set(element, renderNow);
    markdownObserver.observe(element);
  }

  function prepareMarkdownObserver(): void {
    if (typeof IntersectionObserver === "undefined") return;
    markdownObserver = new IntersectionObserver((entries) => entries.forEach((entry) => {
      if (!entry.isIntersecting) return;
      markdownObserver?.unobserve(entry.target);
      const renderNow = markdownRenderers.get(entry.target);
      markdownRenderers.delete(entry.target);
      renderNow?.();
    }), { rootMargin: "240px" });
  }

  function registerCellActions(cell: HTMLTableCellElement, renderActions: () => HTMLElement[], deactivate?: () => void): void {
    cellActions.set(cell, { render: renderActions, deactivate });
  }

  function ensureCellActions(cell: HTMLTableCellElement): void {
    const actions = cellActions.get(cell);
    if (!actions || actions.nodes) return;
    actions.nodes = actions.render();
  }

  function clearCellActions(cell: HTMLTableCellElement): void {
    const actions = cellActions.get(cell);
    if (!actions) return;
    actions.deactivate?.();
    actions.nodes?.forEach((node) => node.remove());
    actions.nodes = undefined;
  }

  function trackTableMenu(menu: Menu): void {
    openTableMenus.add(menu);
    menu.onHide(() => openTableMenus.delete(menu));
  }

  function showTableMenu(menu: Menu, anchor: HTMLElement, event?: MouseEvent, onHide?: () => void): void {
    openTableMenus.add(menu);
    // showMenu owns the single host hide hook; compose both cleanups there.
    showMenu(menu, anchor, event, () => { openTableMenus.delete(menu); onHide?.(); });
  }

  function openExportMenu(anchor: HTMLElement, event: MouseEvent): void {
    const menu = new Menu().setUseNativeMenu(false);
    const addScopes = (child: Menu, exportFormat: (scope: ExportScope) => void) => {
      child.setUseNativeMenu(false);
      menuAction(child, t("Current view"), "eye", () => exportFormat("current"));
      menuAction(child, t("All fields and records"), "database", () => exportFormat("all"));
    };
    submenu(menu, t("Export CSV"), "file-output", (child) => addScopes(child, (scope) => exportCsv(scope)), trackTableMenu);
    submenu(menu, t("Export Markdown"), "file-output", (child) => {
      child.setUseNativeMenu(false);
      menuAction(child, t("Current view"), "eye", () => exportMarkdownFile("current"));
      menuAction(child, t("All fields and records"), "database", () => exportMarkdownFile("all"));
      child.addSeparator();
      menuAction(child, t("Copy current view"), "clipboard-copy", () => copyMarkdown("current"));
      menuAction(child, t("Copy all fields and records"), "clipboard-copy", () => copyMarkdown("all"));
    }, trackTableMenu);
    showTableMenu(menu, anchor, event);
  }

  function choiceButtonForCell(rowId: string, fieldId: string): HTMLButtonElement | null {
    const cell = [...root.querySelectorAll<HTMLTableCellElement>("td.tb-cell")]
      .find((item) => item.dataset.fieldId === fieldId && item.parentElement?.dataset.rowId === rowId);
    return cell?.querySelector<HTMLButtonElement>("button[data-choice-trigger='true']") ?? null;
  }

  function closeMultiSelectPicker(restoreFocus = false): void {
    const picker = multiSelectPicker;
    if (!picker) return;
    multiSelectPicker = null;
    const doc = root.ownerDocument;
    const win = doc.defaultView;
    doc.removeEventListener("pointerdown", picker.onPointerDown, true);
    doc.removeEventListener("focusin", picker.onFocusIn, true);
    doc.removeEventListener("keydown", picker.onKeyDown, true);
    win?.removeEventListener("resize", picker.position);
    win?.removeEventListener("scroll", picker.position, true);
    win?.visualViewport?.removeEventListener("resize", picker.position);
    win?.visualViewport?.removeEventListener("scroll", picker.position);
    picker.anchor.setAttribute("aria-expanded", "false");
    picker.anchor.removeAttribute("aria-controls");
    picker.panel.remove();
    if (restoreFocus) {
      const anchor = choiceButtonForCell(picker.rowId, picker.fieldId) ?? picker.anchor;
      if (anchor.isConnected) {
        // Picker focus hides cell actions; a hidden trigger cannot receive browser focus.
        anchor.closest("td.tb-cell")?.classList.add("is-cell-active");
        anchor.focus({ preventScroll: true });
      }
    }
  }

  function syncMultiSelectPickerAnchor(): boolean {
    const picker = multiSelectPicker;
    if (!picker) return false;
    const anchor = choiceButtonForCell(picker.rowId, picker.fieldId);
    if (!anchor) {
      closeMultiSelectPicker();
      return false;
    }
    if (picker.anchor !== anchor) {
      picker.anchor.setAttribute("aria-expanded", "false");
      picker.anchor.removeAttribute("aria-controls");
      picker.anchor = anchor;
    }
    anchor.id = picker.triggerId;
    anchor.setAttribute("aria-haspopup", "menu");
    anchor.setAttribute("aria-expanded", "true");
    anchor.setAttribute("aria-controls", picker.panel.id);
    picker.position();
    return true;
  }

  function scheduleProxyUpdate(): void {
    if (proxyFrame !== null) return;
    proxyFrame = viewportWindow.requestAnimationFrame(() => { proxyFrame = null; updateProxy(); });
  }

  function bindViewportScrollElement(element: HTMLElement | null): void {
    if (viewportScrollElement === element) return;
    viewportScrollElement?.removeEventListener("scroll", scheduleProxyUpdate);
    viewportScrollElement = element;
    viewportScrollElement?.addEventListener("scroll", scheduleProxyUpdate, { passive: true });
  }

  function visibleScrollBounds(wrap: HTMLElement): { top: number; right: number; bottom: number; left: number } {
    let container: HTMLElement | null = wrap.parentElement;
    while (container && container !== root.ownerDocument.body && container !== root.ownerDocument.documentElement) {
      const overflowY = viewportWindow?.getComputedStyle(container).overflowY ?? "";
      if (/(auto|scroll|overlay)/.test(overflowY) && container.scrollHeight > container.clientHeight + 1) break;
      container = container.parentElement;
    }
    if (container && container !== root.ownerDocument.body && container !== root.ownerDocument.documentElement) {
      bindViewportScrollElement(container);
      const rect = container.getBoundingClientRect();
      const left = rect.left + container.clientLeft;
      const top = rect.top + container.clientTop;
      return { left, top, right: left + container.clientWidth, bottom: top + container.clientHeight };
    }
    bindViewportScrollElement(null);
    const visual = viewportWindow?.visualViewport;
    const left = visual?.offsetLeft ?? 0;
    const top = visual?.offsetTop ?? 0;
    const width = visual?.width || root.ownerDocument.documentElement.clientWidth || viewportWindow?.innerWidth || 0;
    const height = visual?.height || root.ownerDocument.documentElement.clientHeight || viewportWindow?.innerHeight || 0;
    return { left, top, right: left + width, bottom: top + height };
  }

  function isRowVisibleInViewport(row: HTMLTableRowElement): boolean {
    const wrap = row.closest<HTMLElement>(".tb-table-scroll");
    if (!wrap) return false;
    const rowBounds = row.getBoundingClientRect();
    const viewportBounds = visibleScrollBounds(wrap);
    return rowBounds.top >= viewportBounds.top && rowBounds.bottom <= viewportBounds.bottom;
  }

  function syncProxyValue(wrap: HTMLElement): void {
    const max = Math.max(0, wrap.scrollWidth - wrap.clientWidth);
    scrollProxy.setAttribute("aria-valuemin", "0");
    scrollProxy.setAttribute("aria-valuemax", String(Math.round(max)));
    scrollProxy.setAttribute("aria-valuenow", String(Math.round(wrap.scrollLeft)));
  }

  function updateProxy(): void {
    const wrap = root.querySelector<HTMLElement>(".tb-table-scroll");
    if (destroyed || !root.isConnected || !wrap || wrap.scrollWidth <= wrap.clientWidth + 1) {
      scrollProxy.hidden = true; return;
    }
    const bounds = visibleScrollBounds(wrap);
    const rect = wrap.getBoundingClientRect();
    if (rect.top >= bounds.bottom || rect.bottom <= bounds.top || rect.bottom <= bounds.bottom + 1) {
      scrollProxy.hidden = true; return;
    }
    const left = Math.max(rect.left + wrap.clientLeft, bounds.left);
    const right = Math.min(rect.left + wrap.clientLeft + wrap.clientWidth, bounds.right);
    if (right - left < 40) { scrollProxy.hidden = true; return; }
    scrollProxy.id = `${scrollRegionId}-proxy`;
    scrollProxy.setAttribute("aria-controls", scrollRegionId);
    scrollProxy.style.left = `${left}px`; scrollProxy.style.width = `${right - left}px`;
    scrollProxy.hidden = false;
    const proxyHeight = scrollProxy.getBoundingClientRect().height || 16;
    scrollProxy.style.top = `${Math.max(bounds.top, bounds.bottom - proxyHeight)}px`;
    const proxyWidth = scrollProxy.clientWidth || right - left;
    scrollSpacer.style.width = `${Math.max(proxyWidth, wrap.scrollWidth - wrap.clientWidth + proxyWidth)}px`;
    if (scrollProxy.scrollLeft !== wrap.scrollLeft) scrollProxy.scrollLeft = wrap.scrollLeft;
    syncProxyValue(wrap);
  }

  function onProxyScroll(): void {
    const wrap = root.querySelector<HTMLElement>(".tb-table-scroll");
    if (!wrap) return;
    if (wrap.scrollLeft !== scrollProxy.scrollLeft) wrap.scrollLeft = scrollProxy.scrollLeft;
    syncProxyValue(wrap);
  }

  function onRootScroll(event: Event): void {
    const wrap = root.querySelector<HTMLElement>(".tb-table-scroll");
    if (event.target !== wrap || !wrap) return;
    if (scrollProxy.scrollLeft !== wrap.scrollLeft) scrollProxy.scrollLeft = wrap.scrollLeft;
    syncProxyValue(wrap); scheduleProxyUpdate();
  }

  scrollProxy.addEventListener("scroll", onProxyScroll, { passive: true });
  root.addEventListener("scroll", onRootScroll, true);
  viewportWindow?.addEventListener("scroll", scheduleProxyUpdate, { passive: true });
  viewportWindow?.addEventListener("resize", scheduleProxyUpdate, { passive: true });
  viewportWindow?.visualViewport?.addEventListener("scroll", scheduleProxyUpdate, { passive: true });
  viewportWindow?.visualViewport?.addEventListener("resize", scheduleProxyUpdate, { passive: true });

  function clearActiveHeader(): void {
    if (editingHeaderId) {
      const editingName = [...root.querySelectorAll<HTMLTextAreaElement>(".tb-field-name")]
        .find((input) => input.dataset.focusKey === `header:${editingHeaderId}`);
      if (editingName) editingName.readOnly = true;
    }
    editingHeaderId = undefined;
    activeHeaderId = undefined;
    root.querySelectorAll(".tb-header-cell.is-header-active").forEach((header) => header.classList.remove("is-header-active"));
  }

  function clearActiveCell(): void {
    if (activeCellElement) {
      activeCellElement.classList.remove("is-cell-active");
      clearCellActions(activeCellElement);
    }
    activeCellElement = null;
    activeCell = undefined;
    activeCellByTable.delete(tableKey);
  }

  function clearActiveCellAppearance(): void {
    activeCellElement?.classList.remove("is-cell-active");
  }

  function activateHeader(fieldId: string, header: HTMLTableCellElement): void {
    clearActiveCell();
    if (activeHeaderId !== fieldId) clearActiveHeader();
    activeHeaderId = fieldId;
    header.classList.add("is-header-active");
  }

  function editHeaderName(fieldId: string, header: HTMLTableCellElement, name: HTMLTextAreaElement): void {
    activateHeader(fieldId, header);
    editingHeaderId = fieldId;
    name.readOnly = false;
    name.focus({ preventScroll: true });
  }

  function activateCell(cell: HTMLTableCellElement): void {
    clearActiveHeader();
    if (activeCellElement === cell) { ensureCellActions(cell); return; }
    if (activeCellElement) {
      activeCellElement.classList.remove("is-cell-active");
      clearCellActions(activeCellElement);
    }
    activeCell = { rowId: cell.parentElement!.dataset.rowId!, fieldId: cell.dataset.fieldId! };
    activeCellByTable.set(tableKey, activeCell);
    activeCellElement = cell; cell.classList.add("is-cell-active"); ensureCellActions(cell);
  }

  function restoreActiveCell(): void {
    activeCellElement = activeCell ? [...root.querySelectorAll<HTMLTableCellElement>("td.tb-cell")]
      .find((cell) => cell.dataset.fieldId === activeCell!.fieldId && cell.parentElement?.dataset.rowId === activeCell!.rowId) ?? null : null;
    const pickerOwnsCell = !!activeCell && multiSelectPicker?.rowId === activeCell.rowId && multiSelectPicker.fieldId === activeCell.fieldId;
    const pickerHasFocus = pickerOwnsCell && !!multiSelectPicker?.panel.contains(root.ownerDocument.activeElement);
    if (pickerOwnsCell && !activeCellElement) closeMultiSelectPicker();
    if (activeCellElement && (activeCellElement.contains(root.ownerDocument.activeElement) || pickerHasFocus)) {
      activeCellElement.classList.add("is-cell-active"); ensureCellActions(activeCellElement);
      if (pickerHasFocus) syncMultiSelectPickerAnchor();
    } else clearActiveCell();
  }

  function requestReadingViewFocus(): void {
    const doc = root.ownerDocument;
    const win = doc.defaultView;
    if (!win) return;
    const pending = pendingTableFocus.get(doc) ?? new Map<string, PendingTableFocus>();
    pendingTableFocus.set(doc, pending);
    const request = { cell: activeCell ? { ...activeCell } : undefined };
    pending.set(tableKey, request);
    const deadline = Date.now() + 1500;
    const restore = () => {
      if (pending.get(tableKey) !== request) return;
      const view = plugin.app.workspace?.getActiveViewOfType?.(MarkdownView);
      if (Date.now() >= deadline || view?.file?.path !== context.sourcePath) { pending.delete(tableKey); return; }
      // Reading view can rebuild the block more than once for a single save.
      // Follow the latest controller briefly, until the host finishes replacing DOM.
      const replacement = [...view.containerEl.querySelectorAll<HTMLElement>(".markdown-preview-view .tablebase-root[data-table-id]")]
        .find((candidate) => candidate.dataset.tableId === table.tableId);
      const focused = doc.activeElement;
      if (replacement && (focused === doc.body || focused === doc.documentElement || focused?.contains(replacement))) {
        const cell = request.cell && [...replacement.querySelectorAll<HTMLElement>("td.tb-cell")]
          .find((candidate) => candidate.dataset.fieldId === request.cell!.fieldId && candidate.parentElement?.dataset.rowId === request.cell!.rowId);
        (cell || replacement).focus({ preventScroll: true });
      }
      win.requestAnimationFrame(restore);
    };
    win.requestAnimationFrame(restore);
  }

  async function commit(change: (next: TableDocument) => void, cell?: { rowId: string; fieldId: string }, unchanged?: (before: TableDocument, after: TableDocument) => boolean, keepAttachmentPanel = false): Promise<boolean> {
    const restoreTableFocus = root.contains(root.ownerDocument.activeElement);
    if (!context.save && restoreTableFocus) requestReadingViewFocus();
    const operation = saveQueue.then(async () => {
      if (destroyed) return false;
      const activeViewIdBefore = activeViewId;
      const next = JSON.parse(JSON.stringify(table)) as TableDocument;
      change(next);
      if (unchanged?.(table, next)) return true;
      const beforeView = table.views.find((item) => item.id === activeViewIdBefore);
      const beforeGroupLayout = beforeView ? groupLayoutSnapshot(table, beforeView) : null;
      const afterView = next.views.find((item) => item.id === activeViewId);
      const afterGroupLayout = afterView ? groupLayoutSnapshot(next, afterView) : null;
      const groupLayoutChanged = beforeGroupLayout !== afterGroupLayout;
      const filtersChanged = JSON.stringify(beforeView?.filters) !== JSON.stringify(afterView?.filters);
      const historyEditor = context.save ? context.editorView ?? livePreviewEditorView(root) : null;
      const documentBeforeSave = historyEditor?.state.doc.toString();
      const viewportRestoration = preserveNoteViewportScroll(plugin.app, context.sourcePath, root, activeCellElement, !!context.save, {
        editorView: historyEditor ?? undefined,
        anchorToTableHeader: groupLayoutChanged,
        preserveScrollPosition: filtersChanged,
      });
      const attachmentPanelState = () => {
        const row = cell ? rowElementsById.get(cell.rowId) : undefined;
        const target = row && [...row.querySelectorAll<HTMLTableCellElement>("td[data-field-id]")]
          .find((td) => td.dataset.fieldId === cell!.fieldId);
        return keepAttachmentPanel && target ? attachmentCells.get(target)?.panelState() : null;
      };
      const restoreAttachmentPanel = (state: ReturnType<typeof attachmentPanelState>) => {
        if (!state || destroyed || !cell) return;
        const target = [...root.querySelectorAll<HTMLTableCellElement>("td.tb-cell")]
          .find((td) => td.dataset.fieldId === cell.fieldId && td.parentElement?.dataset.rowId === cell.rowId);
        if (!target || !attachmentCells.has(target)) return;
        activateCell(target);
        attachmentCells.get(target)!.open(state);
      };
      try {
        const body = context.save ? await context.save(expectedBody, next)
          : await persistTable(plugin, context.sourcePath, table.tableId, expectedBody, next, root, expectedBody ? undefined : context.emptySection?.());
        if (historyEditor && documentBeforeSave !== undefined) {
          recordLivePreviewTableWrite(context.sourcePath, documentBeforeSave, historyEditor.state.doc.toString());
        }
        // Capture just before replacing cells so dismissal during an async save stays dismissed.
        const panelState = attachmentPanelState();
        table = next; expectedBody = body;
        if (destroyed) return true;
        const view = currentView();
        const existingRow = cell ? rowElementsById.get(cell.rowId) : undefined;
        const existing = existingRow && [...existingRow.querySelectorAll<HTMLTableCellElement>("td[data-field-id]")].find((td) => td.dataset.fieldId === cell!.fieldId);
        if (existing && !viewUsesFieldForProjection(view, cell!.fieldId)) {
          const row = table.records.find((item) => item.id === cell!.rowId);
          const field = table.fields.find((item) => item.id === cell!.fieldId);
          if (row && field) {
            const focused = root.ownerDocument.activeElement as HTMLElement | null;
            const focusKey = focused && existing.contains(focused) ? focused.dataset.focusKey : undefined;
            const selection = focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement && focused.type === "text"
              ? [focused.selectionStart, focused.selectionEnd] as const : null;
            const updatedCell = renderCell(row, field);
            releaseMarkdownCell(existing);
            attachmentCells.get(existing)?.destroy(); attachmentCells.delete(existing);
            existing.replaceWith(updatedCell);
            if (activeCell?.rowId === cell!.rowId && activeCell.fieldId === cell!.fieldId) {
              activeCellElement = updatedCell;
              const nextFocus = focusKey
                ? (updatedCell.dataset.focusKey === focusKey ? updatedCell : [...updatedCell.querySelectorAll<HTMLElement>("[data-focus-key]")].find((element) => element.dataset.focusKey === focusKey))
                : undefined;
              nextFocus?.focus({ preventScroll: true });
              if (nextFocus && selection && selection[0] !== null && selection[1] !== null) {
                try { (nextFocus as HTMLInputElement | HTMLTextAreaElement).setSelectionRange(selection[0], selection[1]); } catch { /* Native date/number inputs have no text selection. */ }
              }
              const pickerHasFocus = multiSelectPicker?.rowId === cell!.rowId && multiSelectPicker.fieldId === cell!.fieldId &&
                multiSelectPicker.panel.contains(root.ownerDocument.activeElement);
              if (updatedCell.contains(root.ownerDocument.activeElement) || pickerHasFocus) {
                updatedCell.classList.add("is-cell-active"); ensureCellActions(updatedCell);
                if (pickerHasFocus) syncMultiSelectPickerAnchor();
              } else clearActiveCell();
            }
          }
          scheduleLayout(existingRow);
        } else {
          render();
          if (restoreTableFocus && !root.contains(root.ownerDocument.activeElement)) root.focus({ preventScroll: true });
        }
        restoreAttachmentPanel(panelState);
        refreshSearch(); paintSearch();
        return true;
      } catch (error) {
        const panelState = attachmentPanelState();
        showSaveError(error); render(); restoreAttachmentPanel(panelState); return false;
      }
      finally { viewportRestoration?.finish(); }
    });
    saveQueue = operation.catch(report);
    return await operation;
  }

  let layoutFrame: number | null = null;
  let layoutResizeSuppressionFrame: number | null = null;
  let suppressNextLayoutResize = false;
  let pendingLayoutRows: Set<HTMLTableRowElement> | null = new Set();
  function armLayoutResizeSuppression(): void {
    suppressNextLayoutResize = true;
    if (layoutResizeSuppressionFrame !== null) viewportWindow.cancelAnimationFrame(layoutResizeSuppressionFrame);
    layoutResizeSuppressionFrame = viewportWindow.requestAnimationFrame(() => {
      layoutResizeSuppressionFrame = null;
      suppressNextLayoutResize = false;
    });
  }
  function consumeLayoutResizeSuppression(): boolean {
    if (!suppressNextLayoutResize) return false;
    suppressNextLayoutResize = false;
    if (layoutResizeSuppressionFrame !== null) viewportWindow.cancelAnimationFrame(layoutResizeSuppressionFrame);
    layoutResizeSuppressionFrame = null;
    return true;
  }
  function scheduleLayout(row?: HTMLTableRowElement): void {
    if (row) {
      if (pendingLayoutRows) pendingLayoutRows.add(row);
    } else pendingLayoutRows = null;
    if (layoutFrame !== null) return;
    layoutFrame = viewportWindow.requestAnimationFrame(() => {
      layoutFrame = null;
      if (destroyed || !root.isConnected) return;
      const rows = pendingLayoutRows;
      pendingLayoutRows = new Set();
      const inputs = rows === null
        ? [...root.querySelectorAll<HTMLTextAreaElement>("textarea.tb-auto-height")]
        : [...rows].filter((item) => root.contains(item)).flatMap((item) => [...item.querySelectorAll<HTMLTextAreaElement>("textarea.tb-auto-height")]);
      // Release every previous row-height adjustment before measuring, so rows can shrink too.
      inputs.forEach((input) => {
        input.setCssStyles({ height: "auto" });
        input.style.removeProperty("--tb-cell-extra-space");
      });
      // Read natural textarea and row heights together before writing final sizes.
      // This avoids an intermediate write/read layout flush for every full-table pass.
      const measurements = inputs.map((input) => ({
        naturalHeight: input.scrollHeight,
        rowHeight: input.closest("td")?.clientHeight ?? 0,
      }));
      inputs.forEach((input, index) => {
        const { naturalHeight, rowHeight } = measurements[index];
        const height = Math.max(naturalHeight, rowHeight);
        input.style.height = `${height}px`;
        if (rowHeight) input.style.setProperty("--tb-cell-extra-space", `${height - naturalHeight}px`);
      });
      if (inputs.length) armLayoutResizeSuppression();
      context.onLayout?.();
    });
  }

  function toolbarButton(parent: HTMLElement, label: string, glyph: string, action: (event: MouseEvent) => unknown, active = false): HTMLButtonElement {
    const item = control(label, glyph, active ? "is-active" : "");
    // The visible label already names the button; aria-labelledby avoids Obsidian's aria-label hover tooltip.
    const labelElement = item.querySelector<HTMLElement>(":scope > span:not(.tb-control-icon)");
    if (labelElement) {
      labelElement.id = makeId("tb-button-label");
      item.setAttribute("aria-labelledby", labelElement.id);
    }
    item.removeAttribute("aria-label");
    item.onclick = (event) => { void action(event); };
    parent.append(item); return item;
  }

  function captureSearchFocus(): void {
    const input = root.querySelector<HTMLInputElement>(".tb-search-input");
    if (search.open && input && root.ownerDocument.activeElement === input) {
      search.focus = { start: input.selectionStart, end: input.selectionEnd };
    }
  }

  function refreshSearch(): void {
    if (search.viewId !== currentView().id) {
      search.viewId = currentView().id; search.query = ""; search.current = undefined;
      search.expanded.clear(); delete search.focus;
    }
    searchMatches = search.open ? findCells(projection().rows, visibleFields(table, currentView()), search.query) : [];
    search.current = searchMatches.find((match) => match.rowId === search.current?.rowId && match.fieldId === search.current.fieldId) ?? searchMatches[0];
  }

  function expandSearchGroup(): void {
    const group = projection().groups?.find((item) => item.rows.some((row) => row.id === search.current?.rowId));
    if (group) search.expanded.add(`${currentView().id}:${currentView().group?.fieldId}:${group.key}`);
  }

  function paintSearch(): void {
    highlightedSearchCells.forEach((cell) => cell.classList.remove("is-search-match", "is-search-current"));
    highlightedSearchCells.clear();
    if (!search.open) return;
    const matches = new Map<string, Set<string>>();
    for (const match of searchMatches) {
      const fields = matches.get(match.rowId) ?? new Set<string>(); fields.add(match.fieldId); matches.set(match.rowId, fields);
    }
    for (const cell of root.querySelectorAll<HTMLTableCellElement>("td.tb-cell")) {
      const rowId = cell.parentElement?.dataset.rowId;
      cell.classList.toggle("is-search-match", !!rowId && !!matches.get(rowId)?.has(cell.dataset.fieldId!));
      cell.classList.toggle("is-search-current", !!search.current && rowId === search.current.rowId && cell.dataset.fieldId === search.current.fieldId);
      if (cell.classList.contains("is-search-match")) highlightedSearchCells.add(cell);
    }
    const status = root.querySelector<HTMLElement>(".tb-search-status");
    if (status) status.textContent = !search.query ? "" : !searchMatches.length ? t("No matches in this view")
      : t("{current} / {total} cells", { current: searchMatches.findIndex((match) => match === search.current) + 1, total: searchMatches.length });
    root.querySelectorAll<HTMLButtonElement>(".tb-search-previous, .tb-search-next").forEach((button) => { button.disabled = !searchMatches.length; });
  }

  let stopSearchReveal: (() => void) | undefined;
  function revealSearchMatch(): void {
    if (searchFrame !== null) viewportWindow.cancelAnimationFrame(searchFrame);
    searchFrame = viewportWindow.requestAnimationFrame(() => {
      searchFrame = null;
      if (destroyed || !root.isConnected || !search.current) return;
      const cell = root.querySelector<HTMLElement>(".is-search-current");
      if (!cell) return;
      const toolbar = root.querySelector<HTMLElement>(".tb-toolbar");
      cell.style.scrollMarginTop = `${(toolbar?.getBoundingClientRect().height ?? 0) + 16}px`;
      stopSearchReveal?.();
      const view = plugin.app.workspace?.getActiveViewOfType?.(MarkdownView);
      stopSearchReveal = followViewportTarget(root, view?.containerEl ?? root, () => {
        root.querySelector<HTMLElement>(".is-search-current")?.scrollIntoView?.({ block: "nearest", inline: "nearest", behavior: "instant" });
      });
    });
  }

  function updateSearch(move = 0): void {
    refreshSearch();
    if (move && searchMatches.length) {
      const index = searchMatches.indexOf(search.current!);
      search.current = searchMatches[(index + move + searchMatches.length) % searchMatches.length];
      refreshSearch();
    }
    expandSearchGroup();
    if (search.current && !rowElementsById.has(search.current.rowId)) render();
    else paintSearch();
    revealSearchMatch();
  }

  function closeSearch(): void {
    stopSearchReveal?.();
    search.open = false; search.query = ""; search.current = undefined; search.expanded.clear(); delete search.focus;
    render(); root.querySelector<HTMLButtonElement>(".tb-search-toggle")?.focus({ preventScroll: true });
  }

  function renderSearchBar(toolbar: HTMLElement): void {
    const bar = el("div", "tb-search-bar tb-ui-surface");
    bar.setAttribute("role", "search");
    const input = el("input", "tb-search-input"); input.type = "text"; input.value = search.query;
    input.dataset.focusKey = "table-search"; input.placeholder = t("Search cells…");
    const label = hiddenAccessibleLabel(t("Search current view")); input.setAttribute("aria-labelledby", label.id);
    bar.setAttribute("aria-labelledby", label.id);
    input.onfocus = captureSearchFocus;
    input.onblur = () => { if (input.isConnected) delete search.focus; };
    input.oninput = (event) => {
      search.query = input.value; search.current = undefined; captureSearchFocus();
      if (!("isComposing" in event && event.isComposing)) updateSearch();
    };
    input.addEventListener("compositionend", () => { search.query = input.value; search.current = undefined; captureSearchFocus(); updateSearch(); });
    const status = el("span", "tb-search-status"); status.setAttribute("role", "status"); status.setAttribute("aria-live", "polite");
    const actions = el("div", "tb-search-actions");
    const searchButton = (name: Parameters<typeof t>[0], glyph: string, className: string, action: () => void) => {
      const button = control("", glyph, `tb-icon-button ${className}`);
      const nameLabel = hiddenAccessibleLabel(t(name)); button.removeAttribute("aria-label"); button.setAttribute("aria-labelledby", nameLabel.id);
      button.onclick = action; actions.append(nameLabel, button);
    };
    searchButton("Previous match", "arrow-up", "tb-search-previous", () => updateSearch(-1));
    searchButton("Next match", "arrow-down", "tb-search-next", () => updateSearch(1));
    searchButton("Close search", "x", "tb-search-close", closeSearch);
    bar.onkeydown = (event) => {
      if (event.isComposing) return;
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeSearch(); }
      else if (event.key === "Enter" && event.target === input) {
        event.preventDefault(); event.stopPropagation(); updateSearch(event.shiftKey ? -1 : 1);
      }
    };
    bar.append(label, input, el("span", "tb-search-scope", t("Current view")), status, actions); toolbar.append(bar);
  }

  function render(): void {
    if (destroyed) return;
    captureSearchFocus();
    if (groupPanelOpen) openGroupConfigPopovers.get(tableKey)?.close(false, true);
    closeLinkEditors();
    disposeTextEditors();
    attachmentCells.forEach((entry) => entry.destroy()); attachmentCells.clear();
    clearMarkdownCells();
    prepareMarkdownObserver();
    const oldScroll = root.querySelector<HTMLElement>(".tb-table-scroll");
    const scroll = { left: oldScroll?.scrollLeft ?? 0, top: oldScroll?.scrollTop ?? 0 };
    const focused = root.ownerDocument.activeElement as HTMLElement | null;
    const focusKey = focused && root.contains(focused) ? focused.dataset.focusKey : undefined;
    const selection = focused instanceof HTMLTextAreaElement || focused instanceof HTMLInputElement && focused.type === "text"
      ? [focused.selectionStart, focused.selectionEnd] as const : null;
    rowElementsById.clear();
    root.replaceChildren();
    activeCellElement = null;
    const view = currentView();
    refreshSearch();
    const activeFilters = activeFilterConditions(table.fields, view.filters);
    const activeFilterFieldIds = new Set(activeFilters.map((rule) => rule.fieldId));
    rememberView(plugin.app, tableKey, view.id);
    const shell = el("div", "tb-shell");
    const toolbar = el("div", "tb-toolbar");
    const viewButton = el("button", "tb-button tb-view-menu-button");
    viewButton.type = "button";
    viewButton.setAttribute("aria-haspopup", "menu");
    const viewName = el("span", "tb-view-name", view.name);
    viewName.id = makeId("tb-view-name");
    viewButton.setAttribute("aria-labelledby", viewName.id);
    viewButton.append(icon("table", "tb-control-icon tb-view-type-icon"), viewName, icon("ellipsis", "tb-control-icon tb-view-menu-icon"));
    viewButton.onclick = (event) => openViewMenu(viewButton, event);
    toolbar.append(viewButton);
    const displayConfiguration = toolbarButton(toolbar, t("Display configuration"), "eye", () => openDisplayConfig(displayConfiguration));
    displayConfiguration.classList.add("tb-display-config-trigger");
    displayConfiguration.setAttribute("aria-haspopup", "dialog");
    const openDisplayConfigPopover = openDisplayConfigPopovers.get(tableKey);
    displayConfiguration.setAttribute("aria-expanded", String(!!openDisplayConfigPopover));
    if (openDisplayConfigPopover) displayConfiguration.setAttribute("aria-controls", openDisplayConfigPopover.id);
    toolbarButton(toolbar, t("Row"), "plus", () => insertRow(table.records.length, undefined, { reveal: true, warnIfHidden: true }));
    const column = toolbarButton(toolbar, t("Column"), "columns-3", (event) => openTypeMenu(column, event, table.fields.length));
    const filterLabel = activeFilters.length ? t("Filter · {count} conditions", { count: activeFilters.length }) : t("Filter");
    const filterButton = toolbarButton(toolbar, filterLabel, "filter", () => toggleFilterPopover(tableKey, view.id, filterButton), activeFilters.length > 0);
    filterButton.classList.add("tb-filter-toggle");
    filterButton.setAttribute("aria-haspopup", "dialog");
    filterButton.setAttribute("aria-expanded", "false");
    const groupButton = toolbarButton(toolbar, t("Group"), "list-tree", () => {
      const openPopover = openGroupConfigPopovers.get(tableKey);
      if (openPopover) openPopover.close(); else openGroupConfig(groupButton);
    }, groupPanelOpen || !!view.group);
    groupButton.classList.add("tb-group-toggle");
    groupButton.setAttribute("aria-haspopup", "dialog");
    groupButton.setAttribute("aria-expanded", "false");
    const openGroupPopover = openGroupConfigPopovers.get(tableKey);
    if (openGroupPopover) {
      groupButton.setAttribute("aria-expanded", "true");
      groupButton.setAttribute("aria-controls", openGroupPopover.panelId);
    }
    const searchButton = toolbarButton(toolbar, t("Search"), "search", () => {
      if (search.open) { closeSearch(); return; }
      search.open = true; render(); root.querySelector<HTMLInputElement>(".tb-search-input")?.focus({ preventScroll: true });
    }, search.open);
    searchButton.classList.add("tb-search-toggle"); searchButton.setAttribute("aria-expanded", String(search.open));
    const exportButton = toolbarButton(toolbar, t("Export"), "file-output", (event) => openExportMenu(exportButton, event));
    exportButton.setAttribute("aria-haspopup", "menu");
    if (rowClipboard?.rows.length) toolbarButton(toolbar, t(rowClipboard.rows.length === 1 ? "Paste {count} row" : "Paste {count} rows", { count: rowClipboard.rows.length }), "clipboard-paste", () => pasteInternal(false));
    toolbarButton(toolbar, t("Select"), "check-square", () => {
      selectionMode = !selectionMode; if (!selectionMode) selectedRows.clear(); render();
      const wrap = root.querySelector<HTMLElement>(".tb-table-scroll");
      if (wrap) wrap.scrollLeft = Math.max(0, scroll.left + (selectionMode ? 42 : -42));
    }, selectionMode);
    const count = projection().rows.length;
    toolbar.append(el("span", "tb-count", t("{visible} of {total}", { visible: count, total: table.records.length })));
    if (search.open) renderSearchBar(toolbar);
    shell.append(toolbar);
    if (selectionMode) shell.append(renderSelectionBar());
    const wrap = el("div", "tb-table-scroll"); wrap.id = scrollRegionId; wrap.append(renderGrid(activeFilterFieldIds)); shell.append(wrap); root.append(shell);
    if (observedScrollWrap) proxyResizeObserver?.unobserve(observedScrollWrap);
    if (observedGrid) proxyResizeObserver?.unobserve(observedGrid);
    observedScrollWrap = wrap; observedGrid = wrap.querySelector<HTMLElement>(".tb-grid");
    proxyResizeObserver?.observe(wrap); if (observedGrid) proxyResizeObserver?.observe(observedGrid);
    wrap.scrollLeft = scroll.left; wrap.scrollTop = scroll.top;
    if (focusKey) {
      const nextFocus = [...root.querySelectorAll<HTMLElement>("[data-focus-key]")].find((element) => element.dataset.focusKey === focusKey);
      nextFocus?.focus({ preventScroll: true });
      if (nextFocus && selection && selection[0] !== null && selection[1] !== null) {
        try { (nextFocus as HTMLInputElement | HTMLTextAreaElement).setSelectionRange(selection[0], selection[1]); } catch { /* Native date/number inputs have no text selection. */ }
      }
    }
    restoreActiveCell();
    paintSearch();
    if (search.open && search.focus) {
      const input = root.querySelector<HTMLInputElement>(".tb-search-input");
      const focus = search.focus;
      input?.focus({ preventScroll: true }); input?.setSelectionRange(focus.start, focus.end);
    }
    if (groupPanelOpen) openGroupConfig(groupButton);
    scheduleLayout();
    scheduleProxyUpdate();
    openDisplayConfigPopovers.get(tableKey)?.refresh();
    refreshFilterPopover(tableKey);
  }

  function openDisplayConfig(trigger: HTMLButtonElement): void {
    const existing = openDisplayConfigPopovers.get(tableKey);
    if (existing) { existing.close(); return; }
    const viewId = currentView().id;
    const id = makeId("tb-display-config");
    class DisplayConfigPopover {
      panel = el("div", "tb-dialog tb-ui-surface tb-display-config tb-display-config-popover");
      list = el("div", "tb-display-field-list");
      pointerDragCleanup: (() => void) | null = null;
      closed = false;

      currentTrigger(): HTMLButtonElement | null {
        return displayConfigSessions.get(tableKey)?.trigger() ?? (trigger.isConnected ? trigger : null);
      }

      onOpen(): void {
        const document = trigger.ownerDocument;
        this.panel.id = id;
        this.panel.tabIndex = -1;
        this.panel.setAttribute("role", "dialog");
        const heading = el("h2", "tb-display-config-title", t("Display configuration"));
        heading.id = makeId("tb-display-config-title");
        this.panel.setAttribute("aria-labelledby", heading.id);
        const close = control("", "x", "tb-icon-button tb-display-config-close");
        const closeLabel = hiddenAccessibleLabel(t("Close display configuration"));
        close.setAttribute("aria-labelledby", closeLabel.id);
        close.append(closeLabel);
        close.onclick = () => this.close(true);
        const header = el("div", "tb-display-config-header");
        header.append(heading, close);
        this.list.setAttribute("role", "list");
        this.panel.append(header, this.list);
        document.body.append(this.panel);
        openDisplayConfigPopovers.set(tableKey, {
          id,
          close: (restoreFocus) => this.close(restoreFocus),
          refresh: () => this.drawList(),
        });
        this.currentTrigger()?.setAttribute("aria-expanded", "true");
        this.currentTrigger()?.setAttribute("aria-controls", id);
        document.addEventListener("pointerdown", this.onOutsidePointerDown, true);
        document.addEventListener("keydown", this.onDocumentKeyDown, true);
        document.defaultView?.addEventListener("resize", this.position);
        document.defaultView?.addEventListener("scroll", this.position, true);
        document.defaultView?.visualViewport?.addEventListener("resize", this.position);
        document.defaultView?.visualViewport?.addEventListener("scroll", this.position);
        this.drawList();
        this.panel.focus({ preventScroll: true });
      }

      close(restoreFocus = false): void {
        if (this.closed) return;
        this.closed = true;
        this.pointerDragCleanup?.();
        this.pointerDragCleanup = null;
        const document = this.panel.ownerDocument;
        document.removeEventListener("pointerdown", this.onOutsidePointerDown, true);
        document.removeEventListener("keydown", this.onDocumentKeyDown, true);
        document.defaultView?.removeEventListener("resize", this.position);
        document.defaultView?.removeEventListener("scroll", this.position, true);
        document.defaultView?.visualViewport?.removeEventListener("resize", this.position);
        document.defaultView?.visualViewport?.removeEventListener("scroll", this.position);
        if (openDisplayConfigPopovers.get(tableKey)?.id === id) openDisplayConfigPopovers.delete(tableKey);
        const currentTrigger = this.currentTrigger();
        [trigger, currentTrigger].forEach((item) => {
          item?.setAttribute("aria-expanded", "false");
          item?.removeAttribute("aria-controls");
        });
        this.panel.remove();
        if (restoreFocus) currentTrigger?.focus({ preventScroll: true });
      }

      onOutsidePointerDown = (event: PointerEvent): void => {
        const target = event.target;
        const currentTrigger = this.currentTrigger();
        if (target instanceof Element && (this.panel.contains(target) || currentTrigger?.contains(target))) return;
        this.close();
      };

      onDocumentKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.close(true);
      };

      position = (): void => {
        if (this.closed || !this.panel.isConnected) return;
        const anchor = this.currentTrigger();
        if (!anchor?.isConnected) return;
        const window = this.panel.ownerDocument.defaultView;
        const viewport = window?.visualViewport;
        const viewportWidth = viewport?.width ?? window?.innerWidth ?? this.panel.ownerDocument.documentElement.clientWidth;
        const viewportHeight = viewport?.height ?? window?.innerHeight ?? this.panel.ownerDocument.documentElement.clientHeight;
        const leftEdge = (viewport?.offsetLeft ?? 0) + 16;
        const topEdge = (viewport?.offsetTop ?? 0) + 16;
        const rightEdge = leftEdge + Math.max(0, viewportWidth - 32);
        const bottomEdge = topEdge + Math.max(0, viewportHeight - 32);
        this.panel.style.maxWidth = `${Math.max(0, viewportWidth - 32)}px`;
        this.panel.style.maxHeight = `${Math.max(0, Math.min(700, viewportHeight * .78, viewportHeight - 32))}px`;
        const headerHeight = this.panel.querySelector<HTMLElement>(".tb-display-config-header")?.getBoundingClientRect().height ?? 24;
        // In a very short visual viewport, keep one scroll area instead of squeezing the list away.
        this.panel.classList.toggle("is-height-constrained", viewportHeight - 32 < headerHeight + 34 + 16 + 52);
        const anchorRect = anchor.getBoundingClientRect();
        const width = this.panel.getBoundingClientRect().width;
        const height = this.panel.getBoundingClientRect().height;
        let left = anchorRect.left;
        if (left + width > rightEdge) left = anchorRect.right - width;
        left = Math.max(leftEdge, Math.min(left, rightEdge - width));
        let top = anchorRect.bottom + 8;
        if (top + height > bottomEdge && anchorRect.top - height - 8 >= topEdge) top = anchorRect.top - height - 8;
        top = Math.max(topEdge, Math.min(top, bottomEdge - height));
        this.panel.style.left = `${Math.round(left)}px`;
        this.panel.style.top = `${Math.round(top)}px`;
      };

      drawList(): void {
        const snapshot = displayConfigSessions.get(tableKey)?.snapshot(viewId);
        if (!snapshot) { this.close(); return; }
        const { fields, visibleIds } = snapshot;
        const activeElement = this.panel.ownerDocument.activeElement;
        const focusedControl = activeElement instanceof HTMLElement && this.list.contains(activeElement) ? activeElement : null;
        const focusedFieldId = focusedControl?.closest<HTMLElement>(".tb-display-field-row")?.dataset.fieldId;
        const focusedControlClass = focusedControl?.classList.contains("tb-display-field-drag")
          ? "tb-display-field-drag"
          : focusedControl?.classList.contains("tb-display-field-visibility") ? "tb-display-field-visibility" : null;
        const scrollTop = this.list.scrollTop;
        this.list.replaceChildren();
        fields.forEach((field) => {
          const row = el("div", "tb-display-field-row");
          row.dataset.fieldId = field.id;
          row.setAttribute("role", "listitem");
          const isVisible = visibleIds.has(field.id);
          row.classList.toggle("is-hidden", !isVisible);

          const handle = control("", "grip-vertical", "tb-icon-button tb-display-field-drag");
          handle.removeAttribute("aria-label");
          handle.draggable = window.matchMedia("(pointer: fine)").matches;
          handle.querySelector(".tb-control-icon")?.setAttribute("aria-hidden", "true");
          const reorderLabel = hiddenAccessibleLabel(t("Reorder {name} with arrow keys", { name: field.name }));
          handle.setAttribute("aria-labelledby", reorderLabel.id);
          handle.append(reorderLabel);
          handle.onkeydown = (event) => {
            if (event.key !== "ArrowUp" && event.key !== "ArrowDown") return;
            event.preventDefault();
            const currentFields = displayConfigSessions.get(tableKey)?.snapshot(viewId)?.fields ?? [];
            const index = currentFields.findIndex((item) => item.id === field.id);
            const target = currentFields[index + (event.key === "ArrowUp" ? -1 : 1)];
            if (target) void this.moveField(field.id, target.id, event.key === "ArrowDown");
          };
          this.installNativeDrag(handle, row, field.id);
          this.installPointerDrag(handle, row, field.id);

          const typeIcon = icon(fieldIcon[field.type], "tb-display-field-type");
          typeIcon.setAttribute("aria-hidden", "true");
          const name = el("span", "tb-display-field-name", field.name);
          const visibility = control("", isVisible ? "eye" : "eye-off", "tb-icon-button tb-display-field-visibility");
          visibility.removeAttribute("aria-label");
          visibility.querySelector(".tb-control-icon")?.setAttribute("aria-hidden", "true");
          const visibilityLabel = hiddenAccessibleLabel(t(isVisible ? "Hide {name}" : "Show {name}", { name: field.name }));
          visibility.setAttribute("aria-labelledby", visibilityLabel.id);
          visibility.setAttribute("aria-pressed", String(isVisible));
          visibility.disabled = isVisible && visibleIds.size <= 1;
          visibility.append(visibilityLabel);
          visibility.onclick = () => { void this.toggleField(field.id); };

          row.append(handle, typeIcon, name, visibility);
          this.list.append(row);
        });
        if (focusedFieldId && focusedControlClass) {
          [...this.list.querySelectorAll<HTMLElement>(".tb-display-field-row")]
            .find((row) => row.dataset.fieldId === focusedFieldId)
            ?.querySelector<HTMLElement>(`.${focusedControlClass}`)?.focus({ preventScroll: true });
        }
        this.position();
        this.list.scrollTop = scrollTop;
      }

      installNativeDrag(handle: HTMLElement, row: HTMLElement, fieldId: string): void {
        handle.addEventListener("dragstart", (event) => {
          event.stopPropagation();
          if (!event.dataTransfer) return;
          event.dataTransfer.setData("text/super-table-field", fieldId);
          event.dataTransfer.effectAllowed = "move";
          row.classList.add("tb-dragging");
        });
        handle.addEventListener("dragend", () => {
          row.classList.remove("tb-dragging");
          this.clearDropIndicators();
        });
        row.addEventListener("dragover", (event) => {
          if (!event.dataTransfer?.types.includes("text/super-table-field")) return;
          event.preventDefault();
          this.clearDropIndicators();
          row.classList.add(this.isAfter(event.clientY, row) ? "tb-drop-after" : "tb-drop-before");
        });
        row.addEventListener("dragleave", (event) => {
          if (event.relatedTarget instanceof Node && row.contains(event.relatedTarget)) return;
          row.classList.remove("tb-drop-before", "tb-drop-after");
        });
        row.addEventListener("drop", (event) => {
          const sourceId = event.dataTransfer?.getData("text/super-table-field");
          if (!sourceId) return;
          event.preventDefault();
          const after = this.isAfter(event.clientY, row);
          this.clearDropIndicators();
          void this.moveField(sourceId, fieldId, after);
        });
      }

      installPointerDrag(handle: HTMLElement, sourceRow: HTMLElement, sourceId: string): void {
        handle.addEventListener("pointerdown", (event) => {
          if (event.pointerType === "mouse" || event.button !== 0) return;
          event.preventDefault();
          handle.focus({ preventScroll: true });
          const document = this.panel.ownerDocument;
          const pointerId = event.pointerId;
          const startX = event.clientX;
          const startY = event.clientY;
          let moved = false;
          let targetId: string | null = null;
          let after = false;

          const cleanup = () => {
            document.removeEventListener("pointermove", onMove);
            document.removeEventListener("pointerup", onUp);
            document.removeEventListener("pointercancel", onCancel);
            sourceRow.classList.remove("tb-dragging");
            this.clearDropIndicators();
            if (this.pointerDragCleanup === cleanup) this.pointerDragCleanup = null;
          };
          const onMove = (moveEvent: PointerEvent) => {
            if (moveEvent.pointerId !== pointerId) return;
            if (!moved && Math.hypot(moveEvent.clientX - startX, moveEvent.clientY - startY) < 5) return;
            moved = true;
            moveEvent.preventDefault();
            sourceRow.classList.add("tb-dragging");
            const hit = typeof document.elementFromPoint === "function"
              ? document.elementFromPoint(moveEvent.clientX, moveEvent.clientY)
              : null;
            const targetRow = hit?.closest<HTMLElement>(".tb-display-field-row");
            if (!targetRow || !this.list.contains(targetRow)) {
              targetId = null;
              this.clearDropIndicators();
              return;
            }
            targetId = targetRow.dataset.fieldId ?? null;
            after = this.isAfter(moveEvent.clientY, targetRow);
            this.clearDropIndicators();
            targetRow.classList.add(after ? "tb-drop-after" : "tb-drop-before");
          };
          const onUp = (upEvent: PointerEvent) => {
            if (upEvent.pointerId !== pointerId) return;
            const destination = targetId;
            const insertAfter = after;
            cleanup();
            if (moved && destination && destination !== sourceId) void this.moveField(sourceId, destination, insertAfter);
          };
          const onCancel = (cancelEvent: PointerEvent) => {
            if (cancelEvent.pointerId === pointerId) cleanup();
          };

          this.pointerDragCleanup?.();
          this.pointerDragCleanup = cleanup;
          document.addEventListener("pointermove", onMove);
          document.addEventListener("pointerup", onUp);
          document.addEventListener("pointercancel", onCancel);
        });
      }

      isAfter(clientY: number, row: HTMLElement): boolean {
        const rect = row.getBoundingClientRect();
        return clientY > (rect.top + rect.bottom) / 2;
      }

      clearDropIndicators(): void {
        this.list.querySelectorAll(".tb-drop-before, .tb-drop-after").forEach((element) => element.classList.remove("tb-drop-before", "tb-drop-after"));
      }

      async moveField(sourceId: string, targetId: string, after: boolean): Promise<void> {
        if (sourceId === targetId) return;
        const session = displayConfigSessions.get(tableKey);
        if (!session) { this.close(); return; }
        const saved = await session.moveField(sourceId, targetId, after);
        if (saved && this.panel.isConnected) this.drawList();
      }

      async toggleField(fieldId: string): Promise<void> {
        const session = displayConfigSessions.get(tableKey);
        if (!session) { this.close(); return; }
        const saved = await session.toggleField(viewId, fieldId);
        if (saved && this.panel.isConnected) this.drawList();
      }
    }
    new DisplayConfigPopover().onOpen();
  }

  function openViewMenu(anchor: HTMLElement, event: MouseEvent): void {
    const view = currentView(); const menu = new Menu();
    if (!Platform.isMobile) menu.setUseNativeMenu(false);
    table.views.forEach((item) => menu.addItem((menuItem) => menuItem
      .setTitle(item.name)
      .setIcon("table")
      .setChecked(item.id === view.id)
      .onClick(() => switchView(item.id))));
    menu.addSeparator();
    menuAction(menu, t("Create view"), "plus", async () => {
      const result = await prompt(t("Create view"), [{ label: t("View name"), value: t("New view") }], undefined, { modalClassName: "tb-view-name-modal", hideSingleFieldLabel: true });
      if (!result?.[0].trim()) return;
      const id = makeId("view");
      await commit((next) => { next.views.push({ id, name: result[0].trim(), filters: emptyFilters() }); activeViewId = id; });
    });
    menuAction(menu, t("Duplicate view"), "copy", () => commit((next) => {
      const copy = JSON.parse(JSON.stringify(next.views.find((item) => item.id === view.id))) as TableView;
      copy.id = makeId("view"); copy.name += t(" copy"); next.views.push(copy); activeViewId = copy.id;
    }));
    menuAction(menu, t("Rename view"), "pencil", async () => {
      const result = await prompt(t("Rename view"), [{ label: t("View name"), value: view.name }], undefined, { modalClassName: "tb-view-name-modal", hideSingleFieldLabel: true });
      if (result?.[0].trim()) await commit((next) => { next.views.find((item) => item.id === view.id)!.name = result[0].trim(); });
    });
    if (view.visibleFieldIds) menuAction(menu, t("Show all fields"), "eye", () => commit((next) => { delete next.views.find((item) => item.id === view.id)!.visibleFieldIds; }));
    if (view.filters.conditions.length) menuAction(menu, t("Clear filters"), "filter-x", () => commit((next) => { next.views.find((item) => item.id === view.id)!.filters.conditions = []; }));
    menu.addSeparator();
    menuAction(menu, t("Delete view"), "trash", async () => {
      if (!(await confirm(t("Delete view?"), t("Records will remain in the table."), t("Delete")))) return;
      await commit((next) => {
        next.views = next.views.filter((item) => item.id !== view.id);
        if (next.defaultViewId === view.id) next.defaultViewId = next.views[0].id;
        activeViewId = next.defaultViewId;
      });
    }, table.views.length < 2, true);
    showTableMenu(menu, anchor, event);
  }

  function switchView(viewId: string): void {
    openGroupConfigPopovers.get(tableKey)?.close(false);
    closeFilterPopover(tableKey);
    activeViewId = viewId; selectedRows.clear(); groupPanelOpen = false;
    activeCell = undefined; activeCellByTable.delete(tableKey);
    openGroupsByTable.delete(tableKey); render();
  }

  let projectionTable: TableDocument | undefined;
  let projectionView: TableView | undefined;
  let projectionRows: ReturnType<typeof shownRows>;
  function projection(): ReturnType<typeof shownRows> {
    const view = currentView();
    if (projectionTable !== table || projectionView !== view) {
      projectionTable = table; projectionView = view; projectionRows = shownRows(table, view);
    }
    return projectionRows;
  }

  function selected(): RecordRow[] { return projection().rows.filter((row) => selectedRows.has(row.id)); }

  function renderGroupPanel(panelId: string): HTMLDivElement {
    const panel = el("div", "tablebase-root tb-dialog tb-ui-surface tb-group-panel tb-group-config-popover");
    panel.id = panelId;
    panel.tabIndex = -1;
    panel.setAttribute("role", "dialog");
    const heading = el("h2", "tb-group-panel-title", t("Group"));
    heading.id = makeId("tb-group-title");
    panel.setAttribute("aria-labelledby", heading.id);
    const header = el("div", "tb-group-panel-header");
    const close = control("", "x", "tb-icon-button tb-group-close");
    const closeLabel = hiddenAccessibleLabel(t("Close grouping settings"));
    close.setAttribute("aria-labelledby", closeLabel.id);
    close.append(closeLabel);
    close.onclick = () => openGroupConfigPopovers.get(tableKey)?.close(true);
    header.append(heading, close);

    const viewId = currentView().id;
    const view = table.views.find((item) => item.id === viewId)!;
    const row = el("div", "tb-group-row");

    const selectedField = table.fields.find((field) => field.id === view.group?.fieldId);
    const select = control("", undefined, "tb-group-select");
    select.classList.toggle("is-empty", !selectedField);
    select.removeAttribute("aria-label");
    select.setAttribute("aria-haspopup", "menu");
    select.setAttribute("aria-expanded", "false");
    const selectedLabel = el("span", "tb-group-select-label", selectedField ? selectedField.name || t("Untitled") : t("Group by…"));
    select.append(icon(selectedField ? fieldIcon[selectedField.type] : "list-tree", "tb-group-select-icon"), selectedLabel, icon("chevron-down", "tb-group-select-chevron"));
    const groupMenu = new Menu().setUseNativeMenu(false);
    let selectedDirection: "asc" | "desc" = view.group?.direction ?? "asc";
    const apply = (fieldId: string) => commit((next) => {
      const nextView = next.views.find((item) => item.id === viewId)!;
      nextView.group = { fieldId, direction: selectedDirection };
    });
    table.fields.forEach((field) => groupMenu.addItem((item) => configMenuItem(item, field.name || t("Untitled"), fieldIcon[field.type])
      .setChecked(selectedField?.id === field.id)
      .onClick(() => void apply(field.id))));
    select.onclick = () => {
      select.setAttribute("aria-expanded", "true");
      showTableMenu(groupMenu, select, undefined, () => select.setAttribute("aria-expanded", "false"));
    };

    const direction = el("div", "tb-group-direction");
    const directionButtons = new Map<"asc" | "desc", HTMLButtonElement>();
    const refreshDirectionButtons = () => directionButtons.forEach((button, value) => {
      button.classList.toggle("is-active", selectedDirection === value);
      button.setAttribute("aria-pressed", String(selectedDirection === value));
    });
    const applyDirection = (value: "asc" | "desc") => commit((next) => {
      const nextView = next.views.find((item) => item.id === viewId)!;
      if (nextView.group) nextView.group.direction = value;
    });
    (["asc", "desc"] as const).forEach((value) => {
      const choice = control(value === "asc" ? t("Ascending") : t("Descending"), undefined, "tb-group-dir");
      choice.removeAttribute("aria-label");
      choice.onclick = () => {
        selectedDirection = value;
        refreshDirectionButtons();
        if (view.group) void applyDirection(value);
      };
      directionButtons.set(value, choice);
      direction.append(choice);
    });
    refreshDirectionButtons();

    const clear = control("", "circle-minus", "tb-icon-button tb-group-clear");
    clear.disabled = !view.group;
    const clearLabel = hiddenAccessibleLabel(t("Clear this grouping condition"));
    clear.setAttribute("aria-labelledby", clearLabel.id);
    clear.append(clearLabel);
    clear.onclick = () => {
      if (!view.group) return;
      // Keep the panel open so clearing a condition remains separate from closing the panel.
      void commit((next) => { delete next.views.find((item) => item.id === viewId)!.group; });
    };

    row.append(select, direction, clear);
    panel.append(header, row);
    return panel;
  }

  function openGroupConfig(trigger: HTMLButtonElement): void {
    const existing = openGroupConfigPopovers.get(tableKey);
    if (existing) { existing.close(); return; }
    const id = makeId("tb-group-config");
    class GroupConfigPopover {
      panel = renderGroupPanel(id);
      closed = false;

      currentTrigger(): HTMLButtonElement | null {
        return root.querySelector<HTMLButtonElement>(".tb-group-toggle") ?? (trigger.isConnected ? trigger : null);
      }

      onOpen(): void {
        // Live Preview code blocks may sit inside transformed or clipped ancestors.
        // Keep the fixed popover in the document layer so viewport positioning stays correct.
        root.ownerDocument.body.append(this.panel);
        groupPanelOpen = true;
        openGroupsByTable.add(tableKey);
        openGroupConfigPopovers.set(tableKey, {
          panelId: id,
          close: (restoreFocus, preserveOpenState) => this.close(restoreFocus, preserveOpenState),
          refresh: () => this.refresh(),
        });
        this.currentTrigger()?.classList.add("is-active");
        this.currentTrigger()?.setAttribute("aria-expanded", "true");
        this.currentTrigger()?.setAttribute("aria-controls", id);
        const document = root.ownerDocument;
        document.addEventListener("pointerdown", this.onOutsidePointerDown, true);
        document.addEventListener("keydown", this.onDocumentKeyDown, true);
        document.defaultView?.addEventListener("resize", this.position);
        document.defaultView?.addEventListener("scroll", this.position, true);
        document.defaultView?.visualViewport?.addEventListener("resize", this.position);
        document.defaultView?.visualViewport?.addEventListener("scroll", this.position);
        this.position();
        this.panel.focus({ preventScroll: true });
      }

      close(restoreFocus = false, preserveOpenState = false): void {
        if (this.closed) return;
        this.closed = true;
        const document = root.ownerDocument;
        document.removeEventListener("pointerdown", this.onOutsidePointerDown, true);
        document.removeEventListener("keydown", this.onDocumentKeyDown, true);
        document.defaultView?.removeEventListener("resize", this.position);
        document.defaultView?.removeEventListener("scroll", this.position, true);
        document.defaultView?.visualViewport?.removeEventListener("resize", this.position);
        document.defaultView?.visualViewport?.removeEventListener("scroll", this.position);
        if (openGroupConfigPopovers.get(tableKey)?.panelId === id) openGroupConfigPopovers.delete(tableKey);
        if (!preserveOpenState) {
          groupPanelOpen = false;
          openGroupsByTable.delete(tableKey);
        }
        const currentTrigger = this.currentTrigger();
        [trigger, currentTrigger].forEach((item) => {
          item?.setAttribute("aria-expanded", "false");
          item?.removeAttribute("aria-controls");
        });
        currentTrigger?.classList.toggle("is-active", !!currentView().group);
        this.panel.remove();
        if (restoreFocus) currentTrigger?.focus({ preventScroll: true });
      }

      onOutsidePointerDown = (event: PointerEvent): void => {
        const target = event.target;
        const currentTrigger = this.currentTrigger();
        if (target instanceof Element && (this.panel.contains(target) || currentTrigger?.contains(target) || target.closest(".menu"))) return;
        this.close();
      };

      onDocumentKeyDown = (event: KeyboardEvent): void => {
        if (event.key !== "Escape" || event.defaultPrevented) return;
        const target = event.target;
        if (target instanceof Element && target.closest(".menu")) return;
        event.preventDefault();
        event.stopImmediatePropagation();
        this.close(true);
      };

      position = (): void => {
        if (this.closed || !this.panel.isConnected) return;
        const anchor = this.currentTrigger();
        if (!anchor?.isConnected) return;
        const window = this.panel.ownerDocument.defaultView;
        const viewportWidth = window?.innerWidth ?? this.panel.ownerDocument.documentElement.clientWidth;
        const viewportHeight = window?.innerHeight ?? this.panel.ownerDocument.documentElement.clientHeight;
        const anchorRect = anchor.getBoundingClientRect();
        const width = this.panel.getBoundingClientRect().width || Math.min(920, viewportWidth - 24);
        const height = this.panel.getBoundingClientRect().height || 150;
        let left = anchorRect.left;
        if (left + width > viewportWidth - 8) left = anchorRect.right - width;
        left = Math.max(8, Math.min(left, viewportWidth - width - 8));
        let top = anchorRect.bottom + 8;
        if (top + height > viewportHeight - 8 && anchorRect.top - height - 8 >= 8) top = anchorRect.top - height - 8;
        top = Math.max(8, Math.min(top, viewportHeight - height - 8));
        this.panel.style.left = `${Math.round(left)}px`;
        this.panel.style.top = `${Math.round(top)}px`;
      };

      refresh(): void {
        if (this.closed) return;
        const nextPanel = renderGroupPanel(id);
        this.panel.replaceWith(nextPanel);
        this.panel = nextPanel;
        this.position();
      }
    }
    new GroupConfigPopover().onOpen();
  }
  function renderSelectionBar(): HTMLElement {
    const bar = el("div", "tb-selection-bar"); const rows = selected();
    bar.append(el("span", "tb-selection-count", t("{count} selected", { count: rows.length })));
    const actions: Array<[string, string, () => unknown]> = [
      [t("Duplicate"), "copy", () => commit((next) => rows.forEach((row) => next.records.push({ id: makeId("row"), values: JSON.parse(JSON.stringify(row.values)) as Record<string, CellValue> })))],
      [t("Copy"), "clipboard-copy", () => copyRows(rows)],
      [t("Export"), "download", () => exportCsv("current", rows)],
      [t("Delete"), "trash", () => deleteRows(rows)],
    ];
    actions.forEach(([label, glyph, fn]) => { const item = toolbarButton(bar, label, glyph, fn); item.disabled = !rows.length; });
    toolbarButton(bar, t("Done"), "x", () => { selectionMode = false; selectedRows.clear(); render(); });
    return bar;
  }

  function renderGrid(activeFilterFieldIds: ReadonlySet<string>): HTMLTableElement {
    const grid = el("table", "tb-grid"); const fields = visibleFields(table, currentView());
    grid.style.width = `${fields.reduce((sum, field) => sum + (field.width ?? defaultFieldWidth(field.type)), 0) + 34 + (selectionMode ? 42 : 0)}px`;
    const columns = el("colgroup");
    if (selectionMode) { const col = el("col"); col.setCssStyles({ width: "42px" }); columns.append(col); }
    fields.forEach((field) => { const col = el("col"); col.dataset.fieldId = field.id; col.style.width = `${field.width ?? defaultFieldWidth(field.type)}px`; columns.append(col); });
    const trailing = el("col"); trailing.setCssStyles({ width: "34px" }); columns.append(trailing, el("col", "tb-grid-fill-col")); grid.append(columns);
    const head = el("thead"); const headings = el("tr");
    if (selectionMode) {
      const cell = el("th", "tb-select-cell"); const check = el("input"); check.type = "checkbox";
      const rows = projection().rows; const count = rows.filter((row) => selectedRows.has(row.id)).length;
      check.checked = !!rows.length && count === rows.length; check.indeterminate = count > 0 && count < rows.length;
      check.setAttribute("aria-label", t("Select all visible rows"));
      check.onchange = () => { rows.forEach((row) => check.checked ? selectedRows.add(row.id) : selectedRows.delete(row.id)); render(); };
      cell.append(check); headings.append(cell);
    }
    fields.forEach((field, index) => headings.append(renderHeader(field, index === 0, activeFilterFieldIds.has(field.id))));
    const addCell = el("th", "tb-add-column-cell"); const add = control("", "plus", "tb-icon-button"); add.setAttribute("aria-label", t("Add column"));
    add.onclick = (event) => openTypeMenu(add, event, table.fields.length); addCell.append(add); headings.append(addCell, el("th", "tb-grid-fill-cell")); head.append(headings);
    grid.append(head); const body = el("tbody"); const { rows, groups } = projection();
    const span = fields.length + 2 + Number(selectionMode);
    if (groups) groups.forEach((group) => {
      const line = el("tr", "tb-group-row"); const cell = el("td"); cell.colSpan = span;
      const content = el("div", "tb-group-content");
      const key = `${currentView().id}:${currentView().group?.fieldId}:${group.key}`;
      const isCollapsed = collapsed.has(key) && !search.expanded.has(key);
      const toggle = control("", isCollapsed ? "chevron-right" : "chevron-down", "tb-icon-button");
      toggle.setAttribute("aria-label", t(isCollapsed ? "Expand {name}" : "Collapse {name}", { name: group.label })); toggle.setAttribute("aria-expanded", String(!isCollapsed));
      const collapse = () => { search.expanded.delete(key); if (isCollapsed) collapsed.delete(key); else collapsed.add(key); render(); };
      line.onclick = collapse;
      const groupField = table.fields.find((field) => field.id === currentView().group?.fieldId);
      const option = groupField?.options?.find((option) => group.key === `value:${option.id}`);
      content.append(toggle, el("span", `tb-group-label${option ? ` tb-pill tb-color-${option.color}` : ""}`, group.label), el("span", "tb-group-count", String(group.rows.length)));
      const add = control("", "plus", "tb-icon-button tb-group-add"); add.setAttribute("aria-label", t("Add row to {name}", { name: group.label }));
      add.onclick = (event) => { event.stopPropagation(); void insertGroupRow(group); }; content.append(add); cell.append(content); line.append(cell); body.append(line);
      if (!isCollapsed) group.rows.forEach((row) => body.append(renderRow(row, fields)));
    });
    else rows.forEach((row) => body.append(renderRow(row, fields)));
    if (!rows.length) { const tr = el("tr"); const td = el("td", "tb-empty", table.records.length ? t("No rows match the filters.") : t("No rows yet.")); td.colSpan = span; tr.append(td); body.append(tr); }
    const last = el("tr"); const cell = el("td", "tb-add-row-cell"); cell.colSpan = span;
    const addRow = control(t("New row"), "plus", "tb-add-row"); addRow.onclick = () => void insertRow(table.records.length, undefined, { reveal: true }); cell.append(addRow); last.append(cell); body.append(last);
    grid.append(body); return grid;
  }

  function renderHeader(field: Field, first: boolean, filtered: boolean): HTMLTableCellElement {
    const th = el("th", `tb-header-cell${first ? " tb-first-cell" : ""}${activeHeaderId === field.id ? " is-header-active" : ""}${filtered ? " has-filter" : ""}`); th.dataset.fieldId = field.id;
    const inner = el("div", "tb-header-content");
    const grip = icon(fieldIcon[field.type], "tb-type-icon"); grip.draggable = window.matchMedia("(pointer: fine)").matches;
    grip.setAttribute("aria-label", t("Drag to reorder {name}", { name: field.name }));
    installDrag(grip, th, "field", field.id);
    const name = el("textarea", "tb-field-name tb-auto-height"); name.rows = 1; name.value = field.name;
    name.readOnly = editingHeaderId !== field.id;
    name.dataset.focusKey = `header:${field.id}`;
    name.onmousedown = (event) => {
      if (name.readOnly && event.detail > 1) event.preventDefault();
    };
    const nameLabel = hiddenAccessibleLabel(t("Column name: {name}", { name: field.name }));
    name.setAttribute("aria-labelledby", nameLabel.id); name.style.textAlign = field.align || "left";
    name.oninput = () => { name.setCssStyles({ height: "auto" }); name.style.height = `${name.scrollHeight}px`; context.onLayout?.(); };
    name.onchange = () => void commit((next) => { next.fields.find((item) => item.id === field.id)!.name = name.value; });
    name.onblur = () => {
      if (editingHeaderId === field.id) {
        editingHeaderId = undefined;
        name.readOnly = true;
      }
    };
    name.onkeydown = (event) => {
      if (name.readOnly && (event.key === "Enter" || event.key === " ")) {
        event.preventDefault(); editHeaderName(field.id, th, name);
      } else if (!name.readOnly && event.key === "Escape") {
        event.preventDefault(); name.value = field.name; name.setCssStyles({ height: "auto" }); name.style.height = `${name.scrollHeight}px`;
        editingHeaderId = undefined; name.readOnly = true; context.onLayout?.();
      }
    };
    name.ondblclick = (event) => { event.preventDefault(); event.stopPropagation(); editHeaderName(field.id, th, name); };
    inner.append(grip, name, nameLabel);
    if (filtered) {
      const indicator = icon("filter", "tb-filter-indicator");
      indicator.setAttribute("aria-hidden", "true");
      inner.append(indicator);
    }
    if (currentView().sort?.fieldId === field.id) inner.append(el("span", "tb-sort-indicator", currentView().sort?.direction === "asc" ? "↑" : "↓"));
    if (currentView().group?.fieldId === field.id) { const group = icon("list-tree", "tb-group-indicator"); group.title = t("Grouped by this column"); inner.append(group); }
    const menu = control("", "chevron-down", "tb-icon-button tb-header-menu"); menu.setAttribute("aria-label", t("{name} column menu", { name: field.name }));
    menu.onclick = (event) => openColumnMenu(field, menu, event); inner.append(menu); th.append(inner);
    th.oncontextmenu = (event) => {
      event.preventDefault(); event.stopPropagation(); openColumnMenu(field, th, event);
    };
    const handle = el("div", "tb-resize-handle"); handle.setAttribute("aria-label", t("Resize {name}", { name: field.name })); handle.title = t("Drag to resize");
    handle.onpointerdown = (event) => {
      event.preventDefault(); event.stopPropagation();
      const start = event.clientX; const initial = field.width ?? defaultFieldWidth(field.type); let width = initial;
      const grid = th.closest("table")!; const col = [...grid.querySelectorAll<HTMLTableColElement>("col")].find((item) => item.dataset.fieldId === field.id)!;
      const initialTotal = parseFloat(grid.style.width); handle.setPointerCapture(event.pointerId); root.classList.add("tb-resizing");
      const move = (pointer: PointerEvent) => { width = Math.max(60, Math.round(initial + pointer.clientX - start)); col.style.width = `${width}px`; grid.style.width = `${initialTotal + width - initial}px`; scheduleLayout(); };
      const finish = (pointer: PointerEvent) => {
        handle.removeEventListener("pointermove", move); handle.removeEventListener("pointerup", finish); handle.removeEventListener("pointercancel", cancel);
        root.classList.remove("tb-resizing"); if (handle.hasPointerCapture(pointer.pointerId)) handle.releasePointerCapture(pointer.pointerId);
        if (width !== initial) void commit((next) => { next.fields.find((item) => item.id === field.id)!.width = width; });
      };
      const cancel = (pointer: PointerEvent) => { width = initial; col.style.width = `${initial}px`; grid.style.width = `${initialTotal}px`; finish(pointer); };
      handle.addEventListener("pointermove", move); handle.addEventListener("pointerup", finish); handle.addEventListener("pointercancel", cancel);
    };
    th.append(handle); return th;
  }

  function openTypeMenu(anchor: HTMLElement, event: MouseEvent, position: number): void {
    const menu = new Menu().setUseNativeMenu(false);
    FIELD_TYPES.forEach((type) => menuAction(menu, fieldTypeLabel(type), fieldIcon[type], () => addField(position, type)));
    showTableMenu(menu, anchor, event);
  }

  function openColumnMenu(field: Field, anchor: HTMLElement, event: MouseEvent): void {
    const view = currentView(); const menu = new Menu();
    if (!Platform.isMobile) menu.setUseNativeMenu(false);
    const sort = (direction: "asc" | "desc") => commit((next) => { next.views.find((item) => item.id === view.id)!.sort = { fieldId: field.id, direction }; });
    menuAction(menu, t("Edit column"), "pencil", () => editColumn(field));
    menu.addSeparator();
    menuAction(menu, t("Sort ascending"), "arrow-up", () => sort("asc"));
    menuAction(menu, t("Sort descending"), "arrow-down", () => sort("desc"));
    if (view.sort?.fieldId === field.id) menuAction(menu, t("Clear sort"), "x", () => commit((next) => { delete next.views.find((item) => item.id === view.id)!.sort; }));
    menu.addSeparator();
    submenu(menu, t("Text align"), `align-${field.align || "left"}`, (child) => {
      if (!Platform.isMobile) child.setUseNativeMenu(false);
      (["left", "center", "right"] as const).forEach((align) => {
        const label = t(align === "left" ? "Left" : align === "center" ? "Center" : "Right");
        const applyAlignment = () => commit((next) => { next.fields.find((item) => item.id === field.id)!.align = align; });
        if (!Platform.isMobile) {
          child.addItem((item) => configMenuItem(item, label, `align-${align}`).setChecked(field.align === align).onClick(applyAlignment));
        } else {
          menuAction(child, label, field.align === align ? "check" : `align-${align}`, applyAlignment);
        }
      });
    }, trackTableMenu);
    menu.addSeparator();
    ([false, true] as const).forEach((after) => submenu(menu, t(after ? "Insert column right" : "Insert column left"), after ? "arrow-right" : "arrow-left", (child) => {
      if (!Platform.isMobile) child.setUseNativeMenu(false);
      FIELD_TYPES.forEach((type) => menuAction(child, fieldTypeLabel(type), fieldIcon[type], () => addField(table.fields.findIndex((item) => item.id === field.id) + Number(after), type)));
    }, trackTableMenu));
    menuAction(menu, t("Duplicate column"), "copy", () => duplicateField(field.id));
    menu.addSeparator();
    const groupMenu = (direction: "asc" | "desc") => commit((next) => { next.views.find((item) => item.id === view.id)!.group = { fieldId: field.id, direction }; });
    menuAction(menu, view.group?.fieldId === field.id ? t("Groups ascending") : t("Group by this column"), "list-tree", () => groupMenu("asc"));
    if (view.group?.fieldId === field.id) {
      menuAction(menu, t("Groups descending"), "arrow-down", () => groupMenu("desc"));
      menuAction(menu, t("Clear grouping"), "x", () => commit((next) => { delete next.views.find((item) => item.id === view.id)!.group; }));
    }
    if (Platform.isMobile) {
      submenu(menu, t("Move column"), "move-horizontal", (child) => {
        const position = table.fields.findIndex((item) => item.id === field.id);
        menuAction(child, t("Move left"), "arrow-left", () => commit((next) => moveRelative(next.fields, field.id, next.fields[position - 1].id, false)), position === 0);
        menuAction(child, t("Move right"), "arrow-right", () => commit((next) => moveRelative(next.fields, field.id, next.fields[position + 1].id, true)), position === table.fields.length - 1);
      }, trackTableMenu);
    }
    menuAction(menu, t("Column width…"), "move-horizontal", async () => {
      const result = await prompt(t("Column width"), [{ label: t("Column width"), value: String(field.width), type: "number", description: t("Width must be at least 60 pixels") }], undefined, { modalClassName: "tb-column-width-modal", hideSingleFieldLabel: true });
      if (result) await commit((next) => { next.fields.find((item) => item.id === field.id)!.width = clampWidth(Number(result[0])); });
    });
    if (visibleFields(table, view).length > 1) menuAction(menu, t("Hide in this view"), "eye-off", () => commit((next) => {
      const target = next.views.find((item) => item.id === view.id)!;
      target.visibleFieldIds = (target.visibleFieldIds ?? next.fields.map((item) => item.id)).filter((id) => id !== field.id);
    }));
    menu.addSeparator();
    menuAction(menu, t("Delete column"), "trash", async () => {
      if (!(await confirm(t("Delete column?"), t("Delete “{name}” and its values from all records?", { name: field.name }), t("Delete")))) return;
      await commit((next) => {
        next.fields = next.fields.filter((item) => item.id !== field.id); next.records.forEach((row) => delete row.values[field.id]);
        next.views.forEach((item) => {
          item.filters.conditions = item.filters.conditions.filter((rule) => rule.fieldId !== field.id); if (item.sort?.fieldId === field.id) delete item.sort; if (item.group?.fieldId === field.id) delete item.group;
          if (item.visibleFieldIds) item.visibleFieldIds = item.visibleFieldIds.filter((id) => id !== field.id);
        });
      });
    }, table.fields.length < 2, true);
    showTableMenu(menu, anchor, event);
  }

  async function addField(position: number, type: FieldType): Promise<void> {
    const field = newField(t("Column {number}", { number: table.fields.length + 1 }), type);
    await commit((next) => { next.fields.splice(position, 0, field); next.records.forEach((row) => { row.values[field.id] = defaultCell(type); }); });
  }

  function duplicateField(id: string): Promise<boolean> {
    return commit((next) => {
      const original = next.fields.find((field) => field.id === id)!;
      const duplicate = JSON.parse(JSON.stringify(original)) as Field; duplicate.id = makeId("field"); duplicate.name += t(" copy");
      const ids = new Map<string, string>(); duplicate.options?.forEach((option) => { const old = option.id; option.id = makeId("option"); ids.set(old, option.id); });
      next.fields.splice(next.fields.findIndex((field) => field.id === id) + 1, 0, duplicate);
      next.records.forEach((row) => {
        const value = row.values[id];
        row.values[duplicate.id] = Array.isArray(value) ? value.map((item) => ids.get(item) ?? item)
          : ["select", "status"].includes(original.type) ? ids.get(String(value)) ?? "" : cloneValue(value);
      });
    });
  }

  async function editColumn(field: Field): Promise<void> {
    const initial = JSON.parse(JSON.stringify(field)) as Field;
    if (initial.type === "status") initial.type = "select";
    if (initial.type === "date") initial.dateFormat ??= "iso-date";
    const result = await new Promise<Field | null>((resolve) => {
      class ColumnModal extends Modal {
        draft = initial;
        pendingOptionIds = new Set<string>();
        confirmedImpact = false;
        result: Field | null = null;
        typeButton!: HTMLButtonElement;
        typePicker: HTMLDivElement | null = null;
        optionColorPicker: HTMLDivElement | null = null;
        optionColorButton: HTMLButtonElement | null = null;
        optionsSection: HTMLDivElement | null = null;
        layoutObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(() => this.updateViewport());
        openTypeTimer: number | null = null;
        closeTypeTimer: number | null = null;
        onOpen(): void {
          this.modalEl.classList.add("tb-ui-surface", "tb-column-editor-modal");
          this.containerEl.classList.add("tb-column-editor-container");
          this.setTitle(t("Edit column"));
          this.contentEl.classList.add("tb-dialog", "tb-column-editor");
          window.addEventListener("resize", this.updateViewport);
          window.visualViewport?.addEventListener("resize", this.updateViewport);
          window.visualViewport?.addEventListener("scroll", this.updateViewport);
          this.draw();
        }
        updateViewport = (): void => {
          const viewport = window.visualViewport;
          const height = viewport?.height ?? window.innerHeight;
          this.containerEl.style.top = `${viewport?.offsetTop ?? 0}px`;
          this.containerEl.style.left = `${viewport?.offsetLeft ?? 0}px`;
          this.containerEl.style.width = `${viewport?.width ?? window.innerWidth}px`;
          this.containerEl.style.height = `${height}px`;
          this.modalEl.style.setProperty("--tb-ui-viewport-height", `${height}px`);
          this.modalEl.style.setProperty("--tb-ui-viewport-width", `${viewport?.width ?? window.innerWidth}px`);
          const header = this.titleEl.closest<HTMLElement>(".modal-header") ?? this.titleEl;
          const modalStyle = window.getComputedStyle(this.modalEl);
          const headerStyle = window.getComputedStyle(header);
          const contentStyle = window.getComputedStyle(this.contentEl);
          const pixels = (value: string) => parseFloat(value) || 0;
          const children = [...this.contentEl.children].filter((child) => !(child as HTMLElement).hidden);
          let minimumHeight = header.getBoundingClientRect().height + pixels(headerStyle.marginBottom)
            + pixels(modalStyle.paddingTop) + pixels(modalStyle.paddingBottom)
            + pixels(modalStyle.borderTopWidth) + pixels(modalStyle.borderBottomWidth)
            + Math.max(0, children.length - 1) * pixels(contentStyle.rowGap);
          for (const child of children) {
            if (child === this.optionsSection) {
              // Leave room for two rows; smaller viewports use one scrolling body and a visible close button.
              const rowHeight = pixels(window.getComputedStyle(this.typeButton).height);
              minimumHeight += child.firstElementChild!.getBoundingClientRect().height + 8 + rowHeight * 2 + 8;
            } else minimumHeight += child.getBoundingClientRect().height;
          }
          const availableHeight = this.optionsSection ? Math.min(600, height - 32) : height - 32;
          this.modalEl.classList.toggle("is-compact-height", minimumHeight > availableHeight);
          const list = this.optionsSection?.querySelector<HTMLElement>(".tb-options-list");
          if (list) {
            const scrollbarWidth = Math.max(0, list.offsetWidth - list.clientWidth);
            // Keep 5px for expanded row hit areas and at least 4px before the modal edge.
            const outwardSpace = Math.max(0, pixels(modalStyle.paddingRight) - 9);
            const outset = minimumHeight > availableHeight ? 0 : Math.min(scrollbarWidth, outwardSpace);
            list.style.setProperty("--tb-options-scrollbar-outset", `${outset}px`);
          }
          this.positionTypePicker();
          this.positionOptionColorPicker();
        };
        // Modal handles Escape in its key scope before DOM listeners, so dismiss its child picker here first.
        onEscapeKey(event: KeyboardEvent): void {
          if (event.defaultPrevented) return;
          event.preventDefault();
          if (this.typePicker) { this.closeTypePicker(); this.typeButton.focus({ preventScroll: true }); }
          else if (this.optionColorPicker) { const trigger = this.optionColorButton; this.closeOptionColorPicker(); trigger?.focus({ preventScroll: true }); }
          else this.close();
        }
        draw(): void {
          this.closeOptionColorPicker();
          this.layoutObserver?.disconnect();
          this.optionsSection = null;
          this.modalEl.classList.toggle("has-options", ["select", "multiselect", "status"].includes(this.draft.type));
          this.contentEl.replaceChildren();
          const nameLabel = el("label", "tb-dialog-field");
          nameLabel.append(el("span", "tb-column-section-label", t("Column name")));
          const name = el("input", "tb-input"); name.value = this.draft.name;
          name.oninput = () => { this.draft.name = name.value; this.resetImpact(); };
          nameLabel.append(name); this.contentEl.append(nameLabel);

          const typeField = el("div", "tb-dialog-field");
          const typeLabel = el("span", "tb-column-section-label", t("Column type"));
          const typeButton = this.typeButton = control("", undefined, "tb-field-type-selector");
          typeButton.id = `tb-column-type-${field.id}`;
          typeButton.append(icon(fieldIcon[this.draft.type], "tb-type-icon"), el("span", "", fieldTypeLabel(this.draft.type)), icon("chevron-right", "tb-type-chevron"));
          typeButton.removeAttribute("aria-label");
          typeButton.setAttribute("aria-haspopup", "listbox");
          typeButton.setAttribute("aria-expanded", "false");
          typeButton.addEventListener("pointerenter", (event) => {
            if (event.pointerType === "touch" || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
            this.clearTypeTimers();
            this.openTypeTimer = window.setTimeout(() => this.openTypePicker(), 130);
          });
          typeButton.addEventListener("pointerleave", (event) => {
            if (event.pointerType === "touch" || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
            this.scheduleTypePickerClose();
          });
          typeButton.onclick = () => this.openTypePicker(true);
          typeButton.onkeydown = (event) => {
            if (event.key === "Escape" && this.typePicker) { event.preventDefault(); this.closeTypePicker(); }
          };
          typeField.append(typeLabel, typeButton); this.contentEl.append(typeField);

          if (this.draft.type === "date") {
            const label = el("label", "tb-dialog-field");
            label.append(el("span", "tb-column-section-label", t("Date format")));
            const select = el("select", "tb-input");
            const sample = "2026-10-07T21:53";
            DATE_DISPLAY_FORMATS.forEach((format) => {
              const option = el("option", "", formatDateValue(sample, format)); option.value = format; select.append(option);
            });
            select.value = this.draft.dateFormat ?? "iso-date";
            select.onchange = () => { this.draft.dateFormat = select.value as DateDisplayFormat; this.resetImpact(); };
            const selectFrame = el("div", "tb-column-select-frame");
            const chevron = icon("chevron-down", "tb-select-chevron"); chevron.setAttribute("aria-hidden", "true");
            selectFrame.append(select, chevron); label.append(selectFrame); this.contentEl.append(label);
          }

          if (["select", "multiselect", "status"].includes(this.draft.type)) this.drawOptions();
          this.impactMessage = el("p", "tb-dialog-message tb-column-impact"); this.impactMessage.hidden = true; this.contentEl.append(this.impactMessage);
          const actions = el("div", "tb-dialog-actions"); const cancel = control(t("Cancel")); cancel.removeAttribute("aria-label"); cancel.onclick = () => this.close();
          this.saveButton = control(t("Save")); this.saveButton.removeAttribute("aria-label"); this.saveButton.classList.add("mod-cta"); this.saveButton.onclick = () => this.saveDraft();
          actions.append(cancel, this.saveButton); this.contentEl.append(actions);
          this.layoutObserver?.observe(this.titleEl);
          [...this.contentEl.children].forEach((child) => { if (child !== this.optionsSection) this.layoutObserver?.observe(child); });
          this.updateViewport();
        }
        impactMessage!: HTMLParagraphElement;
        saveButton!: HTMLButtonElement;
        resetImpact(): void {
          this.confirmedImpact = false;
          if (this.impactMessage) this.impactMessage.hidden = true;
          if (this.saveButton) {
            this.saveButton.textContent = t("Save");
            this.saveButton.removeAttribute("aria-label");
          }
          this.updateViewport();
        }
        clearTypeTimers(): void {
          if (this.openTypeTimer !== null) window.clearTimeout(this.openTypeTimer);
          if (this.closeTypeTimer !== null) window.clearTimeout(this.closeTypeTimer);
          this.openTypeTimer = null;
          this.closeTypeTimer = null;
        }
        scheduleTypePickerClose(): void {
          if (this.openTypeTimer !== null) window.clearTimeout(this.openTypeTimer);
          this.openTypeTimer = null;
          if (this.closeTypeTimer !== null) window.clearTimeout(this.closeTypeTimer);
          this.closeTypeTimer = window.setTimeout(() => this.closeTypePicker(), 220);
        }
        positionTypePicker = (): void => {
          if (!this.typePicker || !this.typeButton?.isConnected) return;
          const rect = this.typeButton.getBoundingClientRect();
          const viewport = window.visualViewport;
          const leftEdge = (viewport?.offsetLeft ?? 0) + 16;
          const topEdge = (viewport?.offsetTop ?? 0) + 16;
          const rightEdge = leftEdge + (viewport?.width ?? window.innerWidth) - 32;
          const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight) - 32;
          const narrow = rightEdge - leftEdge < 528;
          const width = Math.max(0, Math.min(narrow ? rightEdge - leftEdge : 260, rightEdge - leftEdge));
          this.typePicker.style.width = `${width}px`;
          this.typePicker.style.maxHeight = `${Math.max(0, Math.min(360, bottomEdge - topEdge))}px`;
          let left = rect.right + 8;
          let top = rect.top;
          if (narrow) {
            const desiredHeight = Math.min(this.typePicker.scrollHeight + 2, 360);
            const below = Math.max(0, bottomEdge - rect.bottom - 8);
            const above = Math.max(0, rect.top - topEdge - 8);
            const openBelow = below >= desiredHeight || below >= above;
            this.typePicker.style.maxHeight = `${Math.min(360, openBelow ? below : above)}px`;
            left = leftEdge;
            top = openBelow ? rect.bottom + 8 : rect.top - this.typePicker.getBoundingClientRect().height - 8;
          } else if (left + width > rightEdge) left = rect.left - width - 8;
          const height = this.typePicker.getBoundingClientRect().height;
          this.typePicker.style.left = `${Math.max(leftEdge, Math.min(left, rightEdge - width))}px`;
          this.typePicker.style.top = `${Math.max(topEdge, Math.min(top, bottomEdge - height))}px`;
        };
        onTypePickerPointerDown = (event: PointerEvent): void => {
          const target = event.target;
          if (target && (this.typePicker?.contains(target as Node) || this.typeButton?.contains(target as Node))) return;
          this.closeTypePicker();
        };
        openTypePicker(focusCurrent = false): void {
          this.closeOptionColorPicker();
          this.clearTypeTimers();
          if (this.typePicker) {
            if (focusCurrent) this.typePicker.querySelector<HTMLElement>(".is-active")?.focus({ preventScroll: true });
            return;
          }
          const picker = el("div", "tb-ui-surface tb-column-type-picker");
          picker.setAttribute("role", "group");
          picker.setAttribute("aria-labelledby", this.typeButton.id);
          const list = el("div", "tb-field-type-list");
          list.setAttribute("role", "listbox");
          list.setAttribute("aria-labelledby", this.typeButton.id);
          FIELD_TYPES.forEach((type) => {
            const item = control("", undefined, `tb-field-type-option${this.draft.type === type ? " is-active" : ""}`);
            item.removeAttribute("aria-label");
            item.append(icon(fieldIcon[type], "tb-type-icon"), el("span", "", fieldTypeLabel(type)));
            if (this.draft.type === type) item.append(icon("check", "tb-type-check"));
            item.setAttribute("role", "option");
            item.setAttribute("aria-selected", String(this.draft.type === type));
            item.onclick = () => {
              this.draft.type = type;
              if (["select", "multiselect"].includes(type)) this.draft.options ??= choicesForDraft(field, table.records);
              if (type === "date") this.draft.dateFormat ??= "iso-date";
              this.closeTypePicker();
              this.resetImpact();
              this.draw();
              this.typeButton.focus({ preventScroll: true });
            };
            list.append(item);
          });
          picker.append(list);
          picker.addEventListener("pointerenter", () => {
            if (this.closeTypeTimer !== null) window.clearTimeout(this.closeTypeTimer);
            this.closeTypeTimer = null;
          });
          picker.addEventListener("pointerleave", (event) => {
            if (event.pointerType === "touch" || !window.matchMedia("(hover: hover) and (pointer: fine)").matches) return;
            this.scheduleTypePickerClose();
          });
          picker.onkeydown = (event) => {
            const options = [...picker.querySelectorAll<HTMLButtonElement>(".tb-field-type-option")];
            const current = options.indexOf(document.activeElement as HTMLButtonElement);
            let next = current;
            if (event.key === "ArrowDown") next = (current + 1 + options.length) % options.length;
            else if (event.key === "ArrowUp") next = (current - 1 + options.length) % options.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = options.length - 1;
            else if (event.key === "Escape") { event.preventDefault(); this.closeTypePicker(); this.typeButton.focus({ preventScroll: true }); return; }
            else return;
            event.preventDefault(); options[next]?.focus();
          };
          this.typePicker = picker;
          // A sibling of modalEl can float beyond its clipping boundary while staying in the host focus scope.
          this.containerEl.append(picker);
          this.typeButton.setAttribute("aria-expanded", "true");
          document.addEventListener("pointerdown", this.onTypePickerPointerDown, true);
          window.addEventListener("resize", this.positionTypePicker);
          window.addEventListener("scroll", this.positionTypePicker, true);
          this.contentEl.addEventListener("scroll", this.positionTypePicker, true);
          this.positionTypePicker();
          if (focusCurrent) picker.querySelector<HTMLElement>(".is-active")?.focus();
        }
        closeTypePicker(): void {
          this.clearTypeTimers();
          this.typePicker?.remove();
          this.typePicker = null;
          this.typeButton?.setAttribute("aria-expanded", "false");
          document.removeEventListener("pointerdown", this.onTypePickerPointerDown, true);
          window.removeEventListener("resize", this.positionTypePicker);
          window.removeEventListener("scroll", this.positionTypePicker, true);
          this.contentEl.removeEventListener("scroll", this.positionTypePicker, true);
        }
        positionOptionColorPicker = (): void => {
          if (!this.optionColorPicker || !this.optionColorButton?.isConnected) return;
          const rect = this.optionColorButton.getBoundingClientRect();
          const viewport = window.visualViewport;
          const leftEdge = (viewport?.offsetLeft ?? 0) + 16;
          const topEdge = (viewport?.offsetTop ?? 0) + 16;
          const rightEdge = leftEdge + (viewport?.width ?? window.innerWidth) - 32;
          const bottomEdge = topEdge + (viewport?.height ?? window.innerHeight) - 32;
          const width = this.optionColorPicker.getBoundingClientRect().width || 108;
          const height = this.optionColorPicker.getBoundingClientRect().height || 108;
          let left = rect.left;
          let top = rect.bottom + 4;
          if (left + width > rightEdge) left = rect.right - width;
          if (top + height > bottomEdge) top = rect.top - height - 4;
          this.optionColorPicker.style.left = `${Math.max(leftEdge, Math.min(left, rightEdge - width))}px`;
          this.optionColorPicker.style.top = `${Math.max(topEdge, Math.min(top, bottomEdge - height))}px`;
        };
        onOptionColorPickerPointerDown = (event: PointerEvent): void => {
          const target = event.target;
          if (target && (this.optionColorPicker?.contains(target as Node) || this.optionColorButton?.contains(target as Node))) return;
          this.closeOptionColorPicker();
        };
        openOptionColorPicker(option: SelectOption, trigger: HTMLButtonElement, triggerLabel: HTMLSpanElement): void {
          this.closeTypePicker();
          if (this.optionColorPicker) {
            const sameTrigger = this.optionColorButton === trigger;
            this.closeOptionColorPicker();
            if (sameTrigger) return;
          }
          const picker = el("div", "tb-ui-surface tb-option-color-picker");
          picker.setAttribute("role", "listbox");
          picker.setAttribute("aria-labelledby", triggerLabel.id);
          OPTION_COLORS.forEach((color) => {
            const choice = control("", undefined, `tb-option-color-choice tb-color-${color}${color === option.color ? " is-active" : ""}`);
            choice.removeAttribute("aria-label");
            choice.setAttribute("role", "option");
            choice.setAttribute("aria-selected", String(color === option.color));
            choice.dataset.color = color;
            const choiceLabel = hiddenAccessibleLabel(t("{name}: {color}", { name: option.label || t("Option"), color: colorLabel(color) }));
            choice.setAttribute("aria-labelledby", choiceLabel.id);
            choice.append(choiceLabel);
            if (color === option.color) choice.append(icon("check", "tb-option-color-check"));
            choice.onclick = () => {
              option.color = color;
              trigger.classList.forEach((className) => { if (className.startsWith("tb-color-")) trigger.classList.remove(className); });
              trigger.classList.add(`tb-color-${color}`);
              triggerLabel.textContent = t("Change color for {name}: {color}", { name: option.label || t("Option"), color: colorLabel(color) });
              this.resetImpact();
              this.closeOptionColorPicker();
              trigger.focus({ preventScroll: true });
            };
            picker.append(choice);
          });
          picker.onkeydown = (event) => {
            const options = [...picker.querySelectorAll<HTMLButtonElement>(".tb-option-color-choice")];
            const current = options.indexOf(document.activeElement as HTMLButtonElement);
            let next = current;
            if (event.key === "ArrowRight") next = (current + 1 + options.length) % options.length;
            else if (event.key === "ArrowLeft") next = (current - 1 + options.length) % options.length;
            else if (event.key === "ArrowDown") next = (current + 3) % options.length;
            else if (event.key === "ArrowUp") next = (current - 3 + options.length) % options.length;
            else if (event.key === "Home") next = 0;
            else if (event.key === "End") next = options.length - 1;
            else if (event.key === "Escape") { event.preventDefault(); this.closeOptionColorPicker(); trigger.focus({ preventScroll: true }); return; }
            else return;
            event.preventDefault(); options[next]?.focus({ preventScroll: true });
          };
          this.optionColorPicker = picker;
          this.optionColorButton = trigger;
          this.containerEl.append(picker);
          trigger.setAttribute("aria-expanded", "true");
          document.addEventListener("pointerdown", this.onOptionColorPickerPointerDown, true);
          window.addEventListener("resize", this.positionOptionColorPicker);
          window.addEventListener("scroll", this.positionOptionColorPicker, true);
          this.contentEl.addEventListener("scroll", this.positionOptionColorPicker, true);
          this.positionOptionColorPicker();
          picker.querySelector<HTMLElement>("[aria-selected='true']")?.focus({ preventScroll: true });
        }
        closeOptionColorPicker(): void {
          this.optionColorPicker?.remove();
          this.optionColorPicker = null;
          this.optionColorButton?.setAttribute("aria-expanded", "false");
          this.optionColorButton = null;
          document.removeEventListener("pointerdown", this.onOptionColorPickerPointerDown, true);
          window.removeEventListener("resize", this.positionOptionColorPicker);
          window.removeEventListener("scroll", this.positionOptionColorPicker, true);
          this.contentEl.removeEventListener("scroll", this.positionOptionColorPicker, true);
        }
        drawOptions(): void {
          const section = this.optionsSection = el("div", "tb-column-options-section");
          const heading = el("div", "tb-column-options-heading");
          heading.append(el("span", "tb-column-section-label", t("Options")));
          const list = el("div", "tb-options-list");
          const addButton = control(t("Add option"), "plus", "tb-option-add-button");
          addButton.removeAttribute("aria-label");
          const drawList = () => {
            const scrollTop = list.scrollTop;
            list.replaceChildren();
            this.closeOptionColorPicker();
            if (!this.draft.options?.length) list.append(el("p", "tb-muted", t("No options yet.")));
            (this.draft.options ?? []).forEach((option) => {
              const row = el("div", "tb-option-row");
              const colorButton = control("", undefined, "tb-option-color-trigger");
              colorButton.dataset.optionId = option.id;
              colorButton.classList.add(`tb-color-${option.color}`);
              colorButton.removeAttribute("aria-label");
              colorButton.setAttribute("aria-haspopup", "listbox");
              colorButton.setAttribute("aria-expanded", "false");
              const colorButtonLabel = hiddenAccessibleLabel(t("Change color for {name}: {color}", { name: option.label || t("Option"), color: colorLabel(option.color) }));
              colorButton.setAttribute("aria-labelledby", colorButtonLabel.id);
              colorButton.append(colorButtonLabel);
              colorButton.onclick = () => this.openOptionColorPicker(option, colorButton, colorButtonLabel);
              const inputLabel = hiddenAccessibleLabel(t("Option name"));
              const input = el("input", "tb-option-name"); input.value = option.label; input.dataset.optionId = option.id; input.setAttribute("aria-labelledby", inputLabel.id);
              const remove = control("", "trash", "tb-icon-button"); remove.removeAttribute("aria-label");
              const removeLabel = hiddenAccessibleLabel(t("Delete {name}", { name: option.label }));
              remove.setAttribute("aria-labelledby", removeLabel.id); remove.append(removeLabel);
              const drag = control("", "grip-vertical", "tb-icon-button tb-option-drag-handle"); drag.removeAttribute("aria-label");
              drag.dataset.optionId = option.id;
              const dragLabel = hiddenAccessibleLabel(t("Drag {name} to reorder", { name: option.label || t("Option") }));
              drag.setAttribute("aria-labelledby", dragLabel.id); drag.append(dragLabel);
              drag.draggable = window.matchMedia("(pointer: fine)").matches;
              const clearOptionDropIndicators = () => list.querySelectorAll(".tb-drop-before, .tb-drop-after").forEach((element) => element.classList.remove("tb-drop-before", "tb-drop-after"));
              const isAfter = (event: DragEvent) => {
                const rect = row.getBoundingClientRect();
                return event.clientY > (rect.top + rect.bottom) / 2;
              };
              drag.addEventListener("dragstart", (event) => {
                event.stopPropagation();
                event.dataTransfer?.setData("text/tablebase-option", option.id);
                if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
                row.classList.add("tb-dragging");
              });
              drag.addEventListener("dragend", () => { row.classList.remove("tb-dragging"); clearOptionDropIndicators(); });
              row.ondragover = (event) => {
                if (!event.dataTransfer?.types.includes("text/tablebase-option")) return;
                event.preventDefault(); clearOptionDropIndicators();
                row.classList.add(isAfter(event) ? "tb-drop-after" : "tb-drop-before");
              };
              row.ondragleave = (event) => {
                if (event.relatedTarget && row.contains(event.relatedTarget as Node)) return;
                row.classList.remove("tb-drop-before", "tb-drop-after");
              };
              row.ondrop = (event) => {
                const sourceId = event.dataTransfer?.getData("text/tablebase-option");
                if (!sourceId) return;
                event.preventDefault();
                const after = isAfter(event); clearOptionDropIndicators();
                if (sourceId === option.id) return;
                moveRelative(this.draft.options ?? [], sourceId, option.id, after);
                drawList();
                list.querySelector<HTMLButtonElement>(`.tb-option-drag-handle[data-option-id="${sourceId}"]`)?.focus({ preventScroll: true });
                this.resetImpact();
              };
              input.oninput = () => {
                option.label = input.value;
                removeLabel.textContent = t("Delete {name}", { name: input.value });
                colorButtonLabel.textContent = t("Change color for {name}: {color}", { name: input.value || t("Option"), color: colorLabel(option.color) });
                dragLabel.textContent = t("Drag {name} to reorder", { name: input.value || t("Option") });
                this.resetImpact();
              };
              remove.onclick = () => { this.draft.options = (this.draft.options ?? []).filter((item) => item.id !== option.id); this.pendingOptionIds.delete(option.id); drawList(); this.resetImpact(); };
              row.append(colorButton, inputLabel, input, remove, drag); list.append(row);
            });
            list.scrollTop = scrollTop;
          };
          heading.append(addButton);
          drawList(); section.append(heading, list); this.contentEl.append(section);
          addButton.onclick = () => {
            const option = { id: makeId("option"), label: "", color: nextOptionColor(this.draft.options?.length ?? 0) };
            this.draft.options ??= []; this.draft.options.push(option); this.pendingOptionIds.add(option.id);
            drawList();
            list.scrollTop = list.scrollHeight;
            list.querySelector<HTMLInputElement>(`input[data-option-id="${option.id}"]`)?.focus({ preventScroll: true });
            this.resetImpact();
          };
        }
        saveDraft(): void {
          const name = this.draft.name.trim();
          if (!name) { new Notice(t("Column name must not be empty.")); return; }
          this.draft.name = name;
          if (["select", "multiselect", "status"].includes(this.draft.type)) {
            const inputLabels = new Map(
              [...this.contentEl.querySelectorAll<HTMLInputElement>(".tb-option-name")]
                .map((input) => [input.dataset.optionId, input.value] as const),
            );
            this.draft.options = (this.draft.options ?? [])
              .map((option) => ({ ...option, label: inputLabels.get(option.id) ?? option.label }))
              .filter((option) => !this.pendingOptionIds.has(option.id) || !!option.label.trim())
              .map((option) => ({ ...option, label: option.label.trim() }));
            if (this.draft.options.some((option) => !option.label)) { new Notice(t("Option names must not be empty.")); return; }
            if (new Set(this.draft.options.map((option) => option.label)).size !== this.draft.options.length) { new Notice(t("An option with this name already exists.")); return; }
          }
          const conversions = table.records.map((row) => convertCell(field, this.draft.type, row.values[field.id], this.draft.options ?? []));
          const lostValues = conversions.filter((item) => item.lost).length;
          const filtersCanSurviveTypeChange = field.type === "select" && this.draft.type === "multiselect" || field.type === "status" && this.draft.type === "select";
          const dateFilterModeChanged = field.type === "date" && this.draft.type === "date"
            && dateFilterKind(field.dateFormat ?? "iso-date") !== dateFilterKind(this.draft.dateFormat ?? "iso-date");
          const removedOptions = new Set((field.options ?? []).filter((option) => !(this.draft.options ?? []).some((next) => next.id === option.id)).map((option) => option.id));
          const affectedFilters = table.views.map((view) => view.filters.conditions.filter((rule) => rule.fieldId === field.id
            && ((field.type !== this.draft.type && !filtersCanSurviveTypeChange) || dateFilterModeChanged || filterReferencesOptions(rule, removedOptions))).length);
          const filterViews = affectedFilters.filter((count) => count > 0).length;
          const filterConditions = affectedFilters.reduce((sum, count) => sum + count, 0);
          if ((lostValues || filterViews) && !this.confirmedImpact) {
            this.impactMessage.textContent = field.type !== "attachment" && this.draft.type === "attachment"
              ? t("Switching to attachments will clear {values} cell value(s) and {conditions} filter condition(s) in {views} view(s). Save again to confirm.", { values: lostValues, views: filterViews, conditions: filterConditions })
              : t("Some values or filters will be cleared. {values} cell value(s) and {conditions} filter condition(s) in {views} view(s) are affected. Save again to confirm.", { values: lostValues, views: filterViews, conditions: filterConditions });
            this.impactMessage.hidden = false; this.saveButton.textContent = t("Apply changes"); this.saveButton.removeAttribute("aria-label"); this.confirmedImpact = true; this.updateViewport(); return;
          }
          this.result = JSON.parse(JSON.stringify(this.draft)) as Field; this.close();
        }
        onClose(): void {
          this.layoutObserver?.disconnect();
          window.removeEventListener("resize", this.updateViewport);
          window.visualViewport?.removeEventListener("resize", this.updateViewport);
          window.visualViewport?.removeEventListener("scroll", this.updateViewport);
          this.closeTypePicker(); this.closeOptionColorPicker(); resolve(this.result);
        }
      }
      new ColumnModal(plugin.app).open();
    });
    if (!result) return;
    const options = result.options ?? [];
    const conversions = table.records.map((row) => convertCell(field, result.type, row.values[field.id], options));
    const oldOptions = new Set((field.options ?? []).map((option) => option.id));
    const retained = new Set(options.map((option) => option.id));
    const removedOptions = new Set([...oldOptions].filter((id) => !retained.has(id)));
    const filtersCanSurviveTypeChange = field.type === "select" && result.type === "multiselect" || field.type === "status" && result.type === "select";
    const dateFilterModeChanged = field.type === "date" && result.type === "date"
      && dateFilterKind(field.dateFormat ?? "iso-date") !== dateFilterKind(result.dateFormat ?? "iso-date");
    await commit((next) => {
      const target = next.fields.find((item) => item.id === field.id)!;
      target.name = result.name; target.type = result.type; target.align = field.align; target.width = field.width;
      if (["select", "multiselect"].includes(result.type)) target.options = options.map((option) => ({ ...option }));
      else delete target.options;
      if (result.type === "date") target.dateFormat = result.dateFormat ?? "iso-date";
      else delete target.dateFormat;
      next.records.forEach((row, index) => { row.values[field.id] = conversions[index].value; });
      next.views.forEach((view) => {
        view.filters.conditions = view.filters.conditions.filter((rule) => rule.fieldId !== field.id
          || !(field.type !== result.type && !filtersCanSurviveTypeChange || dateFilterModeChanged || filterReferencesOptions(rule, removedOptions)));
      });
    });
  }

  function rowHasData(row: RecordRow): boolean {
    return table.fields.some((field) => {
      const value = row.values[field.id];
      return field.type === "checkbox" ? value === true : Array.isArray(value) ? value.length > 0 : value != null && value !== "";
    });
  }

  async function deleteRows(rows: RecordRow[]): Promise<void> {
    if (!rows.length) return;
    if (rows.some(rowHasData) && !(await confirm(rows.length === 1 ? t("Delete row?") : t("Delete rows?"), t(rows.length === 1 ? "Delete {count} row and their values? This cannot be undone from the table." : "Delete {count} rows and their values? This cannot be undone from the table.", { count: rows.length }), t("Delete")))) return;
    const ids = new Set(rows.map((row) => row.id));
    await commit((next) => { next.records = next.records.filter((row) => !ids.has(row.id)); ids.forEach((id) => selectedRows.delete(id)); });
  }

  function openRowMenu(row: RecordRow, anchor: HTMLElement, event: MouseEvent): void {
    root.focus({ preventScroll: true }); const menu = new Menu();
    if (!Platform.isMobile) menu.setUseNativeMenu(false);
    const position = table.records.findIndex((item) => item.id === row.id);
    const copiedRow = rowClipboard?.rows.length === 1 ? rowClipboard : null;
    const insertAdjacent = (offset: number) => {
      const values = Object.fromEntries(table.fields.map((field) => [field.id, defaultCell(field.type)]));
      const groupedField = currentView().group?.fieldId;
      if (groupedField) values[groupedField] = JSON.parse(JSON.stringify(row.values[groupedField] ?? "")) as CellValue;
      return insertRow(position + offset, values, { reveal: true });
    };
    menuAction(menu, t("Insert row above"), "arrow-up", () => insertAdjacent(0));
    menuAction(menu, t("Insert row below"), "arrow-down", () => insertAdjacent(1)); menu.addSeparator();
    menuAction(menu, t("Duplicate row"), "copy", () => commit((next) => { next.records.splice(position + 1, 0, { id: makeId("row"), values: JSON.parse(JSON.stringify(row.values)) as Record<string, CellValue> }); }));
    menuAction(menu, t("Copy row"), "clipboard-copy", () => copyRows([row]));
    menuAction(menu, t("Paste row"), "clipboard-paste", () => { if (copiedRow) void pasteRowIntoRow(row.id, copiedRow); }, !copiedRow);
    menu.addSeparator();
    if (Platform.isMobile) {
      submenu(menu, t("Move row"), "move-vertical", (child) => {
        menuAction(child, t("Up"), "arrow-up", () => commit((next) => moveRelative(next.records, row.id, next.records[position - 1].id, false)), position === 0 || !!currentView().sort || !!currentView().group);
        menuAction(child, t("Down"), "arrow-down", () => commit((next) => moveRelative(next.records, row.id, next.records[position + 1].id, true)), position === table.records.length - 1 || !!currentView().sort || !!currentView().group);
      }, trackTableMenu);
    }
    menuAction(menu, t("Delete row"), "trash", () => deleteRows([row]), false, true); showTableMenu(menu, anchor, event);
  }

  function renderRow(row: RecordRow, fields: Field[]): HTMLTableRowElement {
    const line = el("tr", `tb-data-row${selectedRows.has(row.id) ? " is-selected" : ""}`); line.dataset.rowId = row.id;
    line.oncontextmenu = (event) => { event.preventDefault(); openRowMenu(row, line, event); };
    installDrop(line, "row", row.id);
    if (selectionMode) {
      const cell = el("td", "tb-select-cell"); const input = el("input"); input.type = "checkbox"; input.checked = selectedRows.has(row.id); input.setAttribute("aria-label", t("Select row"));
      input.onchange = () => { if (input.checked) selectedRows.add(row.id); else selectedRows.delete(row.id); render(); }; cell.append(input); line.append(cell);
    }
    fields.forEach((field) => line.append(renderCell(row, field)));
    const cell = el("td", "tb-row-actions"); const remove = control("", "x", "tb-icon-button tb-delete-row"); remove.setAttribute("aria-label", t("Delete row"));
    remove.onclick = () => void deleteRows([row]); cell.append(remove); line.append(cell, el("td", "tb-grid-fill-cell"));
    rowElementsById.set(row.id, line);
    return line;
  }

  function installDrag(handle: HTMLElement, target: HTMLElement, kind: "row" | "field", id: string): void {
    handle.addEventListener("dragstart", (event) => {
      event.stopPropagation();
      if (kind === "row" && (currentView().sort || currentView().group)) { event.preventDefault(); return; }
      event.dataTransfer?.setData(`text/tablebase-${kind}`, id);
      if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
      target.classList.add("tb-dragging");
    });
    handle.addEventListener("dragend", () => { target.classList.remove("tb-dragging"); clearDropIndicators(); });
    if (kind === "field") installDrop(target, kind, id);
  }

  function clearDropIndicators(): void {
    root.querySelectorAll(".tb-drop-before, .tb-drop-after").forEach((element) => element.classList.remove("tb-drop-before", "tb-drop-after"));
  }

  function installDrop(target: HTMLElement, kind: "row" | "field", id: string): void {
    const after = (event: DragEvent) => {
      const rect = target.getBoundingClientRect();
      return kind === "row" ? event.clientY > (rect.top + rect.bottom) / 2 : event.clientX > (rect.left + rect.right) / 2;
    };
    target.ondragover = (event) => {
      if (!event.dataTransfer?.types.includes(`text/tablebase-${kind}`)) return;
      event.preventDefault(); clearDropIndicators(); target.classList.add(after(event) ? "tb-drop-after" : "tb-drop-before");
    };
    target.ondragleave = () => target.classList.remove("tb-drop-before", "tb-drop-after");
    target.ondrop = (event) => {
      const sourceId = event.dataTransfer?.getData(`text/tablebase-${kind}`); if (!sourceId) return;
      event.preventDefault(); const insertAfter = after(event); clearDropIndicators();
      void commit((next) => {
        if (kind === "row") moveRelative(next.records, sourceId, id, insertAfter);
        else moveRelative(next.fields, sourceId, id, insertAfter);
      });
    };
  }

  async function insertRow(position: number, values?: Record<string, CellValue>, options: { reveal?: boolean; warnIfHidden?: boolean } = {}): Promise<void> {
    const rowId = makeId("row");
    const saved = await commit((next) => {
      const row = { id: rowId, values: values ?? Object.fromEntries(next.fields.map((field) => [field.id, defaultCell(field.type)])) };
      next.records.splice(position, 0, row);
    });
    if (!saved) return;
    // Keep keyboard shortcuts in the live-preview editor after the toolbar/menu is rerendered.
    if (context.save) root.focus({ preventScroll: true });
    if (!options.reveal) return;
    viewportWindow.requestAnimationFrame(() => {
      let tableRoot: HTMLElement | null = root.isConnected ? root : null;
      if (!tableRoot) {
        const view = plugin.app.workspace?.getActiveViewOfType?.(MarkdownView);
        if (view?.file?.path === context.sourcePath) {
          const candidates = tableRootsInMode(view.containerEl, table.tableId, !!context.save);
          tableRoot = candidates.find((candidate) => [...candidate.querySelectorAll<HTMLTableRowElement>("tr.tb-data-row")]
            .some((row) => row.dataset.rowId === rowId)) ?? candidates[0] ?? null;
        }
      }

      if (!tableRoot) return;
      const element = [...tableRoot.querySelectorAll<HTMLTableRowElement>("tr.tb-data-row")]
        .find((row) => row.dataset.rowId === rowId);
      if (!element) {
        if (options.warnIfHidden) new Notice(t("The row was added, but is not visible in this view."));
        return;
      }
      // Explicit row navigation takes over from both note-anchor and editor save restoration.
      cancelViewportRestorations(tableRoot);
      // CodeMirror's row-height measurements interrupt browser smooth scrolling mid-flight.
      if (!isRowVisibleInViewport(element)) element.scrollIntoView({ block: "center", inline: "nearest", behavior: "instant" });
    });
  }

  async function insertGroupRow(group: DataGroup): Promise<void> {
    const field = table.fields.find((item) => item.id === currentView().group?.fieldId); if (!field) return;
    const values = Object.fromEntries(table.fields.map((item) => [item.id, defaultCell(item.type)]));
    if (field.type === "multiselect" || field.type === "attachment") {
      try {
        const parsed: unknown = JSON.parse(group.key);
        values[field.id] = Array.isArray(parsed) && parsed.every((value: unknown) => typeof value === "string") ? parsed : [];
      } catch { values[field.id] = []; }
    } else if (field.type === "date") {
      const source = group.rows.find((row) => row.values[field.id] != null && row.values[field.id] !== "");
      if (source) values[field.id] = cloneValue(source.values[field.id]);
    } else if (group.key.startsWith("value:")) {
      const text = group.key.slice(6); values[field.id] = field.type === "checkbox" ? text === "true" : field.type === "number" ? Number(text) : text;
    }
    await insertRow(table.records.length, values, { reveal: true });
  }

  function copyRows(rows: RecordRow[]): void {
    cellClipboard = null;
    rowClipboard = captureRows(table.fields, rows);
    const text = rows.map((row) => table.fields.map((field) => tsvEscape(fieldToText(field, row.values[field.id]))).join("\t")).join("\n");
    rowClipboardText = text;
    void writeClipboard(text).catch(() => { /* Internal row copy remains usable without OS clipboard access. */ });
    render(); root.focus({ preventScroll: true });
  }

  async function pasteRowIntoRow(rowId: string, clipboard: RowClipboard): Promise<void> {
    if (rowClipboard !== clipboard || clipboard.rows.length !== 1 || !table.records.some((row) => row.id === rowId)) return;
    const saved = await commit((next) => {
      const target = next.records.find((row) => row.id === rowId);
      if (target) target.values = { ...target.values, ...clipboardValues(clipboard, next.fields, 0) };
    });
    if (saved && rowClipboard === clipboard) {
      rowClipboard = null;
      rowClipboardText = null;
    }
    render(); root.focus({ preventScroll: true });
  }

  async function confirmPasteRowIntoRow(rowId: string, clipboard: RowClipboard): Promise<void> {
    if (rowClipboard !== clipboard || clipboard.rows.length !== 1 || !table.records.some((row) => row.id === rowId)) return;
    const accepted = await confirm(
      t("Replace this row?"),
      t("Pasting the copied row will replace all values in the target row. Its position will stay the same."),
      t("Replace row"),
    );
    if (accepted && rowClipboard === clipboard) await pasteRowIntoRow(rowId, clipboard);
  }

  async function pasteInternal(intoSelection: boolean): Promise<void> {
    const clipboard = rowClipboard; if (!clipboard?.rows.length) return;
    const saved = await commit((next) => {
      const targets = intoSelection ? next.records.filter((row) => selectedRows.has(row.id)) : [];
      if (targets.length) targets.forEach((row, index) => { row.values = { ...row.values, ...clipboardValues(clipboard, next.fields, index) }; });
      else clipboard.rows.forEach((_, index) => next.records.push({ id: makeId("row"), values: clipboardValues(clipboard, next.fields, index) }));
    });
    if (saved && rowClipboard === clipboard) { rowClipboard = null; rowClipboardText = null; }
    render(); root.focus({ preventScroll: true });
  }

  function exportData(scope: ExportScope, selectedRows?: RecordRow[]): { fields: Field[]; rows: RecordRow[] } {
    if (scope === "all") return { fields: table.fields, rows: table.records };
    return { fields: visibleFields(table, currentView()), rows: selectedRows ?? projection().rows };
  }

  function exportCsv(scope: ExportScope = "current", selectedRows?: RecordRow[]): void {
    const { fields, rows } = exportData(scope, selectedRows);
    const fileName = createExportFileName(currentView().name, scope, "csv");
    void downloadCsv(fields, rows, fileName).catch((error) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) report(error);
    });
  }

  function exportMarkdownFile(scope: ExportScope): void {
    const { fields, rows } = exportData(scope);
    const fileName = createExportFileName(currentView().name, scope, "md");
    void downloadMarkdown(table, fields, rows, fileName).catch((error) => {
      if (!(error instanceof DOMException && error.name === "AbortError")) {
        new Notice(t("Could not export Markdown table: {message}", { message: errorMessage(error) }), 8000);
      }
    });
  }

  async function copyMarkdown(scope: ExportScope): Promise<void> {
    try {
      const { fields, rows } = exportData(scope);
      await writeClipboard(convertSuperTableToMarkdown(table, fields, rows));
      new Notice(t("Markdown table copied to clipboard."));
    } catch (error) {
      new Notice(t("Could not copy Markdown table: {message}", { message: errorMessage(error) }), 8000);
    }
  }

  async function addChoiceOption(rowId: string, fieldId: string, multiple: boolean): Promise<void> {
    const result = await prompt(t("New option"), [{ label: t("Option name"), value: "" }], t("Add"), { modalClassName: "tb-option-name-modal", hideSingleFieldLabel: true });
    const label = result?.[0].trim();
    if (!label) return;
    await commit((next) => {
      const target = next.fields.find((item) => item.id === fieldId);
      const record = next.records.find((item) => item.id === rowId);
      if (!target || !record) return;
      const converted = valueFromLabel(target, label);
      const optionId = Array.isArray(converted) ? converted[0] : converted as string;
      const old = record.values[fieldId];
      record.values[fieldId] = multiple ? [...new Set([...(Array.isArray(old) ? old : []), optionId])] : optionId;
    });
  }

  function openMultiSelectPicker(row: RecordRow, field: Field, anchor: HTMLButtonElement): void {
    if (multiSelectPicker?.rowId === row.id && multiSelectPicker.fieldId === field.id) {
      closeMultiSelectPicker(true);
      return;
    }
    closeMultiSelectPicker();

    const doc = anchor.ownerDocument;
    const win = doc.defaultView;
    const panel = el("div", "tb-multiselect-picker tb-ui-surface");
    panel.id = makeId("tb-multiselect-picker");
    panel.setAttribute("role", "menu");
    const options = el("div", "tb-multiselect-options");
    options.setAttribute("role", "group");
    const optionButtons = new Map<string, HTMLButtonElement>();
    (field.options ?? []).forEach((option) => {
      const button = el("button", "tb-multiselect-option");
      button.type = "button";
      button.setAttribute("role", "menuitemcheckbox");
      button.dataset.optionId = option.id;
      const check = icon("check", "tb-multiselect-option-check");
      check.setAttribute("aria-hidden", "true");
      button.append(check, el("span", "tb-multiselect-option-label", option.label));
      button.onclick = () => {
        void commit((next) => {
          const record = next.records.find((item) => item.id === row.id);
          if (!record) return;
          const values = Array.isArray(record.values[field.id]) ? record.values[field.id] as string[] : [];
          record.values[field.id] = values.includes(option.id)
            ? values.filter((id) => id !== option.id)
            : [...values, option.id];
        }, { rowId: row.id, fieldId: field.id }).then((saved) => {
          if (!saved || multiSelectPicker?.panel !== panel) return;
          updateOptions();
          syncMultiSelectPickerAnchor();
        });
      };
      optionButtons.set(option.id, button);
      options.append(button);
    });
    panel.append(options);

    const actions = el("div", "tb-multiselect-actions");
    actions.setAttribute("role", "group");
    const add = control(t("New option…"), "plus", "tb-multiselect-action");
    add.setAttribute("role", "menuitem");
    add.onclick = () => {
      closeMultiSelectPicker();
      void addChoiceOption(row.id, field.id, true);
    };
    const edit = control(t("Edit options…"), "palette", "tb-multiselect-action");
    edit.setAttribute("role", "menuitem");
    edit.onclick = () => {
      closeMultiSelectPicker();
      void editColumn(field).catch(report);
    };
    [add, edit].forEach((button) => {
      button.removeAttribute("aria-label");
      button.querySelector(".tb-control-icon")?.setAttribute("aria-hidden", "true");
    });
    actions.append(add, edit);
    panel.append(actions);

    const updateOptions = () => {
      const record = table.records.find((item) => item.id === row.id);
      const selected = new Set(Array.isArray(record?.values[field.id]) ? record.values[field.id] as string[] : []);
      optionButtons.forEach((button, optionId) => {
        const isSelected = selected.has(optionId);
        button.setAttribute("aria-checked", String(isSelected));
        button.classList.toggle("is-selected", isSelected);
      });
    };
    const triggerId = makeId("tb-multiselect-trigger");
    const position = () => {
      const picker = multiSelectPicker;
      if (!picker || picker.panel !== panel || !panel.isConnected || !picker.anchor.isConnected) return;
      const rect = picker.anchor.getBoundingClientRect();
      const viewport = win?.visualViewport;
      const leftEdge = (viewport?.offsetLeft ?? 0) + 8;
      const topEdge = (viewport?.offsetTop ?? 0) + 8;
      const rightEdge = leftEdge + (viewport?.width ?? win?.innerWidth ?? 800) - 16;
      const bottomEdge = topEdge + (viewport?.height ?? win?.innerHeight ?? 600) - 16;
      const availableWidth = Math.max(0, rightEdge - leftEdge);
      const availableHeight = Math.max(0, bottomEdge - topEdge);
      const compactHeight = availableHeight < 180;
      panel.classList.toggle("is-compact-height", compactHeight);
      panel.style.minWidth = `${Math.min(180, availableWidth)}px`;
      panel.style.maxWidth = `${Math.min(320, availableWidth)}px`;
      panel.style.maxHeight = `${compactHeight ? availableHeight : Math.min(360, (viewport?.height ?? win?.innerHeight ?? 600) * .7, availableHeight)}px`;
      const size = panel.getBoundingClientRect();
      const left = Math.max(leftEdge, Math.min(rect.right - size.width, rightEdge - size.width));
      const below = rect.bottom + 4;
      const top = below + size.height <= bottomEdge ? below : rect.top - size.height - 4;
      panel.style.left = `${left}px`;
      panel.style.top = `${Math.max(topEdge, Math.min(top, bottomEdge - size.height))}px`;
    };
    const onPointerDown = (event: PointerEvent) => {
      const picker = multiSelectPicker;
      const target = event.target;
      if (!picker || picker.panel !== panel || !(target instanceof Node)) return;
      if (panel.contains(target) || picker.anchor.contains(target)) return;
      closeMultiSelectPicker();
    };
    const onFocusIn = (event: FocusEvent) => {
      const picker = multiSelectPicker;
      const target = event.target;
      if (!picker || picker.panel !== panel || !(target instanceof Node)) return;
      if (panel.contains(target) || picker.anchor.contains(target)) return;
      closeMultiSelectPicker();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      const picker = multiSelectPicker;
      if (!picker || picker.panel !== panel) return;
      const items = [...panel.querySelectorAll<HTMLButtonElement>("[role='menuitemcheckbox'], [role='menuitem']")];
      const currentIndex = items.indexOf(doc.activeElement as HTMLButtonElement);
      if (event.key === "Escape") {
        event.preventDefault();
        event.stopImmediatePropagation();
        closeMultiSelectPicker(true);
      } else if (["ArrowDown", "ArrowUp", "Home", "End"].includes(event.key) && items.length) {
        event.preventDefault();
        const nextIndex = event.key === "Home" ? 0
          : event.key === "End" ? items.length - 1
            : currentIndex < 0 ? (event.key === "ArrowDown" ? 0 : items.length - 1)
              : (currentIndex + (event.key === "ArrowDown" ? 1 : items.length - 1)) % items.length;
        items[nextIndex].focus({ preventScroll: true });
        if (options.contains(items[nextIndex]) && !panel.classList.contains("is-compact-height")) {
          const itemRect = items[nextIndex].getBoundingClientRect();
          const listRect = options.getBoundingClientRect();
          if (itemRect.top < listRect.top) options.scrollTop += itemRect.top - listRect.top;
          else if (itemRect.bottom > listRect.bottom) options.scrollTop += itemRect.bottom - listRect.bottom;
        } else if (panel.classList.contains("is-compact-height")) {
          const itemRect = items[nextIndex].getBoundingClientRect();
          const panelRect = panel.getBoundingClientRect();
          if (itemRect.top < panelRect.top) panel.scrollTop += itemRect.top - panelRect.top;
          else if (itemRect.bottom > panelRect.bottom) panel.scrollTop += itemRect.bottom - panelRect.bottom;
        }
      }
    };

    panel.setAttribute("aria-labelledby", triggerId);
    doc.body.append(panel);
    multiSelectPicker = { panel, anchor, rowId: row.id, fieldId: field.id, triggerId, onPointerDown, onFocusIn, onKeyDown, position };
    anchor.id = triggerId;
    anchor.setAttribute("aria-haspopup", "menu");
    anchor.setAttribute("aria-expanded", "true");
    anchor.setAttribute("aria-controls", panel.id);
    doc.addEventListener("pointerdown", onPointerDown, true);
    doc.addEventListener("focusin", onFocusIn, true);
    doc.addEventListener("keydown", onKeyDown, true);
    win?.addEventListener("resize", position);
    win?.addEventListener("scroll", position, true);
    win?.visualViewport?.addEventListener("resize", position);
    win?.visualViewport?.addEventListener("scroll", position);
    updateOptions();
    position();
    (options.querySelector<HTMLButtonElement>(".tb-multiselect-option") ?? add).focus({ preventScroll: true });
  }

  function openChoices(row: RecordRow, field: Field, anchor: HTMLButtonElement, event: MouseEvent, multiple = false): void {
    if (multiple) {
      openMultiSelectPicker(row, field, anchor);
      return;
    }
    const menu = new Menu().setUseNativeMenu(false); const current = table.records.find((item) => item.id === row.id)!.values[field.id];
    const save = (value: CellValue) => commit((next) => { next.records.find((item) => item.id === row.id)!.values[field.id] = value; }, { rowId: row.id, fieldId: field.id });
    (field.options ?? []).forEach((option) => {
      const selected = current === option.id;
      const title = anchor.ownerDocument.adoptNode(createFragment());
      const label = title.createSpan();
      label.textContent = option.label;
      title.append(label);
      menu.addItem((item) => item.setSection("super-table-choices").setTitle(title).setIcon(selected ? "check" : null).onClick(() => save(option.id)));
    });
    menu.addSeparator();
    menuAction(menu, t("Clear"), "x", () => save(""));
    menuAction(menu, t("New option…"), "plus", () => addChoiceOption(row.id, field.id, false));
    menuAction(menu, t("Edit options…"), "palette", () => editColumn(field)); showTableMenu(menu, anchor, event);
  }

  function renderMarkdownPreview(row: RecordRow, field: Field, sourceText: string, cell: HTMLTableCellElement, content: HTMLElement): void {
    if (!needsMarkdownRendering(sourceText)) {
      const lineBreaks = sourceText.match(/\r\n|\r|\n/g);
      if (!lineBreaks) { content.textContent = sourceText; return; }
      const lines = sourceText.split(/\r\n|\r|\n/);
      content.replaceChildren();
      lines.forEach((line, index) => {
        if (index > 0) content.append(el("span", "tb-markdown-line-separator", lineBreaks[index - 1]));
        content.append(el("span", "tb-markdown-plain-line", line));
      });
      return;
    }
    const restoredPreview = markdownPreviews.restore(sourceText, content);
    if (!restoredPreview) {
      content.textContent = sourceText;
      content.classList.add("is-markdown-pending");
    }
    const component = markdownLifecycle.addChild(new Component());
    markdownComponents.set(cell, component);
    const generation = markdownGeneration;
    const renderNow = () => {
      if (destroyed || generation !== markdownGeneration || markdownComponents.get(cell) !== component || !cell.isConnected) return;
      const rendered = el("div");
      void MarkdownRenderer.render(plugin.app, safeMarkdownEmbeds(sourceText), rendered, context.sourcePath, component).then(() => {
        if (destroyed || generation !== markdownGeneration || markdownComponents.get(cell) !== component || !cell.isConnected) return;
        rendered.querySelectorAll<HTMLImageElement>("img").forEach((image) => { image.loading = "lazy"; image.decoding = "async"; });
        const markers = findMarkdownTaskMarkers(sourceText);
        const taskInputs = [...rendered.querySelectorAll<HTMLInputElement>('input[type="checkbox"].task-list-item-checkbox')]
          .filter((input) => input.closest("li")?.classList.contains("task-list-item"));
        const sourceMapsCleanly = markers.length === taskInputs.length && markers.every((marker, index) => taskInputs[index].checked === marker.checked);
        if (sourceMapsCleanly) {
          const taskToggles: HTMLButtonElement[] = [];
          taskInputs.forEach((input, index) => {
            const marker = markers[index];
            const toggle = el("button", `tb-markdown-task-toggle${marker.checked ? " is-checked" : ""}`);
            toggle.type = "button"; toggle.dataset.sourceLine = String(marker.line + 1);
            toggle.setAttribute("role", "checkbox"); toggle.setAttribute("aria-checked", String(marker.checked));
            toggle.setAttribute("aria-label", t("Toggle task on line {line}", { line: marker.line + 1 }));
            toggle.onclick = async (event) => {
              event.preventDefault(); event.stopPropagation();
              if (toggle.disabled || destroyed || generation !== markdownGeneration || markdownComponents.get(cell) !== component) return;
              const currentRow = table.records.find((item) => item.id === row.id);
              const currentText = currentRow?.values[field.id];
              if (typeof currentText !== "string" || currentText !== sourceText) {
                toggle.disabled = true;
                return;
              }
              const checked = !marker.checked;
              const changed = setMarkdownTaskState(sourceText, marker, checked);
              taskToggles.forEach((item) => { item.disabled = true; });
              toggle.classList.toggle("is-checked", checked); toggle.setAttribute("aria-checked", String(checked));
              if (changed !== sourceText) await commit((next) => {
                const record = next.records.find((item) => item.id === row.id);
                if (record?.values[field.id] === sourceText) record.values[field.id] = changed;
              }, { rowId: row.id, fieldId: field.id });
            };
            taskToggles.push(toggle); input.replaceWith(toggle);
          });
        } else {
          taskInputs.forEach((input) => {
            input.disabled = true;
            input.setAttribute("aria-label", t("Task list mapping is unavailable."));
            input.setAttribute("aria-disabled", "true");
            input.onchange = null;
          });
        }
        markdownPreviews.remember(sourceText, rendered);
        content.replaceChildren(...rendered.childNodes);
        content.classList.remove("is-markdown-pending");
        scheduleLayout(cell.closest("tr") ?? undefined);
      }).catch(() => {
        if (destroyed || generation !== markdownGeneration || markdownComponents.get(cell) !== component || !cell.isConnected) return;
        if (!restoredPreview) {
          content.textContent = sourceText;
          content.classList.add("is-markdown-pending");
        }
      });
    };
    observeMarkdownContent(content, renderNow);
  }

  function renderCell(row: RecordRow, field: Field): HTMLTableCellElement {
    const first = visibleFields(table, currentView())[0]?.id === field.id;
    const cell = el("td", `tb-cell${first ? " tb-first-cell" : ""}`); cell.dataset.fieldId = field.id; cell.style.textAlign = field.align || "left";
    cell.dataset.focusKey = `cell-container:${row.id}:${field.id}`;
    cell.tabIndex = ["select", "status", "multiselect", "date", "datetime", "link", "attachment", "text", "number"].includes(field.type) ? 0 : -1;
    cell.onkeydown = (event) => {
      if (event.target !== cell || (event.key !== "Enter" && event.key !== " ")) return;
      event.preventDefault(); activateCell(cell);
      if (field.type === "text" || field.type === "number") { cellEditors.get(cell)?.(); return; }
      if (field.type === "attachment") { attachmentCells.get(cell)?.open(); return; }
      cell.querySelector<HTMLButtonElement>(".tb-cell-action")?.click();
    };
    const value = row.values[field.id];
    const save = (newValue: CellValue) => commit((next) => { next.records.find((item) => item.id === row.id)!.values[field.id] = newValue; }, { rowId: row.id, fieldId: field.id });
    if (first) {
      const grip = control("", "grip-vertical", "tb-icon-button tb-row-grip"); grip.setAttribute("aria-label", t("Click for row actions · drag to reorder"));
      grip.draggable = window.matchMedia("(pointer: fine)").matches && !currentView().sort && !currentView().group;
      grip.onclick = (event) => openRowMenu(row, grip, event);
      // The row exists after its cell is attached; resolve the target on drag start.
      grip.addEventListener("dragstart", (event) => {
        event.stopPropagation(); event.dataTransfer?.setData("text/tablebase-row", row.id);
        if (event.dataTransfer) event.dataTransfer.effectAllowed = "move";
        cell.parentElement?.classList.add("tb-dragging");
      });
      grip.addEventListener("dragend", () => { cell.parentElement?.classList.remove("tb-dragging"); clearDropIndicators(); }); cell.append(grip);
    }
    if (field.type === "checkbox") {
      const check = el("input", "tb-checkbox"); check.type = "checkbox"; check.checked = value === true; check.setAttribute("aria-label", field.name);
      check.onchange = () => void save(check.checked); cell.append(check); return cell;
    }
    if (field.type === "select" || field.type === "status") {
      const choices = el("div", "tb-choice"); choices.style.justifyContent = field.align === "center" ? "center" : field.align === "right" ? "flex-end" : "flex-start";
      let pill: HTMLElement | undefined;
      if (value) {
        const option = optionFor(field, value); pill = el("span", `tb-pill tb-color-${option?.color || "gray"}`);
        pill.append(el("span", "tb-choice-label", option?.label || String(value)));
        choices.append(pill);
      }
      cell.append(choices);
      registerCellActions(cell, () => {
        const nodes: HTMLElement[] = [];
        if (pill) {
          const clear = control("", "x", "tb-icon-button tb-choice-remove"); clear.setAttribute("aria-label", t("Clear {name}", { name: field.name }));
          clear.onclick = () => void save(""); pill.append(clear); nodes.push(clear);
        }
        const button = choiceButton(row, field, false); cell.append(button); nodes.push(button);
        return nodes;
      });
      return cell;
    }
    if (field.type === "multiselect") {
      const tags = el("div", "tb-tags"); tags.style.justifyContent = field.align === "center" ? "center" : field.align === "right" ? "flex-end" : "flex-start";
      (Array.isArray(value) ? value : []).forEach((id) => {
        const option = optionFor(field, id); const tag = el("span", `tb-pill tb-tag tb-color-${option?.color || "gray"}`); tag.append(el("span", "", option?.label ?? id));
        tags.append(tag);
      });
      cell.append(tags);
      const values = Array.isArray(value) ? [...value] : [];
      registerCellActions(cell, () => {
        const nodes: HTMLElement[] = [];
        [...tags.children].forEach((tag, index) => {
          const id = values[index]; const option = optionFor(field, id);
          const remove = control("", "x", "tb-icon-button tb-tag-remove"); remove.setAttribute("aria-label", t("Remove {name}", { name: option?.label ?? id }));
          remove.onclick = () => void save(values.filter((item) => item !== id)); tag.append(remove); nodes.push(remove);
        });
        const button = choiceButton(row, field, true); cell.append(button); nodes.push(button);
        return nodes;
      });
      return cell;
    }
    if (field.type === "text") {
      const valueText = String(value ?? "");
      const wrap = el("div", "tb-markdown-cell");
      const preview = el("div", `tb-markdown-content${valueText ? "" : " is-empty"}${/\r?\n/.test(valueText) ? " has-source-line-breaks" : ""}`);
      preview.style.textAlign = field.align || "left";
      wrap.append(preview); cell.append(wrap);
      renderMarkdownPreview(row, field, valueText, cell, preview);
      let input: HTMLTextAreaElement | null = null;
      let inputLabel: HTMLSpanElement | null = null;
      preview.onmousedown = (event) => {
        const target = event.target;
        if (input || event.detail <= 1 || (target instanceof Element && target.closest("input,textarea,select,button,[contenteditable='true']"))) return;
        event.preventDefault();
      };
      let editorKeyHandler: ((event: KeyboardEvent) => void) | null = null;
      let editorWindow: Window | null = null;
      let disposeEditing: (() => void) | null = null;
      let cancelled = false;
      const finishEditing = (saveChanges = true) => {
        if (!input) return;
        const editor = input; input = null;
        editor.onblur = null;
        if (editorKeyHandler) {
          editorWindow?.removeEventListener("keydown", editorKeyHandler, true);
          editorWindow?.removeEventListener("keyup", editorKeyHandler, true);
          editor.removeEventListener("keydown", editorKeyHandler, true);
          editor.removeEventListener("keyup", editorKeyHandler, true);
          editorKeyHandler = null;
        }
        editorWindow = null;
        if (disposeEditing) {
          textEditorDisposers.delete(disposeEditing);
          disposeEditing = null;
        }
        const nextValue = cancelled ? valueText : editor.value;
        cancelled = false;
        preview.hidden = false; editor.remove(); inputLabel?.remove(); inputLabel = null; wrap.classList.remove("is-editing"); cell.classList.remove("is-cell-editing");
        if (saveChanges && nextValue !== valueText) void save(nextValue);
      };
      const beginEditing = () => {
        if (input) return;
        const entryHeight = cell.clientHeight;
        input = el("textarea", "tb-cell-input tb-markdown-editor tb-auto-height"); input.rows = 1;
        input.value = valueText; input.style.textAlign = field.align || "left";
        input.dataset.focusKey = `cell:${row.id}:${field.id}`;
        inputLabel = hiddenAccessibleLabel(t("{name} value", { name: field.name }));
        input.setAttribute("aria-labelledby", inputLabel.id);
        input.oninput = () => scheduleLayout(cell.closest("tr") ?? undefined);
        input.onblur = () => finishEditing();
        editorKeyHandler = (event) => {
          if (event.target !== input) return;
          if (event.isComposing || event.keyCode === 229) return;
          const cancel = event.key === "Escape";
          const save = event.key === "Enter" && !event.shiftKey;
          if (!cancel && !save) return;
          event.preventDefault(); event.stopPropagation();
          if (cancel) { cancelled = true; input!.value = valueText; }
          input!.blur();
        };
        // Capture the shortcut before CodeMirror/Obsidian bubble handlers can
        // consume Cmd+Enter; the window listener also catches it before editor
        // handlers, while keyup is a fallback for capture-phase hotkeys.
        editorWindow = input.ownerDocument.defaultView;
        editorWindow?.addEventListener("keydown", editorKeyHandler, true);
        editorWindow?.addEventListener("keyup", editorKeyHandler, true);
        input.addEventListener("keydown", editorKeyHandler, true);
        input.addEventListener("keyup", editorKeyHandler, true);
        disposeEditing = () => finishEditing(false);
        textEditorDisposers.add(disposeEditing);
        preview.hidden = true; wrap.classList.add("is-editing"); cell.classList.add("is-cell-editing"); wrap.append(input, inputLabel);
        const naturalHeight = input.scrollHeight;
        const editorHeight = Math.max(entryHeight, naturalHeight);
        input.style.height = `${editorHeight}px`;
        input.style.setProperty("--tb-cell-extra-space", `${editorHeight - naturalHeight}px`);
        input.focus();
      };
      textCellEditors.set(cell, beginEditing);
      cellEditors.set(cell, beginEditing);
      registerCellActions(cell, () => [], finishEditing);
      return cell;
    }
    if (field.type === "number") {
      const valueText = String(value ?? "");
      const wrap = el("div", "tb-number-cell");
      const preview = el("div", `tb-number-preview${valueText ? "" : " is-empty"}`, valueText);
      preview.style.textAlign = field.align || "left";
      wrap.append(preview); cell.append(wrap);
      let inputLabel: HTMLSpanElement | null = null;
      let input: HTMLInputElement | null = null;
      let cancelled = false;
      const finishEditing = () => {
        if (!input) return;
        const editor = input; input = null;
        editor.onblur = null; editor.onkeydown = null;
        const nextValue = cancelled ? valueText : editor.value;
        cancelled = false;
        preview.hidden = false; editor.remove(); inputLabel?.remove(); inputLabel = null; wrap.classList.remove("is-editing");
        if (nextValue !== valueText) {
          const number = nextValue === "" ? "" : Number(nextValue);
          if (nextValue === "" || Number.isFinite(number)) void save(number);
        }
      };
      const beginEditing = () => {
        if (input) return;
        input = el("input", "tb-cell-input tb-number-editor"); input.type = "number"; input.step = "any";
        input.value = valueText; input.style.textAlign = field.align || "left";
        input.dataset.focusKey = `cell:${row.id}:${field.id}`;
        inputLabel = hiddenAccessibleLabel(t("{name} value", { name: field.name }));
        input.setAttribute("aria-labelledby", inputLabel.id);
        input.onblur = finishEditing;
        input.onkeydown = (event) => {
          if (event.isComposing || event.keyCode === 229) return;
          if (event.key === "Escape") {
            event.preventDefault(); event.stopPropagation(); cancelled = true; input?.blur();
          } else if (event.key === "Enter") {
            event.preventDefault(); event.stopPropagation(); input?.blur();
          }
        };
        preview.hidden = true; wrap.classList.add("is-editing"); wrap.append(input, inputLabel);
        input.focus();
      };
      cellEditors.set(cell, beginEditing);
      registerCellActions(cell, () => [], finishEditing);
      return cell;
    }
    if (field.type === "attachment") {
      const paths = Array.isArray(value) ? value.map(String) : [];
      const attachments = renderAttachmentCell({
        app: plugin.app, cell, paths, sourcePath: context.sourcePath, report,
        remove: (index) => commit((next) => {
          const record = next.records.find((item) => item.id === row.id);
          if (!record) return;
          const current = Array.isArray(record.values[field.id]) ? record.values[field.id] as string[] : [];
          record.values[field.id] = current.filter((path) => path !== paths[index]);
        }, { rowId: row.id, fieldId: field.id }, undefined, true),
        add: async (panelState) => {
          const reopenPanel = () => {
            if (!panelState || destroyed) return;
            const updatedCell = [...root.querySelectorAll<HTMLTableCellElement>("td.tb-cell")]
              .find((item) => item.dataset.fieldId === field.id && item.parentElement?.dataset.rowId === row.id);
            const controller = updatedCell ? attachmentCells.get(updatedCell) : undefined;
            if (!updatedCell || !controller) return;
            activateCell(updatedCell);
            controller.open(panelState);
          };
          const selected = await pickAttachments(plugin.app, context.sourcePath);
          if (!selected?.length || destroyed) { reopenPanel(); return; }
          await commit((next) => {
            const record = next.records.find((item) => item.id === row.id);
            if (!record) return;
            const current = Array.isArray(record.values[field.id]) ? record.values[field.id] as string[] : [];
            record.values[field.id] = [...new Set([...current, ...selected])];
          }, { rowId: row.id, fieldId: field.id });
          if (!destroyed) reopenPanel();
        },
      });
      attachmentCells.set(cell, attachments);
      registerCellActions(cell, () => {
        const expand = control("", "chevron-down", "tb-icon-button tb-cell-action tb-attachment-expand");
        expand.setAttribute("aria-label", t("Show attachments"));
        expand.onclick = () => attachments.open();
        cell.append(expand); return [expand];
      }, () => attachments.close());
      return cell;
    }
    if (field.type === "link") {
      cell.append(renderLink(row, field, String(value ?? ""), cell));
      let closeEditor: ((restoreFocus?: boolean) => void) | undefined;
      registerCellActions(cell, () => {
        const wrap = cell.querySelector<HTMLElement>(".tb-link");
        if (!wrap) return [];
        const edit = control("", "pencil", "tb-icon-button tb-link-edit tb-cell-action");
        const label = hiddenAccessibleLabel(t("Edit link"));
        edit.removeAttribute("aria-label"); edit.setAttribute("aria-labelledby", label.id); edit.setAttribute("aria-haspopup", "dialog");
        edit.append(label);
        edit.onclick = (event) => {
          if (event.detail > 1 && closeEditor) return;
          closeEditor = openLinkEditor(String(value ?? ""), save, cell, edit);
        };
        wrap.append(edit); return [edit];
      }, () => { closeEditor?.(); closeEditor = undefined; });
      return cell;
    }
    if (field.type === "date" || field.type === "datetime") {
      const raw = String(value ?? ""); const format = field.type === "date" ? field.dateFormat ?? "iso-date" : "iso-datetime";
      const wrap = el("div", "tb-date"); wrap.classList.toggle("is-empty", !raw);
      const label = el("span", "tb-date-label", formatDateValue(raw, format)); label.style.textAlign = field.align || "left"; wrap.append(label);
      cell.append(wrap);
      let dateInput: HTMLInputElement | null = null;
      let pickerInput: HTMLInputElement | null = null;
      let dateInputChangeHandled = false;
      registerCellActions(cell, () => {
        const edit = control("", "calendar", "tb-icon-button tb-cell-action"); edit.setAttribute("aria-label", t("Edit {name}", { name: field.name }));
        edit.onclick = () => {
          const input = el("input", "tb-cell-input tb-date-input");
          dateInput = input;
          dateInputChangeHandled = false;
          input.type = "text"; input.autocomplete = "off";
          input.value = formatDateValue(raw, format);
          input.style.textAlign = field.align || "left"; input.dataset.focusKey = `cell:${row.id}:${field.id}`;
          const inputLabel = hiddenAccessibleLabel(t("{name} value", { name: field.name }));
          const pickerLabel = hiddenAccessibleLabel(t("Choose date for {name}", { name: field.name }));
          input.setAttribute("aria-labelledby", inputLabel.id);

          const nativePicker = el("input", "tb-date-native-picker");
          pickerInput = nativePicker;
          const pickerType: "date" | "datetime-local" | "time" = format === "time" ? "time" : dateFormatHasTime(format) ? "datetime-local" : "date";
          nativePicker.type = pickerType;
          nativePicker.value = datePickerValue(raw, pickerType);
          nativePicker.tabIndex = -1; nativePicker.setAttribute("aria-hidden", "true");
          edit.removeAttribute("aria-label"); edit.setAttribute("aria-labelledby", pickerLabel.id);

          const openPicker = () => {
            try { nativePicker.showPicker(); }
            catch { try { nativePicker.click(); } catch { /* Keep the formatted text editor available without a native picker. */ } }
          };
          edit.onpointerdown = (event) => event.preventDefault();
          edit.onclick = openPicker;
          input.onchange = () => {
            const nextValue = parseDateEditorValue(input.value, format, raw);
            if (nextValue === undefined) { input.value = formatDateValue(raw, format); return; }
            if (nextValue !== raw) { dateInputChangeHandled = true; void save(nextValue); }
          };
          input.oninput = () => {
            const nextValue = parseDateEditorValue(input.value, format, raw);
            if (nextValue !== undefined) nativePicker.value = datePickerValue(nextValue, pickerType);
          };
          input.onkeydown = (event) => {
            if (event.key === "Enter") { event.preventDefault(); input.blur(); }
            else if (event.key === "Escape") { event.preventDefault(); input.value = formatDateValue(raw, format); input.blur(); }
          };
          nativePicker.onchange = () => {
            const currentTextValue = parseDateEditorValue(input.value, format, raw);
            const previous = currentTextValue === undefined ? raw : currentTextValue;
            const nextValue = dateValueFromPicker(nativePicker.value, pickerType, previous);
            if (nextValue !== raw) { dateInputChangeHandled = true; void save(nextValue); }
          };
          wrap.classList.add("is-editing"); wrap.replaceChildren(input, edit, nativePicker, inputLabel, pickerLabel); input.focus();
          openPicker();
        };
        wrap.append(edit); return [edit];
      }, () => {
        const input = dateInput;
        if (!input || !wrap.contains(input)) return;
        const parsedValue = parseDateEditorValue(input.value, format, raw);
        const nextValue = parsedValue === undefined ? raw : parsedValue;
        const shouldSave = nextValue !== raw && !dateInputChangeHandled;
        input.onchange = null; input.oninput = null; input.onkeydown = null;
        if (pickerInput) pickerInput.onchange = null;
        dateInput = null;
        pickerInput = null;
        const nextLabel = el("span", "tb-date-label", formatDateValue(nextValue, format));
        nextLabel.style.textAlign = field.align || "left";
        wrap.classList.remove("is-editing");
        wrap.replaceChildren(nextLabel);
        if (shouldSave) { dateInputChangeHandled = true; void save(nextValue); }
      });
      return cell;
    }
    const input = el("input", "tb-cell-input");
    input.type = field.type;
    input.value = String(value ?? ""); input.style.textAlign = field.align || "left";
    input.dataset.focusKey = `cell:${row.id}:${field.id}`;
    const inputLabel = hiddenAccessibleLabel(t("{name} value", { name: field.name }));
    input.setAttribute("aria-labelledby", inputLabel.id);
    input.oninput = () => {
    };
    input.onchange = () => void save(field.type === "number" && input.value !== "" && Number.isFinite(Number(input.value)) ? Number(input.value) : input.value);
    cell.append(input, inputLabel);
    return cell;
  }

  function choiceButton(row: RecordRow, field: Field, multiple: boolean): HTMLButtonElement {
    const button = control("", "chevron-down", "tb-icon-button tb-cell-action");
    button.setAttribute("aria-label", t("Choose {name}", { name: field.name }));
    if (multiple) {
      button.dataset.choiceTrigger = "true";
      button.setAttribute("aria-haspopup", "menu");
      button.setAttribute("aria-expanded", "false");
    }
    button.onclick = (event) => openChoices(row, field, button, event, multiple); return button;
  }

  function renderLink(row: RecordRow, field: Field, value: string, cell: HTMLTableCellElement): HTMLElement {
    const wrap = el("div", "tb-link"); const link = parseWebLink(value);
    wrap.classList.toggle("is-invalid", !!value.trim() && !link.href);
    const label = el("div", `tb-link-label${value ? "" : " is-empty"}`); label.style.textAlign = field.align || "left";
    const text = link.markdown ? link.label : value;
    if (link.href) {
      const anchor = el("a", "tb-link-text", text); anchor.href = link.href; anchor.title = link.title || value;
      anchor.target = "_blank"; anchor.rel = "noopener noreferrer";
      anchor.onclick = (event) => {
        event.preventDefault();
        const pending = pendingLinkOpenTimers.get(cell);
        if (pending !== undefined) window.clearTimeout(pending);
        const timer = window.setTimeout(() => {
          pendingLinkOpenTimers.delete(cell);
          if (anchor.isConnected) window.open(link.href, "_blank", "noopener,noreferrer");
        }, 350);
        pendingLinkOpenTimers.set(cell, timer);
      };
      label.append(anchor);
    } else if (text) label.append(el("span", "tb-link-text", text));
    wrap.append(label);
    return wrap;
  }

  function openLinkEditor(
    value: string, save: (value: CellValue) => Promise<unknown>,
    cell: HTMLTableCellElement, trigger: HTMLButtonElement,
  ): (restoreFocus?: boolean) => void {
    if (linkEditorClosers.size) { closeLinkEditors(); return () => {}; }
    const doc = cell.ownerDocument;
    const win = doc.defaultView;
    const initial = linkEditorFields(value);
    const title = parseWebLink(value).title;
    const panel = el("div", "tablebase-root tb-ui-surface tb-link-editor-popover");
    panel.id = makeId("tb-link-editor"); panel.setAttribute("role", "dialog");
    const heading = hiddenAccessibleLabel(t("Edit link"));
    panel.setAttribute("aria-labelledby", heading.id);
    const form = el("form", "tb-link-editor-form");
    const fields = el("div", "tb-link-editor-fields");
    const textInput = el("input", "tb-link-editor-input tb-link-editor-text");
    textInput.id = makeId("tb-link-editor-text");
    textInput.type = "text"; textInput.autocomplete = "off"; textInput.value = initial.text;
    const urlInput = el("input", "tb-link-editor-input tb-link-editor-url");
    urlInput.type = "text"; urlInput.inputMode = "url"; urlInput.setAttribute("autocomplete", "url"); urlInput.spellcheck = false; urlInput.value = initial.url;
    const textField = el("div", "tb-link-editor-field");
    const textLabel = el("label", "tb-link-editor-label", t("Text")); textLabel.htmlFor = textInput.id;
    const textControl = el("div", "tb-link-editor-text-control");
    const fetchTitle = el("button", "tb-link-editor-fetch-title");
    fetchTitle.type = "button";
    const fetchLabel = hiddenAccessibleLabel(t("Fetch link title"));
    fetchTitle.setAttribute("aria-labelledby", fetchLabel.id);
    fetchTitle.append(icon("refresh-cw", "tb-link-editor-fetch-icon"), fetchLabel);
    textControl.append(textInput, fetchTitle); textField.append(textLabel, textControl);
    const urlField = el("label", "tb-link-editor-field"); urlField.append(el("span", "tb-link-editor-label", t("URL")), urlInput);
    const actions = el("div", "tb-link-editor-actions");
    const cancel = control(t("Cancel"), undefined, "tb-link-editor-cancel"); cancel.onclick = () => close(true);
    const confirm = control(t("Confirm"), undefined, "tb-link-editor-confirm"); confirm.type = "submit";
    cancel.removeAttribute("aria-label"); confirm.removeAttribute("aria-label");
    actions.append(cancel, confirm); fields.append(textField, urlField); form.append(fields, actions); panel.append(heading, form);

    let isOpen = true;
    let isFetchingTitle = false;
    const position = () => {
      if (!isOpen) return;
      if (!cell.isConnected) { close(); return; }
      const rect = cell.getBoundingClientRect();
      const viewport = win?.visualViewport;
      const leftEdge = (viewport?.offsetLeft ?? 0) + 16;
      const topEdge = (viewport?.offsetTop ?? 0) + 16;
      const rightEdge = leftEdge + Math.max(0, (viewport?.width ?? win?.innerWidth ?? 800) - 32);
      const bottomEdge = topEdge + Math.max(0, (viewport?.height ?? win?.innerHeight ?? 600) - 32);
      panel.style.maxWidth = `${Math.max(0, rightEdge - leftEdge)}px`;
      panel.style.maxHeight = `${Math.max(0, bottomEdge - topEdge)}px`;
      const width = panel.getBoundingClientRect().width;
      panel.classList.toggle("is-stacked", width < 300);
      panel.classList.toggle("is-actions-stacked", width < 210);
      const size = panel.getBoundingClientRect();
      const left = Math.max(leftEdge, Math.min(rect.left, rightEdge - size.width));
      const below = rect.bottom + 8;
      const top = below + size.height <= bottomEdge ? below : rect.top - size.height - 8;
      panel.style.left = `${left}px`;
      panel.style.top = `${Math.max(topEdge, Math.min(top, bottomEdge - size.height))}px`;
    };
    const close = (restoreFocus = false) => {
      if (!isOpen) return;
      isOpen = false; panel.remove();
      trigger.setAttribute("aria-expanded", "false"); trigger.removeAttribute("aria-controls");
      doc.removeEventListener("pointerdown", outside, true);
      doc.removeEventListener("focusin", outsideFocus);
      doc.removeEventListener("keydown", escape, true);
      win?.removeEventListener("resize", position);
      win?.removeEventListener("scroll", position, true);
      win?.visualViewport?.removeEventListener("resize", position);
      win?.visualViewport?.removeEventListener("scroll", position);
      linkEditorClosers.delete(close);
      if (restoreFocus && !destroyed && trigger.isConnected) trigger.focus({ preventScroll: true });
    };
    function outside(event: Event): void {
      const target = event.target as Node | null;
      if (target && !cell.contains(target) && !panel.contains(target)) close();
    }
    function outsideFocus(event: FocusEvent): void { outside(event); }
    function escape(event: KeyboardEvent): void {
      if (event.key !== "Escape" || event.defaultPrevented) return;
      event.preventDefault(); event.stopPropagation(); close(true);
    }
    const syncInvalid = () => {
      const isValidUrl = !!parseWebLink(urlInput.value).href;
      panel.classList.toggle("is-invalid", !!urlInput.value.trim() && !isValidUrl);
      fetchTitle.disabled = isFetchingTitle || !isValidUrl;
    };
    const loadLinkTitle = async () => {
      if (isFetchingTitle) return;
      const href = parseWebLink(urlInput.value).href;
      if (!href) { syncInvalid(); return; }
      const originalText = textInput.value;
      isFetchingTitle = true;
      fetchTitle.classList.add("is-loading");
      fetchTitle.setAttribute("aria-busy", "true");
      fetchLabel.textContent = t("Fetching link title…");
      syncInvalid();
      try {
        const title = await fetchLinkPageTitle(href);
        if (isOpen && parseWebLink(urlInput.value).href === href && textInput.value === originalText) textInput.value = title;
      } catch {
        if (isOpen && parseWebLink(urlInput.value).href === href) new Notice(t("Could not fetch link title."));
      } finally {
        isFetchingTitle = false;
        fetchTitle.classList.remove("is-loading");
        fetchTitle.removeAttribute("aria-busy");
        fetchLabel.textContent = t("Fetch link title");
        if (isOpen) syncInvalid();
      }
    };
    fetchTitle.onclick = () => { void loadLinkTitle(); };
    urlInput.oninput = syncInvalid;
    form.onsubmit = (event) => {
      event.preventDefault();
      if (textInput.value === initial.text && urlInput.value === initial.url) { close(true); return; }
      const next = serializeWebLink(textInput.value, urlInput.value, title);
      close();
      if (next !== value) void save(next);
    };
    trigger.setAttribute("aria-expanded", "true"); trigger.setAttribute("aria-controls", panel.id);
    doc.body.append(panel);
    linkEditorClosers.add(close);
    doc.addEventListener("pointerdown", outside, true);
    doc.addEventListener("focusin", outsideFocus);
    doc.addEventListener("keydown", escape, true);
    win?.addEventListener("resize", position);
    win?.addEventListener("scroll", position, true);
    win?.visualViewport?.addEventListener("resize", position);
    win?.visualViewport?.addEventListener("scroll", position);
    position(); textInput.focus({ preventScroll: true }); textInput.select(); syncInvalid();
    return close;
  }

  const isTextControl = (target: EventTarget | null) => {
    if (!(target instanceof Element)) return false;
    const control = target.closest("input, textarea, select, [contenteditable='true']");
    return !!control && root.contains(control);
  };
  const activeCellPasteSelection = () => {
    if (!activeCell || !activeCellElement?.isConnected || !activeCellElement.classList.contains("is-cell-active")) return undefined;
    const field = table.fields.find((item) => item.id === activeCell!.fieldId);
    const row = table.records.find((item) => item.id === activeCell!.rowId);
    return field && row ? { rowId: row.id, fieldId: field.id, type: field.type } : undefined;
  };
  const activeAttachmentPopoverPasteSelection = (target: EventTarget | null) => {
    if (!activeCell || !activeCellElement?.isConnected || activeCellElement.getAttribute("aria-expanded") !== "true") return undefined;
    const field = table.fields.find((item) => item.id === activeCell!.fieldId);
    const row = table.records.find((item) => item.id === activeCell!.rowId);
    if (field?.type !== "attachment" || !row) return undefined;
    const panelId = activeCellElement.getAttribute("aria-controls");
    const panel = panelId ? root.ownerDocument.getElementById(panelId) : null;
    const targetNode = target instanceof Node ? target : null;
    const focusedElement = root.ownerDocument.activeElement;
    const eventIsInPanel = !!panel?.classList.contains("tb-attachment-popover") &&
      ((targetNode !== null && panel.contains(targetNode)) || (focusedElement instanceof Node && panel.contains(focusedElement)));
    return eventIsInPanel ? { rowId: row.id, fieldId: field.id } : undefined;
  };
  const activeCellClipboard = () => cellClipboard;
  const hasOpenTablePopup = () => openTableMenus.size > 0 ||
    !!root.ownerDocument.querySelector(".tb-multiselect-picker, .tb-link-editor-popover, .tb-attachment-popover, .tb-dialog, .tb-image-preview-modal");
  const hasOpenCellPopover = () => !!root.ownerDocument.querySelector(".tb-multiselect-picker, .tb-link-editor-popover, .tb-attachment-popover, .tb-image-preview-modal");
  const isEditorSurfaceEvent = (target: EventTarget | null): boolean => {
    if (!(target instanceof Node)) return false;
    const doc = root.ownerDocument;
    const focused = doc.activeElement;
    const selection = doc.getSelection();
    // CodeMirror owns the whole note surface. Only a DOM selection inside this
    // widget can stand in for table focus; a note caret must remain with Obsidian.
    if (!selection?.anchorNode || !selection.focusNode ||
        !root.contains(selection.anchorNode) || !root.contains(selection.focusNode)) return false;
    const livePreviewEditor = root.closest<HTMLElement>(".cm-editor");
    if (livePreviewEditor && focused instanceof Node && livePreviewEditor.contains(focused) && livePreviewEditor.contains(target)) return true;
    return focused instanceof HTMLElement &&
      (focused.isContentEditable || focused.getAttribute("contenteditable") === "true") &&
      focused.contains(root) && (focused === target || focused.contains(target));
  };
  const copyFocusedCell = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    if (key !== "c" || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey || hasOpenTablePopup()) return;
    const selection = activeCell;
    const cell = activeCellElement;
    if (!selection || !cell?.isConnected || !cell.classList.contains("is-cell-active")) return;

    const doc = root.ownerDocument;
    const focused = doc.activeElement;
    const target = event.target instanceof Element ? event.target : null;
    const focusWithinCell = focused === cell || focused instanceof Node && cell.contains(focused);
    const editorSurfaceFocused = isEditorSurfaceEvent(event.target);
    const targetWithinCell = !!target && cell.contains(target);
    if ((!focusWithinCell && !editorSurfaceFocused) ||
        targetWithinCell && isTextControl(target) ||
        !targetWithinCell && !editorSurfaceFocused) return;

    const field = table.fields.find((item) => item.id === selection.fieldId);
    const row = table.records.find((item) => item.id === selection.rowId);
    if (!field || !row) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const value = row.values[field.id];
    const text = fieldToText(field, value);
    cellClipboard = { type: field.type, value: cloneValue(value), text, options: (field.options ?? []).map((option) => ({ ...option })) };
    void writeClipboard(text).catch(() => { /* Cell copy stays separate from the internal row clipboard. */ });
  };
  const clearFocusedCell = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    if ((key !== "backspace" && key !== "delete") || event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
    const selection = activeCell;
    const cell = activeCellElement;
    if (!selection || !cell?.isConnected || !cell.classList.contains("is-cell-active") ||
        event.target !== cell || root.ownerDocument.activeElement !== cell || hasOpenTablePopup()) return;
    const field = table.fields.find((item) => item.id === selection.fieldId);
    const row = table.records.find((item) => item.id === selection.rowId);
    if (!field || !row) return;

    // macOS reports its Delete key as Backspace; Windows reports Delete.
    // Capture this before Obsidian's editor keymaps can delete note content.
    event.preventDefault();
    event.stopImmediatePropagation();
    const emptyValue = defaultCell(field.type);
    const currentValue = row.values[field.id];
    const alreadyEmpty = Array.isArray(emptyValue) && Array.isArray(currentValue)
      ? currentValue.length === 0
      : currentValue === emptyValue;
    if (!alreadyEmpty) void commit((next) => {
      const record = next.records.find((item) => item.id === row.id);
      if (record) record.values[field.id] = emptyValue;
    }, { rowId: row.id, fieldId: field.id });
  };
  const applyEditorHistory = (view: MarkdownView, isUndo: boolean) => {
    const doc = root.ownerDocument;
    const editorHost = root.closest(".cm-editor") ?? view.containerEl;
    const selectedCell = activeCell;
    const restoreFocus = () => {
      // Undo can replace the entire widget and leave focus on body. Keep the
      // next redo in the same note, without stealing focus from another control.
      if (!editorHost.isConnected || plugin.app.workspace?.getActiveViewOfType?.(MarkdownView)?.file?.path !== context.sourcePath ||
          doc.activeElement !== doc.body && doc.activeElement !== doc.documentElement) return;
      const replacement = [...editorHost.querySelectorAll<HTMLElement>(".tablebase-root[data-table-id]")]
        .find((candidate) => candidate.dataset.tableId === table.tableId);
      const cell = selectedCell && replacement && [...replacement.querySelectorAll<HTMLElement>("td.tb-cell")]
        .find((candidate) => candidate.dataset.fieldId === selectedCell.fieldId && candidate.parentElement?.dataset.rowId === selectedCell.rowId);
      if (replacement) (cell || replacement).focus({ preventScroll: true });
      else view.editor.focus?.();
    };
    const viewportRestoration = preserveNoteViewportScroll(plugin.app, context.sourcePath, root, activeCellElement, !!context.save, { history: true });
    try { if (isUndo) view.editor.undo(); else view.editor.redo(); }
    finally {
      restoreFocus();
      doc.defaultView?.requestAnimationFrame(restoreFocus);
      viewportRestoration?.finish();
    }
  };
  const keys = (event: KeyboardEvent) => {
    if (event.defaultPrevented) return;
    const key = event.key.toLowerCase();
    const modifier = event.metaKey || event.ctrlKey;
    const isUndo = modifier && !event.altKey && key === "z" && !event.shiftKey;
    const isRedo = modifier && !event.altKey && (key === "z" && event.shiftKey || event.ctrlKey && key === "y");
    const target = event.target instanceof Element ? event.target : null;
    const cellInput = target?.closest("input, textarea, select, [contenteditable='true']");
    if ((isUndo || isRedo) && cellInput && root.contains(cellInput)) {
      // Let the focused table input perform its own native text undo/redo.
      // Stop the shortcut before it bubbles into CodeMirror's note editor.
      event.stopPropagation();
      return;
    }
    if (!hasOpenTablePopup() && target && root.contains(target) && (isUndo || isRedo) && !cellInput) {
      const view = plugin.app.workspace?.getActiveViewOfType?.(MarkdownView);
      if (view?.file?.path === context.sourcePath) {
        const direction = isUndo ? "undo" : "redo";
        if (context.save) {
          // Live Preview renders the table inside a CodeMirror widget, whose DOM events
          // are ignored by CodeMirror. Route history shortcuts back to Obsidian's editor.
          event.preventDefault(); event.stopPropagation();
          applyEditorHistory(view, isUndo);
        } else if (view.getMode() === "preview") {
          if (hasReadingViewTableHistory(context.sourcePath, direction)) {
            event.preventDefault(); event.stopPropagation();
            const restoreTableFocus = root.contains(root.ownerDocument.activeElement) || root.contains(target);
            const viewportRestoration = preserveNoteViewportScroll(plugin.app, context.sourcePath, root, activeCellElement, false, { history: true });
            if (restoreTableFocus) requestReadingViewFocus();
            void applyReadingViewTableHistory(plugin, context.sourcePath, direction).then((body) => {
              if (!body || destroyed) return;
              const restored = readTable(body);
              if (restored.tableId !== table.tableId) return;
              table = restored; expectedBody = body; render();
              if (restoreTableFocus && !root.contains(root.ownerDocument.activeElement)) root.focus({ preventScroll: true });
            }).catch(showSaveError).finally(() => viewportRestoration?.finish());
          }
        } else if (activeCell && activeCellElement?.isConnected && activeCellElement.contains(target)) {
          event.preventDefault(); event.stopPropagation();
          applyEditorHistory(view, isUndo);
        }
      }
      return;
    }
    if (isTextControl(event.target) || hasOpenTablePopup() || !(event.metaKey || event.ctrlKey) || event.altKey || event.shiftKey) return;
    if (key === "c" && selected().length) { event.preventDefault(); copyRows(selected()); }
    // Paste needs the actual ClipboardEvent data: keydown cannot tell whether
    // the OS clipboard still contains the internally copied rows.
  };
  const onWindowShortcutSuppression = (event: KeyboardEvent) => {
    const key = event.key.toLowerCase();
    const isHistoryShortcut = (event.metaKey || event.ctrlKey) && !event.altKey &&
      (key === "z" || event.ctrlKey && key === "y");
    if (event.defaultPrevented && !isHistoryShortcut) return;
    const target = event.target instanceof Element ? event.target : null;
    const isUndo = key === "z" && !event.shiftKey;
    const isRedo = key === "z" && event.shiftKey || event.ctrlKey && key === "y";
    const readingView = plugin.app.workspace?.getActiveViewOfType?.(MarkdownView);
    const editableTarget = target?.closest("input, textarea, select, [contenteditable='true']");
    const editableTableControl = !!editableTarget && (root.contains(editableTarget) || hasOpenTablePopup());
    const nativeInput = editableTarget?.matches("input, textarea") &&
      (root.contains(editableTarget) || editableTarget.closest(".tb-dialog, .tb-link-editor-popover, .tb-multiselect-picker, .tb-attachment-popover"));
    if (isHistoryShortcut && isRedo && nativeInput && root.ownerDocument.activeElement === editableTarget) {
      // The host's redo hotkey can suppress Chromium's native input redo even
      // though undo works. Keep the redo command in the focused text control.
      event.preventDefault(); event.stopImmediatePropagation();
      root.ownerDocument.execCommand("redo");
      return;
    }
    const focusWithinTable = root.contains(root.ownerDocument.activeElement);
    const targetWithinTable = !!target && root.contains(target);
    const activeHeaderElement = activeHeaderId && [...root.querySelectorAll<HTMLTableCellElement>("th.tb-header-cell")]
      .find((header) => header.dataset.fieldId === activeHeaderId && header.classList.contains("is-header-active"));
    const editorSurfaceSelection = activeCellElement?.isConnected && root.contains(activeCellElement) &&
      activeCellElement.classList.contains("is-cell-active") || !!activeHeaderElement;
    const editorSurfaceEvent = isEditorSurfaceEvent(event.target) && editorSurfaceSelection;
    if (isHistoryShortcut && context.save && (targetWithinTable || focusWithinTable || editorSurfaceEvent) && !editableTableControl &&
        !hasOpenTablePopup() && readingView?.file?.path === context.sourcePath) {
      // Live Preview reports the surrounding contenteditable as the event target
      // for a focused widget. Route that shortcut to Obsidian's editor history.
      event.preventDefault(); event.stopImmediatePropagation();
      applyEditorHistory(readingView, isUndo);
      return;
    }
    if (isHistoryShortcut && !editableTableControl && !hasOpenTablePopup() && readingView?.getMode() === "preview" &&
        readingView.file?.path === context.sourcePath && (targetWithinTable || focusWithinTable) &&
        hasRecentReadingViewTableWrite(context.sourcePath) &&
        hasReadingViewTableHistory(context.sourcePath, isUndo ? "undo" : "redo")) {
      event.preventDefault(); event.stopImmediatePropagation();
      const restoreTableFocus = targetWithinTable || focusWithinTable;
      const viewportRestoration = preserveNoteViewportScroll(plugin.app, context.sourcePath, root, activeCellElement, false, { history: true });
      if (restoreTableFocus) requestReadingViewFocus();
      void applyReadingViewTableHistory(plugin, context.sourcePath, isUndo ? "undo" : "redo").then((body) => {
        if (!body || destroyed) return;
        const restored = readTable(body);
        if (restored.tableId !== table.tableId) return;
        table = restored; expectedBody = body; render();
        if (restoreTableFocus && !root.contains(root.ownerDocument.activeElement)) root.focus({ preventScroll: true });
      }).catch(showSaveError).finally(() => viewportRestoration?.finish());
      return;
    }
    if (isHistoryShortcut && hasOpenTablePopup() && !editableTarget) {
      // Keep non-editable popup controls from undoing the note behind them.
      event.stopImmediatePropagation();
    }
  };
  const addPastedImageToAttachment = async (image: File, selection: { rowId: string; fieldId: string }, keepPanelOpen = false): Promise<void> => {
    const fileName = pastedImageFileName(image.name, image.type);
    try {
      const settings = (plugin as Plugin & { superTableSettings?: SuperTableSettings }).superTableSettings;
      const location = settings?.attachmentImagePasteLocation ?? "obsidian";
      const data = await image.arrayBuffer();
      let imported: TFile;
      if (location === "note-folder") {
        const folder = noteNamedAttachmentFolder(context.sourcePath);
        await ensureAttachmentFolder(plugin.app, folder);
        imported = await createUniqueAttachmentFile(plugin.app, folder, fileName, data);
      } else {
        imported = await createObsidianAttachmentFile(plugin.app, context.sourcePath, fileName, data);
      }
      const saved = await commit((next) => {
        const record = next.records.find((item) => item.id === selection.rowId);
        const field = next.fields.find((item) => item.id === selection.fieldId && item.type === "attachment");
        if (!record || !field) return;
        const current = Array.isArray(record.values[field.id]) ? (record.values[field.id] as string[]).map(String) : [];
        if (!current.includes(imported.path)) current.push(imported.path);
        record.values[field.id] = current;
      }, selection);
      const savedRow = table.records.find((item) => item.id === selection.rowId);
      const savedValue = savedRow?.values[selection.fieldId];
      if (saved && keepPanelOpen && !destroyed && Array.isArray(savedValue) && savedValue.includes(imported.path)) {
        const updatedCell = [...root.querySelectorAll<HTMLTableCellElement>("td.tb-cell")]
          .find((cell) => cell.dataset.fieldId === selection.fieldId && cell.parentElement?.dataset.rowId === selection.rowId);
        if (updatedCell) {
          activateCell(updatedCell);
          attachmentCells.get(updatedCell)?.open();
        }
      }
    } catch (error) {
      new Notice(t("Could not import {name}: {message}", { name: fileName, message: errorMessage(error) }));
    }
  };
  const paste = (event: ClipboardEvent) => {
    const targetElement = event.target instanceof Element ? event.target : null;
    const editableTarget = targetElement?.closest("input, textarea, select, [contenteditable='true']");
    // The surrounding CodeMirror contenteditable is not a table input.
    if (editableTarget && !editableTarget.contains(root)) return;
    const attachmentPopoverSelection = activeAttachmentPopoverPasteSelection(event.target);
    const popoverImage = attachmentPopoverSelection ? clipboardImageFile(event.clipboardData) : null;
    if (attachmentPopoverSelection && popoverImage) {
      event.preventDefault();
      event.stopImmediatePropagation();
      void addPastedImageToAttachment(popoverImage, attachmentPopoverSelection, true);
      return;
    }
    if (hasOpenTablePopup()) return;
    const target = event.target instanceof Node ? event.target : null;
    const focusedElement = root.ownerDocument.activeElement;
    const tableFocused = focusedElement instanceof Node && root.contains(focusedElement);
    const tableTarget = target !== null && root.contains(target);
    if (!(tableFocused && tableTarget) && !isEditorSurfaceEvent(event.target)) return;
    const cellPaste = activeCellPasteSelection();
    if (cellPaste) {
      event.preventDefault();
      event.stopImmediatePropagation();
      if (!event.clipboardData) return;
      const field = table.fields.find((item) => item.id === cellPaste.fieldId);
      const copiedCell = activeCellClipboard();
      if (!field) return;
      if (field.type === "attachment") {
        const image = clipboardImageFile(event.clipboardData);
        if (image) { void addPastedImageToAttachment(image, cellPaste); return; }
      }
      const text = event.clipboardData.getData("text/plain");
      if (!copiedCell && rowClipboard && rowClipboardText === text) {
        if (rowClipboard.rows.length === 1) void confirmPasteRowIntoRow(cellPaste.rowId, rowClipboard);
        else new Notice(t("Use Paste {count} rows in the toolbar to paste these rows.", { count: rowClipboard.rows.length }));
        return;
      }
      if (copiedCell && copiedCell.text === text) {
        const compatible = field.type === copiedCell.type ||
          ["select", "status"].includes(field.type) && ["select", "status"].includes(copiedCell.type);
        if (!compatible) return;
        void commit((next) => {
          const row = next.records.find((item) => item.id === cellPaste.rowId);
          const targetField = next.fields.find((item) => item.id === cellPaste.fieldId);
          if (!row || !targetField) return;
          let value = cloneValue(copiedCell.value);
          if (["select", "status", "multiselect"].includes(targetField.type)) {
            const sourceValues = Array.isArray(copiedCell.value) ? copiedCell.value : [copiedCell.value];
            const labels = sourceValues.map((id) => copiedCell.options.find((option) => option.id === String(id ?? ""))?.label ?? String(id ?? ""));
            value = targetField.type === "multiselect" ? valueFromLabel(targetField, labels) : labels[0] ? valueFromLabel(targetField, labels) : "";
          }
          row.values[cellPaste.fieldId] = cloneValue(value);
        }, cellPaste);
      } else if (cellPaste.type === "text" && text !== "") {
        void commit((next) => {
          const row = next.records.find((item) => item.id === cellPaste.rowId);
          if (row) row.values[cellPaste.fieldId] = text;
        }, cellPaste);
      } else if (cellPaste.type === "number") {
        const value = text.trim();
        if (value && !/[\r\n\t]/.test(value) && /^[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:e[+-]?\d+)?$/i.test(value)) {
          const number = Number(value);
          if (Number.isFinite(number)) void commit((next) => {
            const row = next.records.find((item) => item.id === cellPaste.rowId);
            if (row) row.values[cellPaste.fieldId] = number;
          }, cellPaste);
        }
      } else if (cellPaste.type === "link") {
        const value = text.trim();
        if (value && !/[\t\r\n]/.test(value)) void commit((next) => {
          const row = next.records.find((item) => item.id === cellPaste.rowId);
          if (row) row.values[cellPaste.fieldId] = value;
        }, cellPaste);
      }
      return;
    }
    if (isTextControl(event.target)) return;
    const text = event.clipboardData?.getData("text/plain");
    if (text !== undefined && text !== "") {
      // External row import is suspended; consume table-owned pastes so the host editor cannot insert them into the note.
      event.preventDefault(); event.stopImmediatePropagation();
      if (rowClipboard && rowClipboardText === text) void pasteInternal(true);
    }
  };
  root.addEventListener("keydown", keys);
  // The editor surface may own focus while a Live Preview table cell is selected.
  root.ownerDocument.defaultView?.addEventListener("keydown", copyFocusedCell, true);
  // Live Preview may route a paste through its contenteditable editor surface.
  // Capture it before the editor handles the event so a selected cell can own it.
  root.ownerDocument.defaultView?.addEventListener("paste", paste, true);
  const isCellControlTarget = (cell: HTMLTableCellElement, target: Element): boolean => {
    // Links in text cells are Markdown content, not cell controls. Keep actual
    // controls such as task checkboxes interactive.
    const selector = textCellEditors.has(cell)
      ? "input,textarea,select,button,[contenteditable='true']"
      : "input,textarea,select,button,a,[contenteditable='true']";
    const interactiveElement = target.closest(selector);
    return !!interactiveElement && cell.contains(interactiveElement);
  };
  const onDocumentPointerDown = (event: PointerEvent) => {
    pointerDownWasCellControl = false;
    const target = event.target;
    if (!(target instanceof Element) || !target.closest(".tablebase-root")) clearRecentReadingViewTableWrite();
    const targetNode = target instanceof Node ? target : null;
    if (!targetNode || !root.contains(targetNode)) pendingTableFocus.get(root.ownerDocument)?.delete(tableKey);
    if (targetNode && root.contains(targetNode) &&
        (hasReadingViewTableHistory(context.sourcePath, "undo") || hasReadingViewTableHistory(context.sourcePath, "redo"))) {
      const view = plugin.app.workspace?.getActiveViewOfType?.(MarkdownView);
      if (view?.file?.path === context.sourcePath && view.getMode() === "preview") markRecentReadingViewTableWrite(context.sourcePath);
    }
    const isCellPopover = target instanceof Element && !!target.closest(".tb-multiselect-picker, .tb-link-editor-popover, .tb-attachment-popover");
    if (activeCellElement && !activeCellElement.contains(targetNode) && !isCellPopover) clearActiveCell();
    const headerName = target instanceof Element ? target.closest<HTMLTextAreaElement>("textarea.tb-field-name") : null;
    const header = headerName?.closest<HTMLTableCellElement>("th.tb-header-cell");
    if (headerName && header && root.contains(headerName)) {
      pointerDownHeaderId = header.dataset.fieldId ?? null;
      pointerDownHeaderWasActive = pointerDownHeaderId !== null && activeHeaderId === pointerDownHeaderId;
      pointerDownCell = null; pointerDownWillEditCell = false; pointerDownWillOpenAttachments = false;
      lastPointerEditableCell = null;
      return;
    }
    pointerDownHeaderId = null; pointerDownHeaderWasActive = false;
    const cell = target instanceof Element ? target.closest<HTMLTableCellElement>("td.tb-cell") : null;
    if (!cell || !root.contains(cell) || target instanceof Element && target.closest(".tb-row-grip")) {
      lastPointerEditableCell = null; pointerDownCell = null; pointerDownWillEditCell = false; pointerDownWillOpenAttachments = false;
      return;
    }
    const isCellControl = target instanceof Element && isCellControlTarget(cell, target);
    pointerDownCell = cell;
    pointerDownWasCellControl = isCellControl;
    pointerDownWillOpenAttachments = attachmentCells.has(cell) && !isCellControl && activeCellElement === cell;
    pointerDownWillEditCell = cellEditors.has(cell) && !isCellControl && lastPointerEditableCell === cell && activeCellElement === cell;
    if (!pointerDownWillEditCell) lastPointerEditableCell = null;
  };
  const onDocumentFocusIn = (event: FocusEvent) => {
    if (event.target instanceof Element && event.target !== root.ownerDocument.body &&
        event.target !== root.ownerDocument.documentElement && !root.contains(event.target) && !event.target.contains(root) &&
        event.target.closest<HTMLElement>(".tablebase-root[data-table-id]")?.dataset.tableId !== table.tableId) {
      pendingTableFocus.get(root.ownerDocument)?.delete(tableKey);
    }
    if (!activeCellElement) return;
    const target = event.target;
    const targetNode = target instanceof Node ? target : null;
    if (targetNode && activeCellElement.contains(targetNode)) {
      activeCellElement.classList.add("is-cell-active");
      return;
    }
    if (target instanceof Element && target.closest(".tb-multiselect-picker, .tb-link-editor-popover, .tb-attachment-popover, .tb-image-preview-modal")) {
      clearActiveCellAppearance();
      return;
    }
    const cell = activeCellElement;
    if (hasOpenCellPopover()) {
      clearActiveCellAppearance();
      root.ownerDocument.defaultView?.setTimeout(() => {
        if (activeCellElement !== cell || !cell?.isConnected) return;
        const focused = root.ownerDocument.activeElement;
        if (focused instanceof Node && cell.contains(focused)) { cell.classList.add("is-cell-active"); return; }
        if (hasOpenCellPopover()) { clearActiveCellAppearance(); return; }
        clearActiveCell();
      }, 0);
      return;
    }
    root.ownerDocument.defaultView?.setTimeout(() => {
      if (activeCellElement !== cell || !cell?.isConnected) return;
      const focused = root.ownerDocument.activeElement;
      if (focused instanceof Node && cell.contains(focused)) { cell.classList.add("is-cell-active"); return; }
      if (focused instanceof Element && focused.closest(".tb-multiselect-picker, .tb-link-editor-popover, .tb-attachment-popover, .tb-image-preview-modal")) {
        clearActiveCellAppearance();
        return;
      }
      clearActiveCell();
    }, 0);
  };
  const onDocumentFocusOut = (event: FocusEvent) => {
    const cell = activeCellElement;
    const target = event.target;
    if (!cell || !(target instanceof Node) || !cell.contains(target)) return;
    const related = event.relatedTarget;
    if (related instanceof Node && cell.contains(related)) return;
    if (related instanceof Element && related.closest(".tb-multiselect-picker, .tb-link-editor-popover, .tb-attachment-popover, .tb-image-preview-modal")) {
      clearActiveCellAppearance();
      return;
    }
    root.ownerDocument.defaultView?.queueMicrotask(() => {
      if (activeCellElement !== cell || !cell.isConnected) return;
      const focused = root.ownerDocument.activeElement;
      if (focused instanceof Node && cell.contains(focused)) return;
      if (focused instanceof Element && focused.closest(".tb-multiselect-picker, .tb-link-editor-popover, .tb-attachment-popover, .tb-image-preview-modal")) {
        clearActiveCellAppearance();
        return;
      }
      clearActiveCell();
    });
  };
  const selectCell = (event: Event) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest(".tb-row-grip")) return;
    const headerName = target.closest<HTMLTextAreaElement>("textarea.tb-field-name");
    const header = headerName?.closest<HTMLTableCellElement>("th.tb-header-cell");
    if (headerName && header && root.contains(headerName)) {
      const fieldId = header.dataset.fieldId;
      if (!fieldId) return;
      if (event.type === "focusin") {
        if (pointerDownHeaderId !== fieldId) activateHeader(fieldId, header);
        return;
      }
      if (event.type === "click") {
        const wasActive = pointerDownHeaderId === fieldId ? pointerDownHeaderWasActive : activeHeaderId === fieldId;
        const isDoubleClick = (event as MouseEvent).detail > 1;
        pointerDownHeaderId = null; pointerDownHeaderWasActive = false;
        pointerDownCell = null; pointerDownWillEditCell = false; pointerDownWillOpenAttachments = false;
        lastPointerEditableCell = null;
        if (wasActive && headerName.readOnly && !isDoubleClick) editHeaderName(fieldId, header, headerName);
        else activateHeader(fieldId, header);
      }
      return;
    }
    const cell = target.closest<HTMLTableCellElement>("td.tb-cell"); if (!cell || !root.contains(cell)) return;
    // Live Preview wraps the whole table in a contenteditable editor; cell controls
    // suppress repeat-click editing, while Markdown links remain editable content.
    const isCellControl = isCellControlTarget(cell, target);
    const pointerClick = event.type === "click" && pointerDownCell === cell;
    if (pointerClick && pointerDownWasCellControl && !isCellControl) {
      // A drag from an editor to its cell edge retargets click to their common
      // ancestor. Focusing the cell here would blur the editor and discard selection.
      pointerDownCell = null; pointerDownWasCellControl = false;
      pointerDownWillEditCell = false; pointerDownWillOpenAttachments = false; lastPointerEditableCell = null;
      event.preventDefault(); event.stopPropagation();
      return;
    }
    if (pointerClick && pointerDownWillEditCell && activeCellElement === cell && cellEditors.has(cell) && !isCellControl) {
      pointerDownCell = null; pointerDownWillEditCell = false; lastPointerEditableCell = null;
      event.preventDefault(); event.stopPropagation();
      cellEditors.get(cell)?.();
      return;
    }
    if (event.type === "click" && !isCellControl && attachmentCells.has(cell) &&
        (pointerClick ? pointerDownWillOpenAttachments : activeCellElement === cell)) {
      event.preventDefault(); event.stopPropagation();
      pointerDownCell = null; pointerDownWillOpenAttachments = false;
      attachmentCells.get(cell)?.open();
      return;
    }
    if (event.type === "click") {
      pointerDownWillOpenAttachments = false;
      lastPointerEditableCell = pointerClick && cellEditors.has(cell) && !isCellControl ? cell : null;
      pointerDownCell = null; pointerDownWillEditCell = false;
    }
    activateCell(cell);
    if (event.type === "click" && !target.closest("input,textarea,button,a")) cell.focus({ preventScroll: true });
  };
  const editCellOnDoubleClick = (event: MouseEvent) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest(".tb-row-grip")) return;
    const headerName = target.closest<HTMLTextAreaElement>("textarea.tb-field-name");
    const header = headerName?.closest<HTMLTableCellElement>("th.tb-header-cell");
    if (headerName && header && root.contains(headerName)) {
      const fieldId = header.dataset.fieldId;
      if (!fieldId) return;
      event.preventDefault(); event.stopPropagation();
      editHeaderName(fieldId, header, headerName);
      const collapseSelection = () => {
        if (editingHeaderId !== fieldId || !headerName.isConnected || headerName.ownerDocument.activeElement !== headerName) return;
        const caret = headerName.selectionEnd;
        headerName.setSelectionRange(caret, caret);
      };
      collapseSelection();
      headerName.ownerDocument.defaultView?.requestAnimationFrame(collapseSelection);
      return;
    }
    const cell = target.closest<HTMLTableCellElement>("td.tb-cell");
    if (!cell || !root.contains(cell)) return;
    const field = table.fields.find((item) => item.id === cell.dataset.fieldId);
    if (field?.type === "link") {
      event.preventDefault(); event.stopPropagation();
      const pending = pendingLinkOpenTimers.get(cell);
      if (pending !== undefined) window.clearTimeout(pending);
      pendingLinkOpenTimers.delete(cell);
      pointerDownCell = null; pointerDownWillEditCell = false; pointerDownWillOpenAttachments = false; lastPointerEditableCell = null;
      activateCell(cell);
      if (!target.closest(".tb-link-edit")) cell.querySelector<HTMLButtonElement>(".tb-link-edit")?.click();
      return;
    }
    if ((!cellEditors.has(cell) && !attachmentCells.has(cell)) || isCellControlTarget(cell, target)) return;
    event.preventDefault(); event.stopPropagation();
    lastPointerEditableCell = null; pointerDownCell = null; pointerDownWillEditCell = false;
    activateCell(cell);
    if (attachmentCells.has(cell)) attachmentCells.get(cell)?.open();
    else cellEditors.get(cell)?.();
  };
  root.ownerDocument.addEventListener("pointerdown", onDocumentPointerDown, true);
  root.ownerDocument.addEventListener("focusin", onDocumentFocusIn, true);
  root.ownerDocument.addEventListener("focusout", onDocumentFocusOut, true);
  root.ownerDocument.addEventListener("dblclick", editCellOnDoubleClick, true);
  root.ownerDocument.defaultView?.addEventListener("keydown", clearFocusedCell, true);
  root.ownerDocument.defaultView?.addEventListener("keydown", onWindowShortcutSuppression, true);
  root.addEventListener("click", selectCell, true); root.addEventListener("focusin", selectCell);
  const displayConfigSession: DisplayConfigSession = {
    trigger() { return root.querySelector<HTMLButtonElement>(".tb-display-config-trigger"); },
    snapshot(viewId) {
      const view = table.views.find((item) => item.id === viewId);
      if (!view) return null;
      const allIds = table.fields.map((field) => field.id);
      return { fields: table.fields, visibleIds: new Set(view.visibleFieldIds ?? allIds) };
    },
    toggleField(viewId, fieldId) {
      return commit((next) => {
        const target = next.views.find((item) => item.id === viewId);
        if (!target) return;
        const allIds = next.fields.map((field) => field.id);
        const visible = new Set(target.visibleFieldIds ?? allIds);
        if (visible.has(fieldId)) {
          if (visible.size <= 1) return;
          visible.delete(fieldId);
        } else visible.add(fieldId);
        if (visible.size === allIds.length) delete target.visibleFieldIds;
        else target.visibleFieldIds = allIds.filter((id) => visible.has(id));
      });
    },
    moveField(sourceId, targetId, after) {
      if (sourceId === targetId) return Promise.resolve(false);
      return commit((next) => moveRelative(next.fields, sourceId, targetId, after));
    },
  };
  displayConfigSessions.set(tableKey, displayConfigSession);
  // The initial render schedules a full pass. Ignore the immediate height change
  // caused by that pass; later size changes still remeasure, and width changes always do.
  let observedLayoutWidth: number | null = null;
  let observedLayoutHeight: number | null = null;
  const layoutObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver((entries) => {
    const { width, height } = entries[0]?.contentRect ?? {};
    if (width === undefined || height === undefined) return;
    if (observedLayoutWidth === null || observedLayoutHeight === null) {
      observedLayoutWidth = width; observedLayoutHeight = height; return;
    }
    const widthChanged = Math.abs(width - observedLayoutWidth) >= 0.5;
    const heightChanged = Math.abs(height - observedLayoutHeight) >= 0.5;
    observedLayoutWidth = width; observedLayoutHeight = height;
    if (widthChanged) { consumeLayoutResizeSuppression(); scheduleLayout(); }
    else if (heightChanged && !consumeLayoutResizeSuppression()) scheduleLayout();
  });
  layoutObserver?.observe(root);
  proxyResizeObserver = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(scheduleProxyUpdate);
  proxyResizeObserver?.observe(root);
  const filterSession: FilterSession = {
    trigger: () => root.querySelector<HTMLButtonElement>(".tb-filter-toggle"),
    snapshot(viewId) {
      if (currentView().id !== viewId) return null;
      const view = table.views.find((item) => item.id === viewId);
      return view ? { fields: table.fields, filters: view.filters } : null;
    },
    save(viewId, change) {
      const view = table.views.find((item) => item.id === viewId);
      if (!view || currentView().id !== viewId) return Promise.resolve(false);
      return commit((next) => {
        const target = next.views.find((item) => item.id === viewId);
        if (!target) throw new Error(t("The view no longer exists."));
        change(target.filters);
      }, undefined, (before, after) => JSON.stringify(before.views.find((item) => item.id === viewId)?.filters)
        === JSON.stringify(after.views.find((item) => item.id === viewId)?.filters));
    },
  };
  const detachFilterSession = attachFilterSession(tableKey, filterSession);
  render();
  return { destroy() {
    stopSearchReveal?.();
    captureSearchFocus(); searchSession.detach();
    highlightedSearchCells.clear();
    if (searchFrame !== null) viewportWindow.cancelAnimationFrame(searchFrame);
    destroyed = true; detachFilterSession(); closeLinkEditors(); disposeTextEditors();
    openGroupConfigPopovers.get(tableKey)?.close(false, true);
    closeMultiSelectPicker();
    if (displayConfigSessions.get(tableKey) === displayConfigSession) displayConfigSessions.delete(tableKey);
    attachmentCells.forEach((entry) => entry.destroy()); attachmentCells.clear();
    layoutObserver?.disconnect(); proxyResizeObserver?.disconnect();
    clearMarkdownCells(); markdownLifecycle.unload();
    rowElementsById.clear();
    if (layoutFrame !== null) viewportWindow.cancelAnimationFrame(layoutFrame);
    if (layoutResizeSuppressionFrame !== null) viewportWindow.cancelAnimationFrame(layoutResizeSuppressionFrame);
    if (proxyFrame !== null) viewportWindow.cancelAnimationFrame(proxyFrame);
    viewportScrollElement?.removeEventListener("scroll", scheduleProxyUpdate);
    viewportWindow?.removeEventListener("scroll", scheduleProxyUpdate);
    viewportWindow?.removeEventListener("resize", scheduleProxyUpdate);
    viewportWindow?.visualViewport?.removeEventListener("scroll", scheduleProxyUpdate);
    viewportWindow?.visualViewport?.removeEventListener("resize", scheduleProxyUpdate);
    root.ownerDocument.removeEventListener("pointerdown", onDocumentPointerDown, true);
    root.ownerDocument.removeEventListener("focusin", onDocumentFocusIn, true);
    root.ownerDocument.removeEventListener("focusout", onDocumentFocusOut, true);
    root.ownerDocument.removeEventListener("dblclick", editCellOnDoubleClick, true);
    root.ownerDocument.defaultView?.removeEventListener("keydown", clearFocusedCell, true);
    root.ownerDocument.defaultView?.removeEventListener("keydown", onWindowShortcutSuppression, true);
    root.removeEventListener("scroll", onRootScroll, true); root.removeEventListener("keydown", keys);
    root.ownerDocument.defaultView?.removeEventListener("keydown", copyFocusedCell, true);
    root.ownerDocument.defaultView?.removeEventListener("paste", paste, true);
    root.removeEventListener("click", selectCell, true); root.removeEventListener("focusin", selectCell); scrollProxy.remove();
  } };
}

function renderInvalidBlock(root: HTMLElement, source: string, error: unknown): void {
  root.replaceChildren(); root.classList.add("tablebase-root", "tb-invalid");
  const panel = el("div", "tb-error-panel");
  panel.append(el("strong", "", t("Super Table could not read this table.")), el("p", "", errorMessage(error)));
  const details = el("details", "tb-error-source"); details.append(el("summary", "", t("Show raw table data")), el("pre", "", source)); panel.append(details); root.append(panel);
}

export async function showImportPreview(app: App, source: string, kind: "smart-table" | "markdown", onConfirm: (table: TableDocument) => Promise<void>): Promise<void> {
  try {
    const result = kind === "smart-table" ? convertSmartTable(source) : convertMarkdownTable(source);
    if (await confirmImportPreview(app, result.table, result.warnings)) await onConfirm(result.table);
  } catch (error) { new Notice(t("Super Table import failed: {message}", { message: errorMessage(error) }), 8000); }
}

function confirmImportPreview(app: App, table: TableDocument, warnings: string[]): Promise<boolean> {
  return new Promise((resolve) => {
    class ImportPreviewModal extends Modal {
      confirmed = false;

      onOpen(): void {
        this.setTitle(t("Import preview"));
        this.modalEl.classList.add("tb-import-preview-modal");

        const preview = el("div", "tb-import-preview");
        const summary = el("div", "tb-import-preview-summary");
        summary.append(
          el("strong", "tb-import-preview-count", t("{records} records, {fields} fields.", { records: table.records.length, fields: table.fields.length })),
          el("span", "tb-import-preview-sample", t("Showing {shown} of {records} records.", { shown: Math.min(3, table.records.length), records: table.records.length })),
        );
        preview.append(summary);

        if (table.fields.length) {
          const scroll = el("div", "tb-import-preview-table-scroll");
          scroll.setAttribute("tabindex", "0");
          scroll.setAttribute("aria-label", t("Scrollable import preview table"));
          const grid = el("table", "tb-import-preview-table");
          grid.setAttribute("aria-label", t("Import preview"));
          const head = el("thead");
          const headerRow = el("tr");
          table.fields.forEach((field) => {
            const heading = el("th");
            heading.scope = "col";
            const headingContent = el("span", "tb-import-preview-heading");
            const typeIcon = icon(fieldIcon[field.type], "tb-import-preview-type-icon");
            typeIcon.setAttribute("aria-hidden", "true");
            headingContent.append(typeIcon, el("span", "", field.name), el("span", "tb-sr-only", fieldTypeLabel(field.type)));
            heading.append(headingContent);
            headerRow.append(heading);
          });
          head.append(headerRow);
          const body = el("tbody");
          table.records.slice(0, 3).forEach((row) => {
            const rowElement = el("tr");
            table.fields.forEach((field) => {
              const cell = el("td");
              cell.append(el("div", "tb-import-preview-cell", fieldToText(field, row.values[field.id])));
              rowElement.append(cell);
            });
            body.append(rowElement);
          });
          if (!table.records.length) {
            const emptyRow = el("tr");
            const emptyCell = el("td", "tb-import-preview-empty", t("No records to preview."));
            emptyCell.colSpan = table.fields.length;
            emptyRow.append(emptyCell);
            body.append(emptyRow);
          }
          grid.append(head, body);
          scroll.append(grid);
          preview.append(scroll);
        } else {
          preview.append(el("p", "tb-import-preview-empty", t("No records to preview.")));
        }

        if (warnings.length) {
          const warningPanel = el("div", "tb-import-preview-warnings");
          warningPanel.append(el("strong", "", t("Warnings:")));
          const warningList = el("ul");
          warnings.forEach((warning) => warningList.append(el("li", "", warning)));
          warningPanel.append(warningList);
          preview.append(warningPanel);
        }

        preview.append(el("p", "tb-import-preview-note", t("The original content will remain in the note.")));
        const actions = el("div", "tb-dialog-actions tb-import-preview-actions");
        const cancel = el("button", "tb-button", t("Cancel"));
        cancel.type = "button";
        cancel.onclick = () => this.close();
        const submit = el("button", "tb-button", t("Insert new table"));
        submit.type = "button";
        submit.classList.add("mod-cta");
        submit.onclick = () => { this.confirmed = true; this.close(); };
        actions.append(cancel, submit);
        preview.append(actions);
        this.contentEl.append(preview);
      }

      onClose(): void { resolve(this.confirmed); }
    }

    new ImportPreviewModal(app).open();
  });
}

export interface MarkdownReplacementDecision {
  confirmed: boolean;
  replace: boolean;
}

export function confirmMarkdownReplacement(app: App, table: TableDocument, markdown: string): Promise<MarkdownReplacementDecision> {
  return new Promise((resolve) => {
    class MarkdownReplacementModal extends Modal {
      decision: MarkdownReplacementDecision = { confirmed: false, replace: false };

      onOpen(): void {
        this.setTitle(t("Convert Super Table to Markdown"));
        this.modalEl.classList.add("tb-import-preview-modal", "tb-markdown-replacement-modal");

        const content = el("div", "tb-import-preview");
        const summary = el("div", "tb-import-preview-summary");
        summary.append(
          el("strong", "tb-import-preview-count", t("{records} records, {fields} fields.", { records: table.records.length, fields: table.fields.length })),
          el("span", "tb-import-preview-sample", t("The Markdown table will be inserted below the Super Table block. The original block remains unless replacement is selected.")),
        );
        content.append(summary);

        const outputPreview = el("pre", "tb-markdown-export-preview", markdown);
        outputPreview.tabIndex = 0;
        content.append(outputPreview);

        const optionCount = table.fields.reduce((total, field) => total + (field.options?.length ?? 0), 0);
        const warning = el("p", "tb-markdown-replacement-warning", t(
          "Replacing removes {fields} field type definitions, {options} option definitions, and {views} view configurations. Cell values remain in the Markdown table.",
          { fields: table.fields.length, options: optionCount, views: table.views.length },
        ));
        warning.setAttribute("role", "alert");
        warning.hidden = true;

        const replaceLabel = el("label", "tb-markdown-replacement-option");
        const replaceCheckbox = el("input");
        replaceCheckbox.type = "checkbox";
        replaceLabel.append(replaceCheckbox, el("span", "", t("Replace original Super Table")));
        content.append(replaceLabel);
        content.append(warning);

        const actions = el("div", "tb-dialog-actions tb-import-preview-actions");
        const cancel = el("button", "tb-button", t("Cancel"));
        cancel.type = "button";
        cancel.onclick = () => this.close();
        const submit = el("button", "tb-button mod-cta", t("Insert Markdown table"));
        submit.type = "button";
        replaceCheckbox.onchange = () => {
          const replace = replaceCheckbox.checked;
          warning.hidden = !replace;
          submit.textContent = t(replace ? "Confirm replacement" : "Insert Markdown table");
          submit.classList.toggle("mod-cta", !replace);
          submit.classList.toggle("mod-warning", replace);
        };
        submit.onclick = () => {
          this.decision = { confirmed: true, replace: replaceCheckbox.checked };
          this.close();
        };
        actions.append(cancel, submit);
        content.append(actions);
        this.contentEl.append(content);
      }

      onClose(): void { resolve(this.decision); }
    }

    new MarkdownReplacementModal(app).open();
  });
}
