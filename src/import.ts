import { emptyFilters, FilterCondition, validFilterCondition } from "./filters";
import { t } from "./i18n";
import { CellValue, defaultFieldWidth, Field, FieldType, makeId, OPTION_COLORS, SelectOption, TableDocument, TableView } from "./model";

export interface ConversionResult {
  table: TableDocument;
  warnings: string[];
}

function optionLabel(value: unknown): string {
  if (Array.isArray(value)) return String(value[0] ?? "");
  return value == null ? "" : String(value);
}

function mapOldType(type: unknown): FieldType {
  const value = String(type || "text").toLowerCase();
  if (value === "url") return "link";
  if (value === "status") return "select";
  if (value === "datetime") return "date";
  if (["text", "link", "number", "date", "datetime", "checkbox", "select", "multiselect"].includes(value)) return value as FieldType;
  return "text";
}

function makeOptions(source: unknown, type: FieldType): SelectOption[] {
  if (!["select", "multiselect", "status"].includes(type)) return [];
  const entries = Array.isArray(source) ? source : [];
  const options: SelectOption[] = [];
  entries.forEach((item, index) => {
    const label = typeof item === "string" ? item : item && typeof item.label === "string" ? item.label : "";
    if (!label || options.some((option) => option.label === label)) return;
    const colorValue = item && typeof item.color === "string" ? item.color.toLowerCase() : OPTION_COLORS[index % OPTION_COLORS.length];
    options.push({ id: makeId("option"), label, color: OPTION_COLORS.includes(colorValue) ? colorValue : OPTION_COLORS[index % OPTION_COLORS.length] });
  });
  return options;
}

export function convertSmartTable(source: string): ConversionResult {
  const raw = JSON.parse(source) as Record<string, unknown>;
  if (!raw || !Array.isArray(raw.columns) || !Array.isArray(raw.rows)) throw new Error(t("This Smart Table block does not contain a supported columns/rows structure."));
  const warnings: string[] = [];
  const oldColumns = raw.columns as Array<Record<string, unknown>>;
  const oldRows = raw.rows as Array<Record<string, unknown>>;
  if (oldColumns.some((column) => !column || typeof column !== "object" || typeof column.id !== "string")) {
    throw new Error(t("Every Smart Table column must have an identifier."));
  }
  if (oldRows.some((row) => !row || typeof row !== "object")) throw new Error(t("A Smart Table record is invalid."));
  const knownTypes = new Set(["text", "url", "link", "number", "date", "datetime", "checkbox", "select", "multiselect", "status"]);
  oldColumns.forEach((column) => {
    if (!knownTypes.has(String(column.type || "text").toLowerCase())) {
      warnings.push(t("Unknown field type “{type}” in {name}; imported as text.", { type: String(column.type), name: String(column.name ?? t("column")) }));
    }
  });
  const fields: Field[] = oldColumns.map((old, index) => ({
    id: makeId("field"),
    name: String(old.name ?? t("Field {number}", { number: index + 1 })),
    type: mapOldType(old.type),
    dateFormat: String(old.type || "").toLowerCase() === "datetime" ? "iso-datetime" : undefined,
    width: typeof old.width === "number" ? old.width : defaultFieldWidth(mapOldType(old.type)),
    align: ["left", "center", "right"].includes(String(old.align)) ? old.align as Field["align"] : "left",
    options: makeOptions(old.options, mapOldType(old.type)),
  }));
  const oldFieldById = new Map(oldColumns.map((column, index) => [String(column.id), { column, field: fields[index] }]));

  const records = oldRows.map((oldRow) => {
    const oldCells = oldRow.cells && typeof oldRow.cells === "object" ? oldRow.cells as Record<string, unknown> : {};
    const values: Record<string, CellValue> = {};
    fields.forEach((field, index) => {
      const old = oldColumns[index];
      const rawValue = oldCells[String(old.id)];
      if (["select", "status"].includes(field.type)) {
        const label = optionLabel(rawValue);
        let option = field.options?.find((candidate) => candidate.label === label);
        if (label && !option) {
          option = { id: makeId("option"), label, color: OPTION_COLORS[(field.options || []).length % OPTION_COLORS.length] };
          field.options!.push(option);
        }
        values[field.id] = option?.id ?? "";
      } else if (field.type === "multiselect") {
        const labels = Array.isArray(rawValue) ? rawValue.map(String) : rawValue == null || rawValue === "" ? [] : [String(rawValue)];
        values[field.id] = labels.map((label) => {
          let option = field.options?.find((candidate) => candidate.label === label);
          if (!option) {
            option = { id: makeId("option"), label, color: OPTION_COLORS[(field.options || []).length % OPTION_COLORS.length] };
            field.options!.push(option);
          }
          return option.id;
        });
      } else if (field.type === "checkbox") {
        values[field.id] = rawValue === true || String(rawValue).toLowerCase() === "true";
      } else if (field.type === "number") {
        const number = Number(rawValue);
        values[field.id] = rawValue === "" || rawValue == null ? "" : Number.isFinite(number) ? number : String(rawValue);
        if (rawValue !== "" && rawValue != null && !Number.isFinite(number)) warnings.push(t("Kept non-numeric value “{value}” in {name}.", { value: String(rawValue), name: field.name }));
      } else {
        values[field.id] = rawValue == null ? "" : String(rawValue);
      }
    });
    return { id: makeId("row"), values };
  });

  const viewId = makeId("view");
  const view: TableView = { id: viewId, name: t("Imported view"), filters: emptyFilters() };
  const oldSort = raw.sort as { col?: string; dir?: string } | null;
  if (oldSort?.col && oldFieldById.has(oldSort.col)) {
    view.sort = { fieldId: oldFieldById.get(oldSort.col)!.field.id, direction: oldSort.dir === "desc" ? "desc" : "asc" };
  }
  const oldGroup = raw.group as { col?: string; dir?: string } | null;
  if (oldGroup?.col && oldFieldById.has(oldGroup.col)) {
    view.group = { fieldId: oldFieldById.get(oldGroup.col)!.field.id, direction: oldGroup.dir === "desc" ? "desc" : "asc" };
  }
  let filterFailure = false;
  const filterProblems: string[] = [];
  const rejectFilter = (reason: string) => { filterFailure = true; filterProblems.push(reason); };
  const invalidFilterValue = (field: Field) => rejectFilter(t("The filter value or range in “{name}” is invalid or unsupported.", { name: field.name }));
  if (raw.filters !== undefined && raw.filters !== null) {
    if (typeof raw.filters !== "object" || Array.isArray(raw.filters)) rejectFilter(t("The filter structure is unsupported."));
    else Object.entries(raw.filters as Record<string, unknown>).forEach(([oldId, value]) => {
      if (value == null || value === "") return;
      const field = oldFieldById.get(oldId)?.field;
      if (!field) { rejectFilter(t("Filter field “{id}” was not found.", { id: oldId })); return; }
      const rule: FilterCondition = { id: makeId("filter"), fieldId: field.id, operator: "contains" };
      if (["select", "status", "multiselect"].includes(field.type)) {
        const option = field.options?.find((candidate) => candidate.label === value);
        if (!option) { rejectFilter(t("A filter option in “{name}” was not found.", { name: field.name })); return; }
        rule.operator = field.type === "multiselect" ? "contains" : "eq";
        rule.value = [option.id];
      } else if (field.type === "checkbox") {
        if (value !== true && value !== false && value !== "true" && value !== "false") { invalidFilterValue(field); return; }
        rule.operator = value === true || value === "true" ? "checked" : "unchecked";
      } else if (field.type === "number" || field.type === "date") {
        if (typeof value !== "string" && typeof value !== "number") { invalidFilterValue(field); return; }
        const parts = String(value).split("|");
        if (parts.length > 2) { invalidFilterValue(field); return; }
        const [lower, upper = ""] = parts;
        if (!lower && !upper) return;
        if (field.type === "date" && (!lower || !upper)) { invalidFilterValue(field); return; }
        rule.operator = lower && upper ? "between" : lower ? "gte" : "lte";
        const operand = (text: string) => field.type === "number" ? text.trim() === "" ? NaN : Number(text) : text.replace(" ", "T");
        rule.value = operand(lower || upper);
        if (rule.operator === "between") rule.upper = operand(upper);
      } else {
        if (typeof value !== "string") { invalidFilterValue(field); return; }
        rule.value = value;
      }
      if (validFilterCondition(rule, field)) view.filters.conditions.push(rule);
      else invalidFilterValue(field);
    });
  }
  if (filterFailure) {
    view.filters = emptyFilters();
    warnings.push([t("Some Smart Table filters could not be converted reliably. All imported filters were cleared; all records were retained."), ...new Set(filterProblems)].join(" "));
  }
  if (raw.showFilters === true) warnings.push(t("Open Filter in the toolbar to configure the imported view's conditions."));
  const table: TableDocument = {
    schemaVersion: 1,
    tableId: makeId("table"),
    fields,
    records,
    views: [view],
    defaultViewId: view.id,
  };
  return { table, warnings: [...new Set(warnings)] };
}

function splitMarkdownCells(line: string): string[] {
  let text = line.trim();
  if (text.startsWith("|")) text = text.slice(1);
  if (text.endsWith("|")) text = text.slice(0, -1);
  const cells: string[] = [];
  let current = "";
  let escaped = false;
  for (const char of text) {
    if (char === "|" && !escaped) { cells.push(current.trim().replace(/\\\|/g, "|")); current = ""; }
    else { current += char; escaped = char === "\\" && !escaped; if (char !== "\\") escaped = false; }
  }
  cells.push(current.trim().replace(/\\\|/g, "|"));
  return cells;
}

function inferMarkdownType(values: string[]): FieldType {
  const nonempty = values.filter((value) => value !== "");
  if (!nonempty.length) return "text";
  if (nonempty.every((value) => /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?)?$/.test(value))) return "date";
  if (nonempty.every((value) => Number.isFinite(Number(value)))) return "number";
  if (nonempty.every((value) => /^(true|false|yes|no|\[x\]|\[ \])$/i.test(value))) return "checkbox";
  return "text";
}

export function convertMarkdownTable(source: string): ConversionResult {
  const lines = source.trim().split(/\r?\n/);
  if (lines.length < 2 || !lines[1].includes("-") || !lines[0].includes("|")) throw new Error(t("Select a Markdown table with a header and separator row."));
  const headings = splitMarkdownCells(lines[0]);
  const cells = lines.slice(2).flatMap((line, index) => {
    if (!line.includes("|")) return [];
    const row = splitMarkdownCells(line);
    if (row.slice(headings.length).some((value) => value !== "")) {
      throw new Error(t("Markdown table line {line} has nonempty cells beyond its {columns}-column header. Correct the source table and try again.", { line: index + 3, columns: headings.length }));
    }
    return [row];
  });
  const fields = headings.map((name, col) => {
    const values = cells.map((row) => row[col] || "");
    const type = inferMarkdownType(values);
    return {
      id: makeId("field"), name: name || t("Field {number}", { number: col + 1 }), type, width: 160,
      dateFormat: type === "date" && values.filter(Boolean).some((value) => /[T ]\d{2}:\d{2}/.test(value)) ? "iso-datetime" : undefined,
    } as Field;
  });
  const records = cells.map((row) => {
    const values: Record<string, CellValue> = {};
    fields.forEach((field, index) => {
      const text = row[index] || "";
      if (field.type === "number") values[field.id] = text === "" ? "" : Number(text);
      else if (field.type === "checkbox") values[field.id] = /^(true|yes|\[x\])$/i.test(text);
      else values[field.id] = text;
    });
    return { id: makeId("row"), values };
  });
  const viewId = makeId("view");
  return {
    table: { schemaVersion: 1, tableId: makeId("table"), fields, records, views: [{ id: viewId, name: t("All"), filters: emptyFilters() }], defaultViewId: viewId },
    warnings: [],
  };
}

export function fromClipboardRows(text: string, fields: Field[]): Array<Record<string, CellValue>> {
  const rows: string[][] = [];
  let row: string[] = [];
  let cell = "";
  let quoted = false;
  for (let index = 0; index < text.length; index++) {
    const char = text[index];
    if (quoted) {
      if (char === '"' && text[index + 1] === '"') { cell += '"'; index++; }
      else if (char === '"') quoted = false;
      else cell += char;
    } else if (char === '"' && cell === "") quoted = true;
    else if (char === "\t") { row.push(cell); cell = ""; }
    else if (char === "\n" || char === "\r") {
      if (char === "\r" && text[index + 1] === "\n") index++;
      row.push(cell); rows.push(row); row = []; cell = "";
    } else cell += char;
  }
  if (cell || row.length) { row.push(cell); rows.push(row); }
  return rows.filter((cells) => cells.some((value) => value !== "")).map((cells) => {
    const values: Record<string, CellValue> = {};
    fields.forEach((field, index) => {
      const value = cells[index] ?? "";
      if (field.type === "checkbox") values[field.id] = /^(true|yes|1|x|\[x\])$/i.test(value);
      else if (field.type === "number") values[field.id] = value && Number.isFinite(Number(value)) ? Number(value) : value;
      else if (field.type === "multiselect") values[field.id] = value ? value.split(",").map((part) => part.trim()).filter(Boolean) : [];
      else values[field.id] = value;
    });
    return values;
  });
}
