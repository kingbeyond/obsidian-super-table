import { emptyFilters, filterRows, normalizeFilters } from "./filters";
import type { FilterGroup } from "./filters";
export { emptyFilters } from "./filters";
export type { FilterCondition, FilterGroup, FilterOperator } from "./filters";
import { t } from "./i18n";
import type { MessageKey } from "./locales/en";
export type FieldType =
  | "text"
  | "link"
  | "number"
  | "date"
  | "datetime"
  | "checkbox"
  | "select"
  | "multiselect"
  | "attachment"
  | "status";

export type DateDisplayFormat = "iso-date" | "iso-datetime" | "slash-date" | "slash-datetime" | "month-day" | "time" | "year";

export type CellValue = string | number | boolean | string[] | null;
export type Direction = "asc" | "desc";

export interface SelectOption {
  id: string;
  label: string;
  color: string;
}

export interface Field {
  id: string;
  name: string;
  type: FieldType;
  options?: SelectOption[];
  dateFormat?: DateDisplayFormat;
  width?: number;
  align?: "left" | "center" | "right";
}

export interface RecordRow {
  id: string;
  values: Record<string, CellValue>;
}

export interface TableView {
  id: string;
  name: string;
  sort?: { fieldId: string; direction: Direction };
  filters: FilterGroup;
  group?: { fieldId: string; direction: Direction };
  visibleFieldIds?: string[];
}

export function viewUsesFieldForProjection(view: TableView, fieldId: string): boolean {
  return view.sort?.fieldId === fieldId
    || view.group?.fieldId === fieldId
    || view.filters.conditions.some((condition) => condition.fieldId === fieldId);
}

export interface TableDocument {
  schemaVersion: 1;
  tableId: string;
  fields: Field[];
  records: RecordRow[];
  views: TableView[];
  defaultViewId: string;
}

export interface DataGroup {
  key: string;
  label: string;
  rows: RecordRow[];
  rank: number | string;
}

export const FIELD_TYPES: FieldType[] = [
  "text", "number", "select", "multiselect", "date", "checkbox", "link", "attachment",
];

export const DATE_DISPLAY_FORMATS: DateDisplayFormat[] = [
  "iso-datetime", "iso-date", "slash-datetime", "slash-date", "month-day", "time", "year",
];

// `status` remains readable for tables created by previous versions,
// but is no longer offered as a separate field type.
const STORED_FIELD_TYPES: FieldType[] = [...FIELD_TYPES, "datetime", "status"];

export const FIELD_LABELS: Record<FieldType, MessageKey> = {
  text: "Text",
  link: "URL",
  number: "Number",
  date: "Date",
  datetime: "Date & time",
  checkbox: "Checkbox",
  select: "Select",
  multiselect: "Multi-select",
  attachment: "Attachments",
  status: "Status",
};

export function fieldTypeLabel(type: FieldType): string {
  return t(type === "select" ? "Single select" : type === "datetime" ? "Date" : FIELD_LABELS[type]);
}

export function normalizeDateDisplayFormat(value: unknown, fallback: DateDisplayFormat = "iso-date"): DateDisplayFormat {
  return typeof value === "string" && DATE_DISPLAY_FORMATS.includes(value as DateDisplayFormat)
    ? value as DateDisplayFormat
    : fallback;
}

export function formatDateValue(value: unknown, format: DateDisplayFormat = "iso-date"): string {
  const raw = String(value ?? "");
  if (!raw) return "";
  const match = raw.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2}))?/);
  if (!match) return raw;
  const [, year, month, day, hour = "00", minute = "00"] = match;
  switch (format) {
    case "iso-datetime": return `${year}-${month}-${day} ${hour}:${minute}`;
    case "slash-date": return `${year}/${month}/${day}`;
    case "slash-datetime": return `${year}/${month}/${day} ${hour}:${minute}`;
    case "month-day": return `${month}-${day}`;
    case "time": return `${hour}:${minute}`;
    case "year": return year;
    default: return `${year}-${month}-${day}`;
  }
}

function validDateParts(year: number, month: number, day: number): boolean {
  if (year < 1 || month < 1 || month > 12 || day < 1) return false;
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
  return day <= days[month - 1];
}

function localToday(): string {
  const now = new Date();
  return `${String(now.getFullYear()).padStart(4, "0")}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;
}

function storedDateParts(value: string): { year: number; month: number; day: number; time: string } | undefined {
  const match = value.match(/^(\d{4})-(\d{2})-(\d{2})(?:[T ](.+))?$/);
  if (!match) return undefined;
  const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
  return validDateParts(year, month, day) ? { year, month, day, time: match[4] ?? "" } : undefined;
}

function dateText(year: number, month: number, day: number, time = ""): string {
  const date = `${String(year).padStart(4, "0")}-${String(month).padStart(2, "0")}-${String(day).padStart(2, "0")}`;
  return time ? `${date}T${time}` : date;
}

function checkedTime(hour: number, minute: number, second = 0): boolean {
  return hour >= 0 && hour <= 23 && minute >= 0 && minute <= 59 && second >= 0 && second <= 59;
}

/** Parse a formatted date editor value into the canonical value stored in the table. */
export function parseDateEditorValue(value: string, format: DateDisplayFormat, previous = ""): string | undefined {
  const text = value.trim();
  if (!text) return "";
  const old = storedDateParts(previous);
  const oldDate = old ? dateText(old.year, old.month, old.day) : localToday();
  const keepTime = old?.time ?? "";

  if (format === "time") {
    const match = text.match(/^(\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?$/);
    if (!match) return undefined;
    const hour = Number(match[1]); const minute = Number(match[2]); const second = Number(match[3] ?? 0);
    if (!checkedTime(hour, minute, second)) return undefined;
    const seconds = match[3] ? `:${match[3]}${match[4] ?? ""}` : old?.time.match(/^\d{1,2}:\d{2}(:\d{2}(?:\.\d+)?)?$/)?.[1] ?? "";
    const time = `${String(hour).padStart(2, "0")}:${match[2]}${seconds}`;
    return `${oldDate}T${time}`;
  }

  if (format === "year") {
    const match = text.match(/^(\d{4})$/);
    if (!match) return undefined;
    const year = Number(match[1]);
    let month = old?.month ?? 1; let day = old?.day ?? 1;
    if (year < 1) return undefined;
    const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
    const days = [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31];
    day = Math.min(day, days[month - 1]);
    return dateText(year, month, day, keepTime);
  }

  if (format === "month-day") {
    const match = text.match(/^(\d{1,2})[-/](\d{1,2})$/);
    if (!match) return undefined;
    const year = old?.year ?? Number(localToday().slice(0, 4));
    const month = Number(match[1]); const day = Number(match[2]);
    return validDateParts(year, month, day) ? dateText(year, month, day, keepTime) : undefined;
  }

  if (format === "iso-datetime" || format === "slash-datetime") {
    const match = text.match(/^(\d{4})[-/](\d{1,2})[-/](\d{1,2})[ T](\d{1,2}):(\d{2})(?::(\d{2})(\.\d+)?)?$/);
    if (!match) return undefined;
    const year = Number(match[1]); const month = Number(match[2]); const day = Number(match[3]);
    const hour = Number(match[4]); const minute = Number(match[5]); const second = Number(match[6] ?? 0);
    if (!validDateParts(year, month, day) || !checkedTime(hour, minute, second)) return undefined;
    const seconds = match[6] ? `:${match[6]}${match[7] ?? ""}` : old?.time.match(/^\d{1,2}:\d{2}(:\d{2}(?:\.\d+)?)?$/)?.[1] ?? "";
    return dateText(year, month, day, `${String(hour).padStart(2, "0")}:${match[5]}${seconds}`);
  }

  const match = text.match(/^(\d{4})([-/])(\d{1,2})\2(\d{1,2})$/);
  if (!match) return undefined;
  const year = Number(match[1]); const month = Number(match[3]); const day = Number(match[4]);
  return validDateParts(year, month, day) ? dateText(year, month, day, keepTime) : undefined;
}

/** Convert a native date/time picker value back to a canonical stored value. */
export function dateValueFromPicker(value: string, inputType: "date" | "datetime-local" | "time", previous = ""): string {
  if (!value) return "";
  if (inputType === "time") return parseDateEditorValue(value, "time", previous) ?? previous;
  if (inputType === "datetime-local") return parseDateEditorValue(value.replace("T", " "), "iso-datetime", previous) ?? previous;
  return parseDateEditorValue(value, "iso-date", previous) ?? previous;
}

export const OPTION_COLORS = ["gray", "red", "orange", "yellow", "green", "cyan", "blue", "purple", "pink"];

export function nextOptionColor(optionCount: number): string {
  return OPTION_COLORS[optionCount % OPTION_COLORS.length];
}

export function makeId(prefix = "id"): string {
  const random = window.crypto?.randomUUID?.().replace(/-/g, "") ?? Math.random().toString(36).slice(2);
  return `${prefix}-${random.slice(0, 14)}`;
}

export function createDefaultTable(): TableDocument {
  const title = makeId("field");
  const status = makeId("field");
  const due = makeId("field");
  const allView = makeId("view");
  const statusOptions: SelectOption[] = [
    { id: makeId("option"), label: t("Todo"), color: "gray" },
    { id: makeId("option"), label: t("In progress"), color: "blue" },
    { id: makeId("option"), label: t("Done"), color: "green" },
  ];
  return {
    schemaVersion: 1,
    tableId: makeId("table"),
    fields: [
      { id: title, name: t("Name"), type: "text", width: 220 },
      { id: status, name: t("Status"), type: "select", options: statusOptions, width: 150 },
      { id: due, name: t("Due"), type: "date", width: 140 },
    ],
    records: [
      { id: makeId("row"), values: { [title]: t("First task"), [status]: statusOptions[0].id, [due]: "" } },
      { id: makeId("row"), values: { [title]: t("Second task"), [status]: statusOptions[1].id, [due]: "" } },
    ],
    views: [{ id: allView, name: t("All"), filters: emptyFilters() }],
    defaultViewId: allView,
  };
}

export function newField(name = t("New field"), type: FieldType = "text"): Field {
  const field: Field = { id: makeId("field"), name, type, width: defaultFieldWidth(type), align: "left" };
  if (type === "date" || type === "datetime") field.dateFormat = type === "datetime" ? "iso-datetime" : "iso-date";
  if (["select", "multiselect", "status"].includes(type)) {
    field.options = type === "status"
      ? [
          { id: makeId("option"), label: t("Todo"), color: "gray" },
          { id: makeId("option"), label: t("In progress"), color: "blue" },
          { id: makeId("option"), label: t("Done"), color: "green" },
        ]
      : [];
  }
  return field;
}

export function defaultCell(type: FieldType): CellValue {
  return type === "checkbox" ? false : type === "multiselect" || type === "attachment" ? [] : "";
}

export function cloneValue(value: CellValue): CellValue {
  return Array.isArray(value) ? [...value] : value;
}

function isDataObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function invalidStoredData(path: string): never {
  throw new Error(t("Invalid stored data at {path}. Editing is disabled to avoid losing data. Check the raw table data.", { path }));
}

export function normalizeTable(value: unknown): TableDocument {
  if (!isDataObject(value)) throw new Error(t("Table data must be an object."));
  const raw = value as Partial<TableDocument>;
  if (raw.schemaVersion !== 1) throw new Error(t("Unsupported Super Table schema version: {version}.", { version: String(raw.schemaVersion) }));
  if (!Array.isArray(raw.fields) || !Array.isArray(raw.records) || !Array.isArray(raw.views)) {
    throw new Error(t("Table data is missing fields, records, or views."));
  }
  if (!raw.tableId || typeof raw.tableId !== "string") throw new Error(t("Table data is missing its identifier."));

  const fieldIds = new Set<string>();
  const fields = raw.fields.map((candidate, index) => {
    if (!isDataObject(candidate) || typeof candidate.id !== "string" || typeof candidate.name !== "string" || !STORED_FIELD_TYPES.includes(candidate.type)) {
      throw new Error(t("A field has an invalid identifier, name, or type."));
    }
    if (fieldIds.has(candidate.id)) throw new Error(t("Duplicate field identifier: {id}.", { id: candidate.id }));
    fieldIds.add(candidate.id);
    const path = `fields[${index}]`;
    if (candidate.width !== undefined && (typeof candidate.width !== "number" || !Number.isFinite(candidate.width))) invalidStoredData(`${path}.width`);
    if (candidate.align !== undefined && typeof candidate.align !== "string") invalidStoredData(`${path}.align`);
    if (candidate.dateFormat !== undefined && typeof candidate.dateFormat !== "string") invalidStoredData(`${path}.dateFormat`);
    const legacyDateTime = candidate.type === "datetime";
    const type: FieldType = legacyDateTime ? "date" : candidate.type;
    const field: Field = {
      ...candidate,
      id: candidate.id,
      name: candidate.name,
      type,
      width: candidate.width === undefined ? defaultFieldWidth(type) : clampWidth(candidate.width),
      align: ["left", "center", "right"].includes(candidate.align || "") ? candidate.align : "left",
    };
    if (type === "date") {
      const rawFormat = (candidate as Field).dateFormat;
      field.dateFormat = normalizeDateDisplayFormat(rawFormat, legacyDateTime ? "iso-datetime" : "iso-date");
    }
    if (candidate.options !== undefined) {
      if (!Array.isArray(candidate.options)) invalidStoredData(`${path}.options`);
      const optionIds = new Set<string>();
      field.options = candidate.options.map((option, optionIndex) => {
        const optionPath = `${path}.options[${optionIndex}]`;
        if (!isDataObject(option) || typeof option.id !== "string" || typeof option.label !== "string") invalidStoredData(optionPath);
        if (optionIds.has(option.id)) throw new Error(t("Duplicate option identifier in field {field}: {id}.", { field: candidate.id, id: option.id }));
        optionIds.add(option.id);
        if (option.color !== undefined && typeof option.color !== "string") invalidStoredData(`${optionPath}.color`);
        return { ...option, color: OPTION_COLORS.includes(option.color) ? option.color : "gray" };
      });
    } else if (["select", "multiselect", "status"].includes(candidate.type)) {
      field.options = [];
    }
    return field;
  });

  const rowIds = new Set<string>();
  const records = raw.records.map((candidate, index) => {
    if (!isDataObject(candidate) || typeof candidate.id !== "string" || !isDataObject(candidate.values)) {
      throw new Error(t("A record has an invalid identifier or values."));
    }
    if (rowIds.has(candidate.id)) throw new Error(t("Duplicate record identifier: {id}.", { id: candidate.id }));
    rowIds.add(candidate.id);
    // Keep opaque properties and unlisted field values through unrelated whole-table saves.
    const values = { ...candidate.values, ...Object.fromEntries(fields.map((field) => [field.id, coerceCell(field,
      Object.prototype.hasOwnProperty.call(candidate.values, field.id) ? candidate.values[field.id] : undefined,
      `records[${index}].values.${field.id}`,
    )])) };
    return { ...candidate, values };
  });

  const fieldsById = new Map(fields.map((field) => [field.id, field]));
  const viewIds = new Set<string>();
  const views = raw.views.map((candidate, index) => {
    if (!isDataObject(candidate) || typeof candidate.id !== "string" || typeof candidate.name !== "string") throw new Error(t("A view has an invalid identifier or name."));
    if (viewIds.has(candidate.id)) throw new Error(t("Duplicate view identifier: {id}.", { id: candidate.id }));
    viewIds.add(candidate.id);
    const path = `views[${index}]`;
    const view: TableView = { ...candidate, filters: emptyFilters() };
    for (const key of ["sort", "group"] as const) {
      const rule = candidate[key];
      if (rule !== undefined) {
        if (!isDataObject(rule) || typeof rule.fieldId !== "string" || !["asc", "desc"].includes(rule.direction)) invalidStoredData(`${path}.${key}`);
        view[key] = { ...rule };
      }
    }
    view.filters = normalizeFilters(candidate.filters, fieldsById, invalidStoredData, `${path}.filters`);
    if (candidate.visibleFieldIds !== undefined) {
      if (!Array.isArray(candidate.visibleFieldIds) || !candidate.visibleFieldIds.every((id) => typeof id === "string")) invalidStoredData(`${path}.visibleFieldIds`);
      view.visibleFieldIds = [...candidate.visibleFieldIds];
    }
    return view;
  });
  if (views.length === 0) views.push({ id: makeId("view"), name: t("All"), filters: emptyFilters() });
  const defaultViewId = views.some((view) => view.id === raw.defaultViewId) ? raw.defaultViewId! : views[0].id;
  return { ...raw, schemaVersion: 1, tableId: raw.tableId, fields, records, views, defaultViewId };
}

export function clampWidth(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(60, value) : 160;
}

export function defaultFieldWidth(type: FieldType): number {
  return { text: 220, link: 220, number: 110, date: 160, datetime: 160, checkbox: 90, select: 150, multiselect: 200, attachment: 220, status: 150 }[type];
}

function coerceCell(field: Field, value: unknown, path: string): CellValue {
  if (value === undefined) return defaultCell(field.type);
  if (value === null) return null;
  if (field.type === "checkbox") {
    if (typeof value === "boolean") return value;
    if (value === "true" || value === "false" || value === "") return value === "true";
    return invalidStoredData(path);
  }
  if (field.type === "multiselect" || field.type === "attachment") {
    if (Array.isArray(value) && value.every((item) => typeof item === "string")) return [...value];
    if (typeof value === "string") return value === "" ? [] : [value];
    return invalidStoredData(path);
  }
  if (typeof value !== "string" && typeof value !== "boolean" && !(typeof value === "number" && Number.isFinite(value))) invalidStoredData(path);
  if (field.type === "number") {
    if (typeof value === "boolean") invalidStoredData(path);
    return value;
  }
  if (field.type === "select" || field.type === "status") {
    const text = String(value ?? "");
    return field.options?.find((option) => option.id === text || option.label === text)?.id ?? text;
  }
  return value == null ? "" : String(value);
}

export function filterAndSortRows(table: TableDocument, view: TableView): RecordRow[] {
  const rows = filterRows(table.fields, table.records, view.filters);
  if (view.sort) {
    const field = table.fields.find((item) => item.id === view.sort!.fieldId);
    if (field) rows.sort((a, b) => view.sort!.direction === "desc" ? compareCells(field, b.values[field.id], a.values[field.id]) : compareCells(field, a.values[field.id], b.values[field.id]));
  }
  return rows;
}

export function compareCells(field: Field, a: CellValue, b: CellValue): number {
  if (field.type === "checkbox") return Number(a === true) - Number(b === true);
  if (field.type === "number") {
    const number = (value: CellValue) => Number.parseFloat(String(value ?? "")) || 0;
    return number(a) - number(b);
  }
  const label = (value: CellValue) => field.options?.find((option) => option.id === value)?.label ?? String(value ?? "");
  const text = (value: CellValue) => field.type === "multiselect" || field.type === "attachment" ? (Array.isArray(value) ? value : []).map(label).join(",")
    : ["select", "status"].includes(field.type) ? label(value) : String(value ?? "");
  return text(a).localeCompare(text(b), undefined, { numeric: true });
}

export function groupRows(table: TableDocument, view: TableView, rows: RecordRow[]): DataGroup[] {
  if (!view.group) return [];
  const field = table.fields.find((candidate) => candidate.id === view.group!.fieldId);
  if (!field) return [];
  const groups = new Map<string, DataGroup>();
  rows.forEach((row) => {
    const raw = row.values[field.id];
    let identity: string;
    let label: string;
    let rank: number | string;
    if (field.type === "multiselect" || field.type === "attachment") {
      const options = field.options || [];
      const optionOrder = new Map(options.map((option, index) => [option.id, index]));
      const values = (Array.isArray(raw) ? raw : []).slice().sort((a, b) => (optionOrder.get(a) ?? Number.MAX_SAFE_INTEGER) - (optionOrder.get(b) ?? Number.MAX_SAFE_INTEGER) || a.localeCompare(b));
      identity = JSON.stringify(values);
      label = values.length ? values.map((id) => options.find((option) => option.id === id)?.label ?? id).join(" + ") : t("Uncategorized");
      rank = values.length ? Math.min(...values.map((value) => optionOrder.get(value) ?? Number.MAX_SAFE_INTEGER)) : Number.MAX_SAFE_INTEGER;
    } else {
      const text = field.type === "checkbox" ? (raw === true ? "true" : "false") : String(raw ?? "");
      const empty = text.trim() === "";
      label = empty ? t("Uncategorized") : field.type === "checkbox" ? (text === "true" ? t("Checked") : t("Unchecked"))
        : field.type === "date" ? formatDateValue(raw, field.dateFormat ?? "iso-date") : field.options?.find((option) => option.id === text)?.label ?? text;
      identity = empty ? "empty:" : `value:${field.type === "date" ? label : text}`;
      const optionIndex = (field.options || []).findIndex((option) => option.id === text);
      rank = ["select", "status"].includes(field.type) ? (optionIndex < 0 ? Number.MAX_SAFE_INTEGER : optionIndex) : field.type === "date" ? label : text;
    }
    let group = groups.get(identity);
    if (!group) {
      group = { key: identity, label, rows: [], rank };
      groups.set(identity, group);
    }
    group.rows.push(row);
  });
  const output = [...groups.values()];
  output.sort((a, b) => {
    const aEmpty = a.key === "empty:" || a.key === "[]";
    const bEmpty = b.key === "empty:" || b.key === "[]";
    if (aEmpty !== bEmpty) return aEmpty ? 1 : -1;
    const direction = view.group!.direction === "desc" ? -1 : 1;
    const rankComparison = typeof a.rank === "number" && typeof b.rank === "number"
      ? a.rank - b.rank
      : String(a.rank).localeCompare(String(b.rank), undefined, { numeric: true, sensitivity: "base" });
    return direction * (rankComparison || a.label.localeCompare(b.label, undefined, { numeric: true, sensitivity: "base" }));
  });
  return output;
}
