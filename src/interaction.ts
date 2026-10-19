import { CellValue, cloneValue, defaultCell, Field, FieldType, makeId, nextOptionColor, RecordRow, SelectOption } from "./model";

export interface RowClipboard { fields: Array<{ id: string; name: string; type: FieldType }>; rows: CellValue[][] }

export function cellLabel(field: Field, value: CellValue): string {
  if (field.type === "checkbox") return value === true ? "TRUE" : "FALSE";
  const label = (id: unknown) => field.options?.find((option) => option.id === id)?.label ?? String(id ?? "");
  if (field.type === "select" || field.type === "status") return label(value);
  if (field.type === "multiselect") return (Array.isArray(value) ? value : []).map(label).join(", ");
  if (field.type === "attachment") return JSON.stringify(Array.isArray(value) ? value.map(String) : []);
  return String(value ?? "");
}

export function captureRows(fields: Field[], rows: RecordRow[]): RowClipboard {
  return {
    fields: fields.map(({ id, name, type }) => ({ id, name, type })),
    rows: rows.map((row) => fields.map((field) => field.type === "attachment"
      ? (Array.isArray(row.values[field.id]) ? cloneValue(row.values[field.id]) : [])
      : field.type === "multiselect"
      ? (Array.isArray(row.values[field.id]) ? row.values[field.id] as string[] : []).map((id) => field.options?.find((option) => option.id === id)?.label ?? id)
      : ["select", "status"].includes(field.type) ? cellLabel(field, row.values[field.id]) : cloneValue(row.values[field.id]))),
  };
}

export function valueFromLabel(field: Field, value: CellValue): CellValue {
  if (field.type === "checkbox") return value === true || /^(true|yes|1|x|\[x\])$/i.test(String(value));
  if (field.type === "number") return value === "" || value == null ? "" : Number.isFinite(Number(value)) ? Number(value) : String(value);
  if (field.type === "attachment") {
    if (Array.isArray(value)) return value.map(String);
    const text = String(value ?? "").trim();
    if (!text) return [];
    try {
      const parsed: unknown = JSON.parse(text);
      if (Array.isArray(parsed) && parsed.every((path) => typeof path === "string")) return parsed;
    } catch { /* A plain pasted path is also accepted. */ }
    return [String(value)];
  }
  if (["select", "status", "multiselect"].includes(field.type)) {
    const labels = Array.isArray(value) ? value : value ? [String(value)] : [];
    field.options ??= [];
    const ids = labels.map((label) => {
      let option = field.options!.find((item) => item.label === label);
      if (!option) { option = { id: makeId("option"), label, color: nextOptionColor(field.options!.length) }; field.options!.push(option); }
      return option.id;
    });
    return field.type === "multiselect" ? ids : ids[0] ?? "";
  }
  return Array.isArray(value) ? value.join(", ") : String(value ?? "");
}

export function clipboardValues(clipboard: RowClipboard, fields: Field[], index: number): Record<string, CellValue> {
  const source = clipboard.rows[index % clipboard.rows.length];
  return Object.fromEntries(fields.map((field, position) => {
    let match = clipboard.fields.findIndex((item) => item.id === field.id);
    if (match < 0) match = clipboard.fields.findIndex((item) => item.name === field.name);
    if (match < 0) match = position;
    return [field.id, source?.[match] === undefined ? defaultCell(field.type) : valueFromLabel(field, source[match])];
  }));
}

export function moveRelative<T extends { id: string }>(items: T[], sourceId: string, targetId: string, after: boolean): void {
  if (sourceId === targetId || !items.some((item) => item.id === targetId)) return;
  const source = items.findIndex((item) => item.id === sourceId);
  if (source < 0) return;
  const [item] = items.splice(source, 1);
  const target = items.findIndex((candidate) => candidate.id === targetId);
  items.splice(target + Number(after), 0, item);
}

function markdownWebLink(value: string): RegExpMatchArray | null {
  return value.match(/^\[((?:\\.|[^\]])*)\]\(\s*(\S+?)(?:\s+"([^"]*)")?\s*\)$/);
}

function unescapeLinkLabel(value: string): string {
  return value.replace(/\\([\\\]])/g, "$1");
}

export function linkEditorFields(value: string): { text: string; url: string } {
  const raw = value.trim();
  const markdown = markdownWebLink(raw);
  return markdown
    ? { text: unescapeLinkLabel(markdown[1]), url: markdown[2] }
    : { text: value, url: value };
}

export function serializeWebLink(text: string, url: string, title = ""): string {
  const destination = url.trim();
  const label = text.trim() || destination;
  if (!destination) return label;
  if (label === destination && !title) return label;
  const escapedLabel = label.replace(/\\/g, "\\\\").replace(/\]/g, "\\]");
  const titlePart = title ? ` "${title}"` : "";
  return `[${escapedLabel}](${destination}${titlePart})`;
}

export function parseWebLink(value: string): { label: string; href: string; title: string; markdown: boolean } {
  const raw = value.trim();
  const markdown = markdownWebLink(raw);
  const url = markdown ? markdown[2] : raw;
  let href = "";
  if (url) {
    try {
      const parsed = new URL(/^[a-z][a-z\d+.-]*:/i.test(url) ? url : `https://${url}`);
      if (["https:", "http:"].includes(parsed.protocol)) href = parsed.href;
    } catch { /* Show the invalid value so the user can repair it. */ }
  }
  const label = markdown ? unescapeLinkLabel(markdown[1]) : "";
  return { label: label || href || url, href, title: markdown?.[3] || "", markdown: !!markdown };
}

export function reconcileOptions(fields: Field[], rows: RecordRow[], fieldId: string, options: SelectOption[]): void {
  const field = fields.find((item) => item.id === fieldId);
  if (!field) return;
  field.options = options;
  const retained = new Set(options.map((option) => option.id));
  rows.forEach((row) => {
    const value = row.values[fieldId];
    row.values[fieldId] = Array.isArray(value) ? value.filter((id) => retained.has(id)) : retained.has(String(value)) ? value : "";
  });
}
