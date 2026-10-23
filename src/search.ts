import { CellValue, Field, formatDateValue, RecordRow } from "./model";

export interface CellMatch { rowId: string; fieldId: string }

function searchValues(field: Field, value: CellValue): string[] {
  if (value == null || field.type === "checkbox") return [];
  if (["select", "status", "multiselect"].includes(field.type)) {
    const ids = Array.isArray(value) ? value : [String(value)];
    return ids.flatMap((id) => {
      const option = field.options?.find((item) => item.id === id);
      return option ? [option.label] : [];
    });
  }
  if (field.type === "date" || field.type === "datetime") {
    return [formatDateValue(value, field.dateFormat ?? "iso-date"), String(value)];
  }
  return Array.isArray(value) ? value : [String(value)];
}

// Search the view's data rather than rendered DOM: Markdown and collapsed rows
// may not have been mounted yet. Each cell contributes at most one result.
export function findCells(rows: RecordRow[], fields: Field[], query: string): CellMatch[] {
  if (!query) return [];
  const needle = query.toLowerCase();
  return rows.flatMap((row) => fields.flatMap((field) =>
    searchValues(field, row.values[field.id]).some((text) => text.toLowerCase().includes(needle))
      ? [{ rowId: row.id, fieldId: field.id }] : []));
}

export interface SearchState {
  open: boolean;
  query: string;
  viewId: string;
  current?: CellMatch;
  expanded: Set<string>;
  focus?: { start: number | null; end: number | null };
}
interface SearchEntry { state: SearchState }
const states = new WeakMap<object, WeakMap<Element, Map<string, SearchEntry>>>();

export function attachSearchState(plugin: object, root: HTMLElement, key: string, viewId: string): { state: SearchState; detach(): void } {
  let scopes = states.get(plugin);
  if (!scopes) { scopes = new WeakMap(); states.set(plugin, scopes); }
  // Separate panes keep independent queries while a host save can replace a
  // renderer inside the same pane without losing its search session.
  const scope = root.closest(".markdown-preview-view, .cm-editor") ?? root.parentElement ?? root;
  let entries = scopes.get(scope);
  if (!entries) { entries = new Map(); scopes.set(scope, entries); }
  const state = entries.get(key)?.state ?? { open: false, query: "", viewId, expanded: new Set<string>() };
  const entry = { state };
  entries.set(key, entry);
  return { state, detach() {
    root.ownerDocument.defaultView?.setTimeout(() => {
      if (entries.get(key) === entry) entries.delete(key);
    }, 250);
  } };
}
