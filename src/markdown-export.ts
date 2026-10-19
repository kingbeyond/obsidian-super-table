import { t } from "./i18n";
import { CellValue, Field, RecordRow, TableDocument } from "./model";

function optionLabel(field: Field, value: unknown): string {
  const id = String(value ?? "");
  return field.options?.find((option) => option.id === id)?.label ?? id;
}

function markdownValue(field: Field, value: CellValue): string {
  if (field.type === "checkbox") return value === true ? "[x]" : "[ ]";
  if (value == null) return "";
  if (field.type === "select" || field.type === "status") return optionLabel(field, value);
  if (field.type === "multiselect") return (Array.isArray(value) ? value : []).map((item) => optionLabel(field, item)).join(", ");
  if (field.type === "attachment") {
    return (Array.isArray(value) ? value : []).map((item) => `[[${String(item)}]]`).join("<br>");
  }
  // Keep the stored date value instead of formatting it for display, which can
  // hide time components that the user would lose when replacing the source.
  return String(value);
}

function escapePipes(value: string): string {
  let output = "";
  let backslashes = 0;
  for (const character of value) {
    if (character === "|" && backslashes % 2 === 0) output += "\\";
    output += character;
    backslashes = character === "\\" ? backslashes + 1 : 0;
  }
  return output;
}

function markdownCell(field: Field, value: CellValue): string {
  return escapePipes(markdownValue(field, value).replace(/\r\n?/g, "\n").replace(/\n/g, "<br>"));
}

function markdownText(value: string): string {
  return escapePipes(value.replace(/\r\n?/g, "\n").replace(/\n/g, "<br>"));
}

export function convertSuperTableToMarkdown(table: TableDocument, fields: Field[] = table.fields, records: RecordRow[] = table.records): string {
  if (!fields.length) throw new Error(t("A table without fields cannot be exported as a Markdown table."));
  const header = `| ${fields.map((field) => markdownText(field.name)).join(" | ")} |`;
  const separator = `| ${fields.map(() => "---").join(" | ")} |`;
  const rows = records.map((record) => `| ${fields.map((field) => markdownCell(field, record.values[field.id])).join(" | ")} |`);
  return [header, separator, ...rows].join("\n");
}

export function createMarkdownExportFile(table: TableDocument, fields: Field[] = table.fields, records: RecordRow[] = table.records): string {
  const markdown = convertSuperTableToMarkdown(table, fields, records);
  const hasAttachmentLinks = fields.some((field) => field.type === "attachment"
    && records.some((record) => Array.isArray(record.values[field.id]) && (record.values[field.id] as string[]).length > 0));
  if (!hasAttachmentLinks) return markdown;
  return `> ${t("Attachment links use Obsidian Vault wikilinks. They may not resolve while this file is outside the Vault; move the file into the Vault to resolve them.")}\n\n${markdown}`;
}
