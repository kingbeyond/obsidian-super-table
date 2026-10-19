import type { CellValue, Field, FieldType, RecordRow } from "./model";

export type FilterOperator = "eq" | "neq" | "contains" | "notContains" | "gt" | "gte" | "lt" | "lte" | "between" | "isEmpty" | "isNotEmpty" | "checked" | "unchecked";
export interface FilterCondition {
  id: string;
  fieldId: string;
  operator: FilterOperator;
  value?: string | number | string[];
  upper?: string | number;
}
export interface FilterGroup {
  mode: "and" | "or";
  conditions: FilterCondition[];
}
export const emptyFilters = (): FilterGroup => ({ mode: "and", conditions: [] });
const emptyOperators: FilterOperator[] = ["isEmpty", "isNotEmpty"];
const textOperators: FilterOperator[] = ["eq", "neq", "contains", "notContains", ...emptyOperators];
const numericOperators: FilterOperator[] = ["eq", "neq", "gt", "gte", "lt", "lte", "between", ...emptyOperators];
const dateOperators: FilterOperator[] = ["eq", "gt", "lt", "between", ...emptyOperators];
const allOperators = new Set<FilterOperator>([...textOperators, ...numericOperators, ...dateOperators, "checked", "unchecked"]);

export function filterOperators(type: FieldType): readonly FilterOperator[] {
  if (type === "checkbox") return ["checked", "unchecked"];
  if (type === "attachment") return emptyOperators;
  if (type === "number") return numericOperators;
  if (type === "date" || type === "datetime") return dateOperators;
  return textOperators;
}
export function filterNeedsValue(operator: FilterOperator): boolean {
  return !["isEmpty", "isNotEmpty", "checked", "unchecked"].includes(operator);
}
export function filterDateKind(field: Field): "date" | "datetime-local" | "time" {
  if (field.dateFormat === "time") return "time";
  return field.type === "datetime" || ["iso-datetime", "slash-datetime"].includes(field.dateFormat ?? "") ? "datetime-local" : "date";
}

function validDate(text: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) return false;
  const [year, month, day] = text.split("-").map(Number);
  const leap = year % 4 === 0 && (year % 100 !== 0 || year % 400 === 0);
  return year >= 1 && month >= 1 && month <= 12 && day >= 1 && day <= [31, leap ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][month - 1];
}
function validTime(text: string): boolean {
  return /^\d{2}:\d{2}$/.test(text) && Number(text.slice(0, 2)) < 24 && Number(text.slice(3)) < 60;
}
export function filterDateValue(field: Field, value: unknown, operand = false): string | null {
  if (typeof value !== "string") return null;
  const kind = filterDateKind(field);
  if (operand && kind === "time") return validTime(value) ? value : null;
  const match = value.match(/^(\d{4}-\d{2}-\d{2})(?:[T ](\d{2}:\d{2})(?::(\d{2})(?:\.\d+)?)?)?$/);
  if (!match || !validDate(match[1]) || match[2] && !validTime(match[2]) || match[3] && Number(match[3]) >= 60) return null;
  if (operand && kind === "date" && value !== match[1]) return null;
  if (operand && kind === "datetime-local" && (!match[2] || value !== `${match[1]}T${match[2]}`)) return null;
  if (kind === "date") return match[1];
  if (kind === "time") return match[2] ?? "00:00";
  return `${match[1]}T${match[2] ?? "00:00"}`;
}

export function validFilterCondition(condition: FilterCondition, field?: Field): boolean {
  if (!condition || typeof condition.id !== "string" || !condition.id || typeof condition.fieldId !== "string" || !condition.fieldId || !allOperators.has(condition.operator)) return false;
  if (field && !filterOperators(field.type).includes(condition.operator)) return false;
  if (condition.value !== undefined && !(typeof condition.value === "string" || typeof condition.value === "number" && Number.isFinite(condition.value)
    || Array.isArray(condition.value) && condition.value.every((id) => typeof id === "string"))) return false;
  if (condition.upper !== undefined && !(typeof condition.upper === "string" || typeof condition.upper === "number" && Number.isFinite(condition.upper))) return false;
  if (!filterNeedsValue(condition.operator)) return true;
  const { value, upper, operator } = condition;
  if (field?.type === "select" || field?.type === "status" || field?.type === "multiselect") {
    return Array.isArray(value) && value.length > 0 && value.every((id) => typeof id === "string" && id !== "")
      && new Set(value).size === value.length && (field.type === "multiselect" || !["eq", "neq"].includes(operator) || value.length === 1);
  }
  if (field?.type === "number") {
    return typeof value === "number" && Number.isFinite(value)
      && (operator !== "between" || typeof upper === "number" && Number.isFinite(upper) && value <= upper);
  }
  if (field?.type === "date" || field?.type === "datetime") {
    const lower = filterDateValue(field, value, true);
    const higher = filterDateValue(field, upper, true);
    return lower !== null && (operator !== "between" || higher !== null && lower <= higher);
  }
  if (field) return typeof value === "string" && value !== "";
  const scalar = (item: unknown) => typeof item === "string" && item !== "" || typeof item === "number" && Number.isFinite(item);
  return (scalar(value) || Array.isArray(value) && value.length > 0 && value.every((id) => typeof id === "string" && id !== ""))
    && (operator !== "between" || scalar(value) && scalar(upper) && typeof value === typeof upper && value! <= upper!);
}

export function normalizeFilters(raw: unknown, fields: ReadonlyMap<string, Field>, fail: (path: string) => never, path: string): FilterGroup {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return fail(path);
  const group = raw as FilterGroup;
  if (!["and", "or"].includes(group.mode) || !Array.isArray(group.conditions)) return fail(path);
  const ids = new Set<string>();
  const conditions = group.conditions.map((rule, index) => {
    const rulePath = `${path}.conditions[${index}]`;
    if (!rule || typeof rule !== "object" || Array.isArray(rule) || !validFilterCondition(rule, fields.get(rule.fieldId)) || ids.has(rule.id)) return fail(rulePath);
    ids.add(rule.id);
    return { ...rule, ...(Array.isArray(rule.value) ? { value: [...rule.value] } : {}) };
  });
  return { ...group, conditions };
}

export function activeFilterConditions(fields: readonly Field[], filters: FilterGroup): FilterCondition[] {
  const ids = new Set(fields.map((field) => field.id));
  return filters.conditions.filter((rule) => ids.has(rule.fieldId));
}
export function filterReferencesOptions(rule: FilterCondition, removedIds: ReadonlySet<string>): boolean {
  return Array.isArray(rule.value) && rule.value.some((id) => removedIds.has(id));
}
function isEmpty(value: CellValue | undefined): boolean {
  return value == null || value === "" || Array.isArray(value) && value.length === 0;
}

function compileCondition(field: Field, rule: FilterCondition): (value: CellValue | undefined) => boolean {
  const op = rule.operator;
  if (op === "isEmpty") return isEmpty;
  if (op === "isNotEmpty") return (raw) => !isEmpty(raw);
  if (op === "checked") return (raw) => raw === true;
  if (op === "unchecked") return (raw) => raw !== true;
  if (["select", "status", "multiselect"].includes(field.type)) {
    const wanted = new Set(rule.value as string[]);
    const expected = [...wanted];
    const negate = op === "neq" || op === "notContains";
    return (raw) => {
      let matches: boolean;
      if (field.type !== "multiselect") matches = wanted.has(String(raw ?? ""));
      else if (op === "eq" || op === "neq") {
        const values = new Set(Array.isArray(raw) ? raw : []);
        matches = values.size === wanted.size && expected.every((id) => values.has(id));
      } else matches = Array.isArray(raw) && raw.some((id) => wanted.has(id));
      return negate ? !matches : matches;
    };
  }
  if (field.type === "number" || field.type === "date" || field.type === "datetime") {
    const date = field.type !== "number";
    const lower = date ? filterDateValue(field, rule.value, true)! : rule.value as number;
    const upper = date ? filterDateValue(field, rule.upper, true) : rule.upper as number;
    return (raw) => {
      if (isEmpty(raw) || typeof raw === "string" && raw.trim() === "") return false;
      const value = date ? filterDateValue(field, raw) : Number(raw);
      if (value === null || typeof value === "number" && !Number.isFinite(value)) return false;
      switch (op) {
        case "eq": return value === lower;
        case "neq": return value !== lower;
        case "gt": return value > lower;
        case "gte": return value >= lower;
        case "lt": return value < lower;
        case "lte": return value <= lower;
        case "between": return value >= lower && value <= upper!;
        default: return false;
      }
    };
  }
  const needle = String(rule.value).toLocaleLowerCase();
  return (raw) => {
    const text = String(raw ?? "").toLocaleLowerCase();
    const match = op === "eq" || op === "neq" ? text === needle : text.includes(needle);
    return op === "neq" || op === "notContains" ? !match : match;
  };
}

export function filterRows(fields: readonly Field[], rows: readonly RecordRow[], filters: FilterGroup): RecordRow[] {
  const byId = new Map(fields.map((field) => [field.id, field]));
  const compiled = filters.conditions.flatMap((rule) => {
    const field = byId.get(rule.fieldId);
    return field ? [{ fieldId: field.id, test: compileCondition(field, rule) }] : [];
  });
  if (!compiled.length) return [...rows];
  return rows.filter((row) => filters.mode === "or"
    ? compiled.some((rule) => rule.test(row.values[rule.fieldId]))
    : compiled.every((rule) => rule.test(row.values[rule.fieldId])));
}
