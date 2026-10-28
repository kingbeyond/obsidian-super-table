import { attachSearchState, findCells } from "../src/search";
import { emptyFilters, FilterCondition, FilterGroup, filterRows, validFilterCondition } from "../src/filters";
import test from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { JSDOM } from "jsdom";
import { EditorState } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { createDefaultTable, defaultCell, normalizeTable, groupRows, filterAndSortRows, formatDateValue, parseDateEditorValue, dateValueFromPicker, Field, TableDocument, FIELD_TYPES, OPTION_COLORS, viewUsesFieldForProjection } from "../src/model";
import { convertMarkdownTable, convertSmartTable, fromClipboardRows } from "../src/import";
import { applyMarkdownExportToNote, scanFencedBlocks, replaceTableBlockInText, serializeTable, serializeTableBody, readTable, readTableId, persistTable, writeMarkdownExport, hasReadingViewTableHistory, applyReadingViewTableHistory } from "../src/storage";
import { captureRows, cellLabel, clipboardValues, linkEditorFields, parseWebLink, reconcileOptions, moveRelative, serializeWebLink, valueFromLabel } from "../src/interaction";
import { findMarkdownTaskMarkers, needsMarkdownRendering, normalizeMarkdownPreviewLineBreaks, safeMarkdownEmbeds, setMarkdownTaskState } from "../src/markdown";
import { markdownPreviewCache } from "../src/markdown-preview";
import { confirmMarkdownReplacement, createExportFileName, renderTable, trackLivePreviewHistoryViewport } from "../src/renderer";
import { convertSuperTableToMarkdown, createMarkdownExportFile } from "../src/markdown-export";
import { colorLabel, errorMessage, getLocale, resolveLocale, setLanguage, t } from "../src/i18n";
import { en } from "../src/locales/en";
import { zhCN } from "../src/locales/zh-CN";
import { fieldTypeLabel } from "../src/model";
import { attachmentFileNameWithSuffix, normalizeSuperTableSettings, noteNamedAttachmentFolder, pastedImageFileName } from "../src/settings";
import SuperTablePlugin from "../src/main";
import { tableEditorExtension } from "../src/editor";
import { cancelViewportRestorations, registerViewportRestoration } from "../src/viewport";
import { promptForm } from "../src/ui";
import { copyTableDocument, prepareTablePaste } from "../src/table-copy";
import { editorInfoField, editorLivePreviewField, shownMenus, notices, markdownRenderCalls, MarkdownRenderer, Menu, Platform, TFile, setObsidianLanguage, setObsidianLanguageFailure, installObsidianDomHelpers } from "./obsidian-stub";

const old = {
  columns: [
    { id: "name", name: "名称", type: "text", width: 260 },
    { id: "platform", name: "平台", type: "select", align: "center", options: [{ label: "PC", color: "green" }, { label: "MAC", color: "yellow" }] },
    { id: "tags", name: "标签", type: "multiselect", options: [{ label: "A", color: "purple" }, { label: "B", color: "blue" }] },
  ],
  rows: [
    { id: "first", cells: { name: "WinMTR", platform: "PC", tags: ["A", "B"] } },
    { id: "second", cells: { name: "IINA", platform: "MAC", tags: ["B", "A"] } },
  ],
  sort: { col: "name", dir: "asc" }, group: { col: "tags", dir: "asc" }, filters: {},
};
const fixture = () => convertSmartTable(JSON.stringify(old)).table;
const filtersFor = (fieldId: string, value: FilterCondition["value"], operator: FilterCondition["operator"] = "contains", upper?: FilterCondition["upper"]): FilterGroup => ({
  mode: "and", conditions: [{ id: "condition-1", fieldId, operator, value, ...(upper === undefined ? {} : { upper }) }],
});
function addFilterDraft(root: HTMLElement): HTMLInputElement {
  click(root.querySelector(".tb-filter-toggle")!);
  click(document.querySelector(".tb-filter-add")!);
  return document.querySelector<HTMLInputElement>(".tb-filter-value")!;
}
function selectFilterChoice(control: HTMLElement, label: string): void {
  if (control instanceof dom.window.HTMLSelectElement) {
    const option = [...control.options].find((item) => item.textContent === label);
    assert.ok(option, `native filter choice: ${label}`);
    control.value = option.value; control.dispatchEvent(new dom.window.Event("change"));
  } else {
    click(control);
    const option = shownMenus.at(-1)!.items.find((item) => item.title === label);
    assert.ok(option, `filter menu choice: ${label}`); option.action!({});
  }
}
function fixtureWithOpaqueData(): any {
  const table = JSON.parse(serializeTableBody(readTable(JSON.stringify(fixture()))));
  table.extraTable = { revision: 7, nested: [null, { note: "Keep this" }] };
  table.fields[0].extraField = { source: "external" };
  table.fields[1].options[0].extraOption = ["metadata", 0, false];
  table.records[0].extraRecord = { archived: false };
  table.records[0].values.unlisted = { original: ["Hidden value", null] };
  table.records[0].values = { ...table.records[0].values, ...JSON.parse('{"__proto__":{"note":"Keep this too"}}') };
  table.views[0].extraView = { layout: "custom" };
  table.views[0].filters = { mode: "and", extraGroup: "Keep group metadata", conditions: [{ id: "opaque", fieldId: table.fields[0].id, operator: "contains", value: "Win", extraFilter: { mode: "custom" } }, { id: "missing", fieldId: "unlisted", operator: "eq", value: "Keep this" }] };
  table.views[0].sort = { fieldId: "unlisted", direction: "asc", extraSort: "keep" };
  table.views[0].group = { fieldId: "unlisted", direction: "desc", extraGroup: "keep" };
  table.views[0].visibleFieldIds = [...table.fields.map((field: Field) => field.id), "unlisted"];
  return table;
}
const livePreviewPlugin = () => ({ app: { workspace: { getActiveViewOfType: () => ({
  file: { path: "test.md" }, getMode: () => "source", containerEl: document.body,
}) } } });

test("[import-export] import preserves names, colors, alignment and view mappings", () => {
  const table = fixture(); const [name, platform, tags] = table.fields;
  assert.equal(name.width, 260); assert.equal(platform.width, 150); assert.equal(platform.align, "center");
  assert.equal(platform.options![0].color, "green"); assert.equal(table.records[0].values[platform.id], platform.options![0].id);
  assert.equal(table.views[0].sort?.fieldId, name.id); assert.equal(table.views[0].group?.fieldId, tags.id);
});
test("[data-format] default sample select values use option IDs; earlier label values still load", () => {
  const table = createDefaultTable(); const field = table.fields[1];
  assert.equal(field.type, "select");
  assert.equal(table.records[0].values[field.id], field.options![0].id);
  table.records[0].values[field.id] = field.options![0].label;
  assert.equal(normalizeTable(table).records[0].values[field.id], field.options![0].id);
});
test("[import-export][data-format] Smart Table status fields import as single select with options, colors, values and filters", () => {
  const result = convertSmartTable(JSON.stringify({
    columns: [{ id: "state", name: "状态", type: "status", options: [{ label: "Todo", color: "gray" }, { label: "Done", color: "green" }] }],
    rows: [{ cells: { state: "Done" } }], filters: { state: "Todo" },
  }));
  const field = result.table.fields[0];
  assert.equal(field.type, "select");
  assert.deepEqual(field.options?.map(({ label, color }) => [label, color]), [["Todo", "gray"], ["Done", "green"]]);
  assert.equal(result.table.records[0].values[field.id], field.options?.[1].id);
  assert.deepEqual(result.table.views[0].filters.conditions[0]?.value, [field.options?.[0].id]);
  assert.ok(!FIELD_TYPES.includes("status"));
});
test("[import-export][data-format] legacy Super Table status fields remain readable", () => {
  const table = createDefaultTable(); table.fields[1].type = "status";
  assert.equal(normalizeTable(table).fields[1].type, "status");
});
test("[data-format] legacy date-time fields normalize to the unified date type and retain display precision", () => {
  const table = normalizeTable({
    schemaVersion: 1, tableId: "date-table",
    fields: [{ id: "when", name: "When", type: "datetime" }],
    records: [{ id: "row", values: { when: "2026-10-07T21:53" } }],
    views: [{ id: "view", name: "All", filters: emptyFilters() }], defaultViewId: "view",
  });
  assert.equal(table.fields[0].type, "date"); assert.equal(table.fields[0].dateFormat, "iso-datetime");
  assert.equal(table.records[0].values.when, "2026-10-07T21:53");
  assert.equal(formatDateValue(table.records[0].values.when, table.fields[0].dateFormat), "2026-10-07 21:53");
  assert.equal(formatDateValue("2026-10-07T21:53", "time"), "21:53");
  assert.equal(formatDateValue("2026-10-07", "time"), "00:00");
  assert.ok(!FIELD_TYPES.includes("datetime"));
});
test("[data-format] formatted date editor values parse back to canonical dates without losing hidden precision", () => {
  assert.equal(parseDateEditorValue("2026/10/07", "slash-date", "2026-10-06"), "2026-10-07");
  assert.equal(parseDateEditorValue("2026-10-07 21:53", "iso-datetime", "2026-10-06T20:30:42"), "2026-10-07T21:53:42");
  assert.equal(parseDateEditorValue("10-07", "month-day", "2025-10-01T21:53"), "2025-10-07T21:53");
  assert.equal(parseDateEditorValue("2024", "year", "2025-02-28"), "2024-02-28");
  assert.equal(parseDateEditorValue("2026-02-29", "iso-date", ""), undefined);
  assert.equal(dateValueFromPicker("2026-10-08", "date", "2026-10-07T21:53"), "2026-10-08T21:53");
  assert.equal(dateValueFromPicker("14:30", "time", "2026-10-07T09:10"), "2026-10-07T14:30");
});
test("[import-export][data-format] Smart Table date-time columns import as unified date columns with date-time display", () => {
  const table = convertSmartTable(JSON.stringify({
    columns: [{ id: "when", name: "When", type: "datetime" }],
    rows: [{ cells: { when: "2026-10-07T21:53" } }],
  })).table;
  assert.equal(table.fields[0].type, "date"); assert.equal(table.fields[0].dateFormat, "iso-datetime");
  assert.equal(table.records[0].values[table.fields[0].id], "2026-10-07T21:53");
});
test("[import-export][data-format] Markdown date-time values infer the unified date type without dropping seconds", () => {
  const table = convertMarkdownTable("| When |\n| --- |\n| 2026-10-07 21:53:00 |\n").table;
  assert.equal(table.fields[0].type, "date"); assert.equal(table.fields[0].dateFormat, "iso-datetime");
  assert.equal(table.records[0].values[table.fields[0].id], "2026-10-07 21:53:00");
});
test("[import-export] Markdown import rejects extra nonempty cells with source line numbers before generating a table", () => {
  const header = "| Name | Count |\n| --- | --- |\n";
  const cases = [
    { body: "| Apple | 3 | Notes |", line: 3 },
    { body: "| Apple | 3 |\n| Pear | 2 |\n| Plum | 1 |\n| Peach | 5 | Notes |", line: 6 },
    { body: "| Apple | 3 |\n\n| Pear | 2 | | Notes |", line: 5 },
    { body: "| Apple | 3 | Notes |\n| Pear | 2 | More notes |", line: 3 },
    { body: "| Apple | 3 | \\| |", line: 3 },
  ];
  for (const newline of ["\n", "\r\n"]) for (const { body, line } of cases) {
    const source = `${header}${body}`.replace(/\n/g, newline);
    assert.throws(() => convertMarkdownTable(source), {
      message: `Markdown table line ${line} has nonempty cells beyond its 2-column header. Correct the source table and try again.`,
    });
  }
});
test("[import-export] Markdown import retains existing typed defaults, empty extras and escaped pipes", () => {
  const source = "| Name | Count | Done | Note |\n| --- | --- | --- | --- |\n| Apple\\|Pear | 3 | true | Keep\\|this |\n| Plum | 2 | false | Plain | \t | |\n| Peach |";
  const result = convertMarkdownTable(source);
  const table = result.table;
  assert.deepEqual(table.fields.map((field) => field.type), ["text", "number", "checkbox", "text"]);
  assert.deepEqual(table.records.map((row) => table.fields.map((field) => row.values[field.id])), [
    ["Apple|Pear", 3, true, "Keep|this"], ["Plum", 2, false, "Plain"], ["Peach", "", false, ""],
  ]);
  assert.deepEqual(result.warnings, []);
});
test("[import-export] Super Table Markdown export uses every field and record in storage order with readable values", () => {
  const table: TableDocument = {
    schemaVersion: 1,
    tableId: "export-table",
    fields: [
      { id: "name", name: "Task | note", type: "text" },
      { id: "link", name: "Link", type: "link" },
      { id: "state", name: "State", type: "select", options: [{ id: "progress", label: "In|Progress", color: "blue" }] },
      { id: "tags", name: "Tags", type: "multiselect", options: [{ id: "a", label: "A", color: "red" }, { id: "b", label: "B", color: "green" }] },
      { id: "done", name: "Done", type: "checkbox" },
      { id: "when", name: "When", type: "date", dateFormat: "iso-date" },
      { id: "files", name: "Files", type: "attachment" },
    ],
    records: [
      { id: "second", values: { name: "Keep **bold** | two\nnext", link: "[Docs](https://example.test/a|b)", state: "progress", tags: ["a", "b"], done: true, when: "2026-10-07T21:53:00", files: ["Assets/a.png", "Assets/b.pdf"] } },
      { id: "first", values: { name: "Earlier in source", done: false } },
      { id: "missing-checkbox", values: { name: "Missing checkbox value" } },
    ],
    views: [{ id: "view", name: "Filtered", filters: filtersFor("name", "not present"), sort: { fieldId: "name", direction: "desc" }, visibleFieldIds: ["name"] }],
    defaultViewId: "view",
  };
  assert.equal(convertSuperTableToMarkdown(table), [
    "| Task \\| note | Link | State | Tags | Done | When | Files |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    "| Keep **bold** \\| two<br>next | [Docs](https://example.test/a\\|b) | In\\|Progress | A, B | [x] | 2026-10-07T21:53:00 | [[Assets/a.png]]<br>[[Assets/b.pdf]] |",
    "| Earlier in source |  |  |  | [ ] |  |  |",
    "| Missing checkbox value |  |  |  | [ ] |  |  |",
  ].join("\n"));
  assert.equal(convertSuperTableToMarkdown(table, [table.fields[0], table.fields[4]], [table.records[1]]), [
    "| Task \\| note | Done |",
    "| --- | --- |",
    "| Earlier in source | [ ] |",
  ].join("\n"), "a current-view export can project selected fields and rows without reordering them");
  assert.ok(createMarkdownExportFile(table).startsWith("> Attachment links use Obsidian Vault wikilinks."));
  assert.ok(!createMarkdownExportFile(table, [table.fields[0]], table.records).startsWith(">"), "files without exported attachment links need no Vault notice");
  assert.throws(() => convertSuperTableToMarkdown({ ...table, fields: [] }), /without fields/);
});
test("[views][data-format] date grouping follows the configured display granularity", () => {
  const table = createDefaultTable(); const field = table.fields[2];
  table.records[0].values[field.id] = "2026-10-07T09:30"; table.records[1].values[field.id] = "2026-10-07T14:00";
  table.views[0].group = { fieldId: field.id, direction: "asc" }; field.dateFormat = "iso-date";
  assert.equal(groupRows(table, table.views[0], table.records).length, 1);
  field.dateFormat = "iso-datetime";
  assert.equal(groupRows(table, table.views[0], table.records).length, 2);
});
test("[views][data-format] multi-select grouping combines A+B and B+A without duplicating rows", () => {
  const table = fixture(); const groups = groupRows(table, table.views[0], table.records);
  assert.equal(groups.length, 1); assert.equal(groups[0].label, "A + B"); assert.equal(groups[0].rows.length, 2);
});
test("[views][data-format] choice sorting uses display labels rather than generated IDs", () => {
  const table = fixture(); const field = table.fields[2];
  field.options = [{ id: "z", label: "A", color: "blue" }, { id: "a", label: "B", color: "red" }];
  table.records[0].values[field.id] = ["a"]; table.records[1].values[field.id] = ["z"];
  table.views[0].sort = { fieldId: field.id, direction: "asc" };
  assert.equal(filterAndSortRows(table, table.views[0])[0].id, table.records[1].id);
});
test("[fields] renaming and recoloring an option retains records; deleting removes only that value", () => {
  const table = fixture(); const field = table.fields[2]; const [a, b] = field.options!;
  reconcileOptions(table.fields, table.records, field.id, [{ ...a, label: "renamed", color: "red" }, b]);
  assert.deepEqual(table.records[0].values[field.id], [a.id, b.id]);
  reconcileOptions(table.fields, table.records, field.id, [b]); assert.deepEqual(table.records[0].values[field.id], [b.id]);
});
test("[records][interaction] internal clipboard uses labels when pasting into another table, including multiselect", () => {
  const source = fixture(); const target = fixture(); const clipboard = captureRows(source.fields, source.records);
  const values = clipboardValues(clipboard, target.fields, 0);
  assert.equal(values[target.fields[1].id], target.fields[1].options![0].id);
  assert.deepEqual(values[target.fields[2].id], target.fields[2].options!.map((option) => option.id));
  assert.equal(clipboardValues(clipboard, target.fields, 2)[target.fields[0].id], "WinMTR");
});
test("[attachments][records] attachment paths normalize and round-trip through internal copy and quoted TSV without splitting paths", () => {
  const table = fixture();
  const field: Field = { id: "files", name: "Files", type: "attachment", width: 220 };
  table.fields.push(field);
  const paths = ["Assets/a,one.png", "Assets/line\nbreak.pdf", 'Assets/quoted "name".png'];
  table.records[0].values[field.id] = paths;
  table.records[1].values[field.id] = "Assets/legacy.pdf";
  const normalized = normalizeTable(table);
  assert.deepEqual(defaultCell("attachment"), []);
  assert.deepEqual(normalized.records[0].values[field.id], paths);
  assert.deepEqual(normalized.records[1].values[field.id], ["Assets/legacy.pdf"]);
  assert.equal(cellLabel(field, paths), JSON.stringify(paths));
  assert.deepEqual(valueFromLabel(field, cellLabel(field, paths)), paths);

  const clipboard = captureRows(table.fields, [table.records[0]]);
  const pasted = clipboardValues(clipboard, table.fields, 0);
  assert.deepEqual(pasted[field.id], paths);
  const jsonCell = cellLabel(field, paths);
  const tsv = `"${jsonCell.replace(/"/g, '""')}"`;
  const rawExternal = fromClipboardRows(tsv, [field])[0][field.id];
  assert.equal(rawExternal, jsonCell);
  assert.deepEqual(valueFromLabel(field, rawExternal), paths);
  assert.deepEqual(valueFromLabel(field, "Assets/plain,path.txt"), ["Assets/plain,path.txt"]);
});
test("[records] move relative uses before/after positions in both directions", () => {
  const items = ["a", "b", "c", "d"].map((id) => ({ id }));
  moveRelative(items, "a", "c", true); assert.deepEqual(items.map((item) => item.id), ["b", "c", "a", "d"]);
  moveRelative(items, "d", "b", false); assert.deepEqual(items.map((item) => item.id), ["d", "b", "c", "a"]);
});
test("[interaction] links support bare hosts, Markdown labels and titles but reject unsafe protocols", () => {
  assert.equal(parseWebLink("example.com/path").href, "https://example.com/path");
  assert.deepEqual(parseWebLink('[网站](https://example.com "说明")'), { label: "网站", href: "https://example.com/", title: "说明", markdown: true });
  assert.equal(parseWebLink("javascript:alert(1)").href, ""); assert.equal(parseWebLink("file:///etc/passwd").href, "");
  assert.deepEqual(linkEditorFields('[网站](https://example.com "说明")'), { text: "网站", url: "https://example.com" });
  assert.deepEqual(linkEditorFields("example.org/path"), { text: "example.org/path", url: "example.org/path" });
  assert.equal(serializeWebLink("", "example.org/path"), "example.org/path");
  assert.equal(serializeWebLink("网站]入口", "https://example.org"), "[网站\\]入口](https://example.org)");
  assert.equal(parseWebLink(serializeWebLink("网站]入口", "https://example.org")).label, "网站]入口");
  assert.equal(parseWebLink(serializeWebLink("新标题", "https://example.org", "说明")).title, "说明");
});
test("[import-export][records] quoted tab-separated paste preserves embedded line breaks", () => {
  const fields: Field[] = [{ id: "text", name: "text", type: "text" }, { id: "num", name: "num", type: "number" }];
  const pasted = fromClipboardRows('"one\ntwo"\t12\nlast\t0', fields);
  assert.equal(pasted[0].text, "one\ntwo"); assert.equal(pasted[0].num, 12); assert.equal(pasted[1].num, 0);
});
test("[storage] record-per-line JSON preserves cell values, metadata, empty tables and legacy compact data", () => {
  const table = fixture();
  table.records[0].values[table.fields[0].id] = '引号"，反斜杠\\，换行\n第二行\r\n制表符\t，竖线|，```';
  table.fields.push({ id: "number", name: "Number", type: "number" }, { id: "check", name: "Check", type: "checkbox" });
  table.records[0].values.number = 0; table.records[0].values.check = false;
  table.records[1].values.number = null; table.records[1].values.check = true;
  const body = serializeTableBody(table);
  assert.deepEqual(JSON.parse(body), JSON.parse(JSON.stringify(table)));
  assert.deepEqual(readTable(body), readTable(JSON.stringify(table)));
  const recordLines = body.split("\n").filter((line) => line.startsWith("    {"));
  assert.deepEqual(recordLines.map((line) => JSON.parse(line.replace(/,$/, ""))), table.records);
  assert.deepEqual(scanFencedBlocks(serializeTable(table)).map((block) => block.body), [body]);
  const empty = { ...table, records: [] };
  assert.deepEqual(JSON.parse(serializeTableBody(empty)), JSON.parse(JSON.stringify(empty)));
});
test("[data-format][storage] unrelated edits retain opaque properties, nested view metadata and unlisted values", () => {
  const raw = fixtureWithOpaqueData();
  const original = JSON.stringify(raw);
  const table = readTable(original);
  table.records[0].values[table.fields[0].id] = "Edited name";
  const expected = JSON.parse(original);
  expected.records[0].values[table.fields[0].id] = "Edited name";
  assert.deepEqual(JSON.parse(serializeTableBody(table)), expected);
  assert.deepEqual(readTable(serializeTableBody(table)), table, "reopening must not discard opaque data");
  assert.equal(JSON.stringify(raw), original);
});
test("[data-format] unsafe stored structures and cell values are rejected instead of being dropped or stringified", () => {
  const cases: Array<[string, (table: any) => void]> = [
    ["field options object", (table) => { table.fields[1].options = {}; }],
    ["option missing label", (table) => { delete table.fields[1].options[0].label; }],
    ["option array", (table) => { table.fields[1].options[0] = []; }],
    ["option color object", (table) => { table.fields[1].options[0].color = {}; }],
    ["width string", (table) => { table.fields[0].width = "wide"; }],
    ["alignment object", (table) => { table.fields[0].align = {}; }],
    ["date format object", (table) => { table.fields[0].dateFormat = {}; }],
    ["record values array", (table) => { table.records[0].values = []; }],
    ["text object", (table) => { table.records[0].values[table.fields[0].id] = { text: "Keep me" }; }],
    ["single select array", (table) => { table.records[0].values[table.fields[1].id] = ["one", "two"]; }],
    ["multi-select nested array", (table) => { table.records[0].values[table.fields[2].id] = [["one"]]; }],
    ["multi-select number", (table) => { table.records[0].values[table.fields[2].id] = 1; }],
    ["attachment member object", (table) => { table.fields[2].type = "attachment"; table.records[0].values[table.fields[2].id] = [{ path: "Assets/a.png" }]; }],
    ["checkbox number", (table) => { table.fields[0].type = "checkbox"; table.records[0].values[table.fields[0].id] = 1; }],
    ["checkbox arbitrary string", (table) => { table.fields[0].type = "checkbox"; table.records[0].values[table.fields[0].id] = "yes"; }],
    ["number boolean", (table) => { table.fields[0].type = "number"; table.records[0].values[table.fields[0].id] = true; }],
    ["filters array", (table) => { table.views[0].filters = []; }],
    ["filter missing value", (table) => { table.views[0].filters.conditions[0] = { id: "invalid", fieldId: table.fields[0].id, operator: "contains", custom: "Keep me" }; }],
    ["sort array", (table) => { table.views[0].sort = []; }],
    ["unknown group direction", (table) => { table.views[0].group.direction = "custom"; }],
    ["visible fields string", (table) => { table.views[0].visibleFieldIds = "name"; }],
    ["visible fields object member", (table) => { table.views[0].visibleFieldIds = [{}]; }],
  ];
  for (const [name, mutate] of cases) {
    const raw = fixtureWithOpaqueData(); mutate(raw);
    const source = JSON.stringify(raw);
    assert.throws(() => readTable(source), /Invalid stored data at|invalid identifier/, name);
    assert.equal(JSON.stringify(raw), source, name);
  }
});
test("[data-format] duplicate view IDs and option IDs are rejected without rewriting their references", () => {
  const raw = fixtureWithOpaqueData();
  raw.views.push({ ...raw.views[0], name: "Second view" });
  const source = JSON.stringify(raw);
  assert.throws(() => readTable(source), { message: `Duplicate view identifier: ${raw.views[0].id}.` });
  assert.equal(JSON.stringify(raw), source);
  for (const type of ["select", "multiselect", "status"] as const) {
    const table = fixtureWithOpaqueData(); const field = table.fields[1]; field.type = type;
    field.options.push({ ...field.options[0], label: "Another option" });
    const body = JSON.stringify(table);
    assert.throws(() => readTable(body), { message: `Duplicate option identifier in field ${field.id}: ${field.options[0].id}.` });
    assert.equal(JSON.stringify(table), body);
  }
});
test("[data-format] ID uniqueness stays scoped and does not impose name uniqueness", () => {
  const table = fixtureWithOpaqueData();
  const first = table.fields[1]; const second = table.fields[2];
  second.options = first.options.map((option: any) => ({ ...option, label: `Other ${option.label}` }));
  table.records.forEach((row: any) => { row.values[second.id] = [first.options[0].id]; });
  table.views.push({ ...table.views[0], id: "another-view" });
  first.options.push({ ...first.options[0], id: "another-option" });
  const source = JSON.stringify(table);
  assert.deepEqual(JSON.parse(serializeTableBody(readTable(source))), JSON.parse(source));
});
test("[data-format][storage] nulls and compatible legacy values survive alongside defaults and unresolved options", () => {
  const fields: Field[] = [
    { id: "text", name: "Text", type: "text" }, { id: "number", name: "Number", type: "number" },
    { id: "check", name: "Check", type: "checkbox" }, { id: "off", name: "Off", type: "checkbox" },
    { id: "date", name: "Date", type: "datetime" }, { id: "link", name: "Link", type: "link" },
    { id: "pick", name: "Pick", type: "status", options: [{ id: "a", label: "Alpha", color: "blue" }] },
    { id: "many", name: "Many", type: "multiselect" }, { id: "files", name: "Files", type: "attachment" },
  ];
  const raw = { schemaVersion: 1, tableId: "legacy-safe", fields, records: [
    { id: "nulls", values: Object.fromEntries(fields.map((field) => [field.id, null])) },
    { id: "legacy", values: { text: 42, number: "not numeric", check: "true", off: "false", date: "2026-10-14T09:30:42", link: "https://example.com", pick: "Alpha", many: "unresolved-option", files: "Assets/a.png" } },
    { id: "missing", values: {} },
  ], views: [], defaultViewId: "missing" };
  const table = readTable(JSON.stringify(raw));
  assert.deepEqual(table.records[0].values, raw.records[0].values);
  assert.deepEqual(table.records[1].values, { text: "42", number: "not numeric", check: true, off: false, date: "2026-10-14T09:30:42", link: "https://example.com", pick: "a", many: ["unresolved-option"], files: ["Assets/a.png"] });
  assert.equal(table.fields[4].type, "date"); assert.equal(table.fields[4].dateFormat, "iso-datetime");
  assert.equal(table.fields[6].type, "status");
  assert.deepEqual(table.records[2].values, Object.fromEntries(table.fields.map((field) => [field.id, defaultCell(field.type)])));
  assert.equal(table.defaultViewId, table.views[0].id);
  assert.deepEqual(readTable(serializeTableBody(table)), table);
});
test("[storage] table ID lookup reads only the top-level identifier for compact and multiline JSON", () => {
  const table = fixture();
  const multiline = serializeTableBody(table);
  const compact = JSON.stringify(table);
  assert.equal(readTableId(multiline), table.tableId);
  assert.equal(readTableId(compact), table.tableId);
  assert.equal(readTableId(`{\n  "schemaVersion": 1,\n  "other": {"tableId": "nested"},\n  "tableId": "top-level"\n}`), "top-level");
  assert.equal(readTableId("[]"), null);
});
test("[storage] safe block replacement preserves surrounding content and rejects stale/duplicate tables", () => {
  const table = fixture(); const source = serializeTableBody(table); const note = `before\n\n${serializeTable(table)}\n\nafter`;
  const next = { ...table, records: [] }; const replaced = replaceTableBlockInText(note, table.tableId, source, serializeTable(next));
  assert.ok(replaced.startsWith("before\n\n")); assert.ok(replaced.endsWith("\n\nafter")); assert.equal(scanFencedBlocks(replaced).length, 1);
  assert.throws(() => replaceTableBlockInText(note, table.tableId, "stale", ""), /changed elsewhere/);
  assert.throws(() => replaceTableBlockInText(`${note}\n${serializeTable(table)}`, table.tableId, source, ""), /same table ID/);
});
test("[table-block][data-format] whole-table copy changes only table identity and initial view, preserving opaque data and references", () => {
  const table = readTable(JSON.stringify(fixtureWithOpaqueData()));
  table.views.push({ id: "second-view", name: "Another", filters: emptyFilters() });
  table.fields.push({ id: "attachments", name: "Files", type: "attachment" });
  table.records[0].values.attachments = ["Assets/shared.png"];
  const original = JSON.stringify(table);
  const first = copyTableDocument(table, "second-view");
  const second = copyTableDocument(table, "second-view");
  assert.notEqual(first.tableId, table.tableId);
  assert.notEqual(first.tableId, second.tableId);
  assert.equal(first.defaultViewId, "second-view");
  assert.deepEqual({ ...first, tableId: table.tableId, defaultViewId: table.defaultViewId }, table);
  first.records[0].values.attachments = [];
  assert.equal(JSON.stringify(table), original, "copies must not share nested objects with the source");
});
test("[table-block][storage] whole-table paste handles same-note, cross-note, repeated and multi-table collisions", () => {
  const table = fixture(); const source = serializeTable(table);
  const note = `${source}\n\n`;
  assert.equal(prepareTablePaste("", source, 0, 0), null, "cross-note paste without a collision stays with the host");
  const first = prepareTablePaste(note, source, note.length, note.length)!;
  assert.ok(first);
  const firstTable = readTable(scanFencedBlocks(first)[0].body);
  assert.notEqual(firstTable.tableId, table.tableId);
  assert.deepEqual({ ...firstTable, tableId: table.tableId }, readTable(scanFencedBlocks(source)[0].body));
  const after = note + first + "\n\n";
  const repeated = prepareTablePaste(after, first, after.length, after.length)!;
  const repeatedTable = readTable(scanFencedBlocks(repeated)[0].body);
  assert.notEqual(repeatedTable.tableId, firstTable.tableId);
  const batch = prepareTablePaste("", `${source}\n\n${source}\n\n${source}`, 0, 0)!;
  const ids = scanFencedBlocks(batch).map((block) => readTable(block.body).tableId);
  assert.equal(ids[0], table.tableId);
  assert.equal(new Set(ids).size, 3);
  assert.equal(note, `${source}\n\n`, "the existing note is never rewritten");
});
test("[table-block][storage] pasted table ID replacement preserves raw JSON, nested IDs, fences, indentation, CRLF and surrounding prose", () => {
  const table = fixtureWithOpaqueData();
  table.extraTable = { tableId: table.tableId, text: 'quoted "tableId": and } [ brackets' };
  const body = JSON.stringify(table, null, 3).replace('"tableId":', '"ta\\u0062leId":');
  const source = `before\r\n\r\n  ~~~~super-table\r\n${body.split("\n").map((line) => `  ${line}`).join("\r\n")}\r\n  ~~~~\r\n\r\nafter`;
  const note = serializeTable(table) + "\n\n";
  const output = prepareTablePaste(note, source, note.length, note.length)!;
  const copied = readTable(scanFencedBlocks(output)[0].body);
  assert.equal(output.replace(JSON.stringify(copied.tableId), JSON.stringify(table.tableId)), source);
  assert.deepEqual(copied.extraTable, table.extraTable);
});
test("[table-block][storage] paste preserves IDs for complete replacement and cut moves but never transforms partial or nested code", () => {
  const source = serializeTable(fixture());
  const note = `before\n${source}\nafter\n`;
  const from = "before\n".length; const to = from + source.length;
  assert.equal(prepareTablePaste(note, source, from, to), null);
  const cutNote = "before\n\nafter\n";
  assert.equal(prepareTablePaste(cutNote, source, cutNote.length, cutNote.length), null);
  for (const [start, end] of [[from, from], [from + 20, from + 20], [from, to - 1], [from + 1, to], [to, to]]) {
    assert.equal(prepareTablePaste(note, source, start, end), null, `${start}:${end}`);
  }
  const unclosed = note + "```text\n";
  assert.equal(prepareTablePaste(unclosed, source, unclosed.length, unclosed.length), null);
  const example = `\`\`\`\`markdown\n${source}\n\`\`\`\``;
  assert.equal(prepareTablePaste(note, example, note.length, note.length), null);
  assert.equal(prepareTablePaste(note, `~~~~markdown\n${source}`, note.length, note.length), null, "unclosed outer examples must remain text");
  const remainingDuplicate = `${source}\n${source}\n`;
  assert.ok(prepareTablePaste(remainingDuplicate, source, 0, source.length), "a second surviving table still requires a fresh ID");
});
test("[table-block][data-format] paste leaves incomplete, invalid and future-version data intact while repairing valid siblings", () => {
  const table = fixture(); const source = serializeTable(table); const note = source + "\n\n";
  const future = serializeTable({ ...table, schemaVersion: 999 } as any);
  const invalid = '```super-table\n{"tableId":"invalid"}\n```';
  for (const value of [source.slice(0, -3), "```super-table\n{\n```", "```super-table\n```", future, invalid]) {
    assert.equal(prepareTablePaste(note, value, note.length, note.length), null);
  }
  const mixed = `${future}\n\n${source}`;
  const result = prepareTablePaste("", mixed, 0, 0)!;
  assert.ok(result.startsWith(future));
  assert.notEqual(readTable(scanFencedBlocks(result)[1].body).tableId, table.tableId);
});
test("[storage] Markdown export inserts below or replaces the exact table block and rejects stale or ambiguous sources", () => {
  const table = fixture();
  const source = serializeTableBody(table);
  const markdown = "| Name |\n| --- |\n| Item |";
  const note = `before\n\n${serializeTable(table)}\n\nafter`;
  const inserted = applyMarkdownExportToNote(note, table.tableId, source, markdown, false);
  assert.ok(inserted.includes(`\n\n${markdown}\n\nafter`));
  assert.equal(scanFencedBlocks(inserted).length, 1);
  const replaced = applyMarkdownExportToNote(note, table.tableId, source, markdown, true);
  assert.ok(replaced.startsWith("before\n\n| Name |"));
  assert.ok(replaced.endsWith("| Item |\n\nafter"));
  assert.equal(scanFencedBlocks(replaced).length, 0);

  const crlf = `before\r\n${serializeTable(table).replace(/\n/g, "\r\n")}\r\nafter`;
  const crlfOutput = applyMarkdownExportToNote(crlf, table.tableId, source, markdown, true);
  assert.ok(crlfOutput.includes("| Name |\r\n| --- |\r\n| Item |"));
  assert.equal(crlfOutput.replace(/\r\n/g, "").includes("\n"), false);

  assert.throws(() => applyMarkdownExportToNote(note, table.tableId, "stale", markdown, true), /changed elsewhere/);
  assert.throws(() => applyMarkdownExportToNote("before\nafter", table.tableId, source, markdown, true), /not found/);
  assert.throws(() => applyMarkdownExportToNote(`${note}\n${serializeTable(table)}`, table.tableId, source, markdown, true), /same table ID/);
  const empty = "before\n```super-table\n```\nafter";
  assert.ok(applyMarkdownExportToNote(empty, table.tableId, "", markdown, true).startsWith("before\n| Name |"));
  assert.throws(() => applyMarkdownExportToNote(`${empty}\n${serializeTable(table)}`, table.tableId, "", markdown, true), /already used/);
  assert.throws(() => applyMarkdownExportToNote(empty + "\n```super-table\n```", table.tableId, "", markdown, true), /unambiguously/);
});
test("[storage] reading-view Markdown export uses atomic Vault updates and rejects concurrent source changes", async () => {
  const table = fixture();
  const source = serializeTableBody(table);
  const markdown = "| Name |\n| --- |\n| Item |";
  for (const replace of [false, true]) {
    let note = `before\n${serializeTable(table)}\nafter`;
    let writes = 0;
    const plugin = { app: { vault: {
      getAbstractFileByPath: (path: string) => new TFile(path),
      process: async (_file: unknown, update: (current: string) => string) => { note = update(note); writes++; },
    } } } as any;
    const root = document.createElement("div");
    await writeMarkdownExport(plugin, "note.md", table.tableId, source, markdown, replace, root);
    assert.equal(writes, 1);
    assert.equal(scanFencedBlocks(note).length, replace ? 0 : 1);
    assert.ok(note.includes(markdown));
    assert.equal(root.dataset.tablebaseSaving, "true");
  }

  let note = `before\n${serializeTable(table)}\nafter`;
  const beforeExternalCheck = note;
  const externallyChanged = note.replace("WinMTR", "Externally changed");
  const externalEditPlugin = { app: { vault: {
    getAbstractFileByPath: (path: string) => new TFile(path),
    process: async (_file: unknown, update: (current: string) => string) => { note = update(externallyChanged); },
  } } } as any;
  await assert.rejects(writeMarkdownExport(externalEditPlugin, "note.md", table.tableId, source, markdown, true), /changed elsewhere/);
  assert.equal(note, beforeExternalCheck);
});
test("[storage] empty block initialization targets one renderer section and rejects stale, ambiguous or nonempty sources", () => {
  const table = createDefaultTable();
  const note = "before\r\n```super-table\r\n```\r\nbetween\r\n  ```super-table\r\n  \t \r\n  ```\r\nafter";
  const section = { text: note.replace(/\r\n/g, "\n"), lineStart: 4, lineEnd: 6 };
  const saved = replaceTableBlockInText(note, table.tableId, "", serializeTable(table), section);
  const blocks = scanFencedBlocks(saved);
  assert.equal(blocks[0].body, ""); assert.equal(blocks[1].indent, "  ");
  assert.deepEqual(readTable(blocks[1].body), readTable(serializeTableBody(table)));
  assert.ok(saved.startsWith(note.slice(0, note.indexOf("  ```")))); assert.ok(saved.endsWith("\r\nafter"));
  assert.equal(saved.replace(/\r\n/g, "").includes("\n"), false);
  assert.throws(() => replaceTableBlockInText(note, table.tableId, "", serializeTable(table)), /changed elsewhere/);
  assert.throws(() => replaceTableBlockInText(note + "external", table.tableId, "", serializeTable(table), section), /changed elsewhere/);
  assert.throws(() => replaceTableBlockInText(note, table.tableId, "", serializeTable(table), { ...section, lineStart: 0 }), /not found/);
  assert.throws(() => replaceTableBlockInText(saved, table.tableId, "", serializeTable(table), { ...section, text: saved, lineEnd: saved.split("\n").length }), /not found/);
  const malformed = "```super-table\n{broken\n```";
  assert.throws(() => replaceTableBlockInText(malformed, table.tableId, "", serializeTable(table), { text: malformed, lineStart: 0, lineEnd: 2 }), /not found/);
  assert.throws(() => readTable("")); assert.throws(() => readTable("{broken"));
});
test("[storage] first empty-block saves work through the active editor and vault, then use normal ID conflict checks", async () => {
  for (const active of [true, false]) {
    let note = "before\n```super-table\n```\nafter"; const original = note;
    let editorWrites = 0; let vaultWrites = 0;
    const editor = {
      getValue: () => note, getLine: (line: number) => note.split("\n")[line], lineCount: () => note.split("\n").length,
      replaceRange: (insert: string, from: { line: number }, to: { line: number }) => {
        const lines = note.split("\n"); lines.splice(from.line, to.line - from.line + 1, ...insert.split("\n"));
        note = lines.join("\n"); editorWrites++;
      },
    };
    const plugin = { app: {
      workspace: { getActiveViewOfType: () => active ? { file: { path: "note.md" }, getMode: () => "source", editor } : null },
      vault: { getAbstractFileByPath: () => new TFile("note.md"), process: async (_: unknown, update: (text: string) => string) => { note = update(note); vaultWrites++; } },
    } } as any;
    const table = createDefaultTable();
    const first = await persistTable(plugin, "note.md", table.tableId, "", table, undefined, { text: note, lineStart: 1, lineEnd: 2 });
    assert.equal(scanFencedBlocks(note)[0].body, first);
    await assert.rejects(persistTable(plugin, "note.md", table.tableId, "", table, undefined, { text: original, lineStart: 1, lineEnd: 2 }), /changed elsewhere/);
    const next = { ...table, records: [] };
    const second = await persistTable(plugin, "note.md", table.tableId, first, next);
    assert.equal(readTable(second).records.length, 0);
    assert.equal(editorWrites, active ? 2 : 0); assert.equal(vaultWrites, active ? 0 : 2);
    note = note.replace('"records":[]', '"records": [ ]'); const external = note;
    await assert.rejects(persistTable(plugin, "note.md", table.tableId, second, table), /changed elsewhere/);
    assert.equal(note, external);
  }
});
test("[storage] saving a super-table block leaves tablebase blocks with the same table ID untouched", () => {
  const table = fixture(); const source = serializeTableBody(table);
  const otherBlock = `  \`\`\`tablebase\r\n  ${JSON.stringify(table)}\r\n  \`\`\``;
  const otherOnly = `before\r\n${otherBlock}\r\nafter`;
  assert.throws(() => replaceTableBlockInText(otherOnly, table.tableId, source, serializeTable(table)), /not found/);
  const note = `${otherOnly}\r\n${serializeTable(table).replace(/\n/g, "\r\n")}`;
  const next = { ...table, records: [] };
  const saved = replaceTableBlockInText(note, table.tableId, source, serializeTable(next));
  assert.equal(saved, `${otherOnly}\r\n${serializeTable(next).replace(/\n/g, "\r\n")}`);
});
test("[storage] rewriting compact JSON upgrades only the target block and preserves CRLF and indentation", () => {
  const table = fixture(); const other = createDefaultTable(); const source = JSON.stringify(table);
  const oldBlock = `\`\`\`super-table\n${source}\n\`\`\``.split("\n").map((line) => `  ${line}`).join("\r\n");
  const note = `before\r\n${serializeTable(other).replace(/\n/g, "\r\n")}\r\n${oldBlock}\r\nafter`;
  const next = { ...table, records: table.records.slice(1) };
  const changed = replaceTableBlockInText(note, table.tableId, source, serializeTable(next));
  assert.equal(changed.replace(/\r\n/g, "").includes("\n"), false);
  const blocks = scanFencedBlocks(changed);
  assert.deepEqual(readTable(blocks[0].body), readTable(serializeTableBody(other)));
  assert.equal(blocks[1].indent, "  ");
  assert.equal(blocks[1].body, serializeTableBody(next));
  assert.ok(changed.endsWith("\r\nafter"));
});
test("[storage] reading-view table writes use safe vault persistence and can be undone and redone", async () => {
  const table = fixture(); const source = JSON.stringify(table);
  let note = `before\n\`\`\`super-table\n${source}\n\`\`\`\nafter`; let usedVaultProcess = false;
  const plugin = { app: {
    vault: { getAbstractFileByPath: () => new TFile("reading-history.md"), process: async (_: unknown, update: (text: string) => string) => { note = update(note); usedVaultProcess = true; } },
    workspace: { getActiveViewOfType: () => ({ file: { path: "reading-history.md" }, getMode: () => "preview", editor: {} }) },
  } } as any;
  const next = JSON.parse(JSON.stringify(table)) as TableDocument; next.fields[0].name = "Renamed";
  const saved = await persistTable(plugin, "reading-history.md", table.tableId, source, next);
  assert.equal(usedVaultProcess, true);
  assert.equal(scanFencedBlocks(note)[0].body, saved);
  assert.equal(readTable(saved).fields[0].name, "Renamed");
  assert.equal(hasReadingViewTableHistory("reading-history.md", "undo"), true);
  note = note.replace("\nafter", "\nexternal note edit");
  const pendingUndo = applyReadingViewTableHistory(plugin, "reading-history.md", "undo");
  assert.equal(await applyReadingViewTableHistory(plugin, "reading-history.md", "undo"), null);
  const undone = await pendingUndo;
  assert.equal(undone, source);
  assert.equal(scanFencedBlocks(note)[0].body, source);
  assert.equal(note.startsWith("before\n"), true); assert.equal(note.endsWith("\nexternal note edit"), true);
  assert.equal(hasReadingViewTableHistory("reading-history.md", "redo"), true);
  const redone = await applyReadingViewTableHistory(plugin, "reading-history.md", "redo");
  assert.equal(redone, saved);
  assert.equal(scanFencedBlocks(note)[0].body, saved);
});
test("[storage] reading-view table undo rejects an externally changed target block", async () => {
  const table = fixture(); const source = serializeTableBody(table); const path = "reading-history-conflict.md";
  let note = `\`\`\`super-table\n${source}\n\`\`\``;
  const plugin = { app: {
    vault: { getAbstractFileByPath: () => new TFile(path), process: async (_: unknown, update: (text: string) => string) => { note = update(note); } },
    workspace: { getActiveViewOfType: () => ({ file: { path }, getMode: () => "preview", editor: {} }) },
  } } as any;
  const next = { ...table, records: table.records.slice(1) };
  await persistTable(plugin, path, table.tableId, source, next);
  note = note.replace("IINA", "External edit"); const externallyEdited = note;
  await assert.rejects(applyReadingViewTableHistory(plugin, path, "undo"), /changed elsewhere/);
  assert.equal(note, externallyEdited);
});
test("[storage] reading-view row changes can be undone from a focused table shortcut", async () => {
  const table = fixture(); const source = serializeTableBody(table); const path = "reading-row-history.md";
  let note = `before\n\`\`\`super-table\n${source}\n\`\`\`\nafter`;
  const containerEl = document.createElement("div"); document.body.append(containerEl);
  const view = { file: { path }, getMode: () => "preview", editor: {}, containerEl };
  const plugin = { app: {
    workspace: { getActiveViewOfType: () => view },
    vault: { getAbstractFileByPath: () => new TFile(path), process: async (_: unknown, update: (text: string) => string) => { note = update(note); } },
  } } as any;
  const root = document.createElement("div"); containerEl.append(root);
  const controller = renderTable(plugin, source, { root, sourcePath: path });
  const dispatchHistory = (key: string, extra: Record<string, unknown> = {}) => {
    const event = new dom.window.KeyboardEvent("keydown", { key, metaKey: true, bubbles: true, cancelable: true, ...extra });
    root.dispatchEvent(event); return event;
  };
  try {
    const addRow = byLabel(root, "Row"); addRow.focus(); click(addRow); await settle();
    assert.equal(readTable(scanFencedBlocks(note)[0].body).records.length, table.records.length + 1);
    assert.equal(document.activeElement, root, "a table write should keep keyboard focus in the Reading view table");
    root.focus();
    const undo = dispatchHistory("z"); await settle();
    assert.equal(undo.defaultPrevented, true);
    assert.equal(readTable(scanFencedBlocks(note)[0].body).records.length, table.records.length);
    const redo = dispatchHistory("z", { shiftKey: true }); await settle();
    assert.equal(redo.defaultPrevented, true);
    assert.equal(readTable(scanFencedBlocks(note)[0].body).records.length, table.records.length + 1);
  } finally { controller.destroy(); containerEl.remove(); }
});
test("[interaction][storage] reading-view note history never renders another table into the focused table", async () => {
  const first = fixture(); first.tableId = "history-first"; first.fields[0].name = "First table";
  const second = fixture(); second.tableId = "history-second"; second.fields[0].name = "Second table";
  const path = "multi-table-history.md";
  let note = serializeTable(first) + "\n\n" + serializeTable(second);
  const plugin = { app: {
    workspace: { getActiveViewOfType: () => ({ file: { path }, getMode: () => "preview", editor: {}, containerEl: document.body }) },
    vault: { getAbstractFileByPath: () => new TFile(path), process: async (_: unknown, update: (text: string) => string) => { note = update(note); } },
  } } as any;
  const root = document.createElement("div"); document.body.append(root);
  const controller = renderTable(plugin, serializeTableBody(first), { root, sourcePath: path });
  try {
    const changed = structuredClone(second); changed.records.pop();
    await persistTable(plugin, path, second.tableId, serializeTableBody(second), changed);
    for (const shiftKey of [false, true]) {
      root.focus(); root.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey, bubbles: true, cancelable: true }));
      await settle();
      assert.equal(root.querySelector<HTMLTextAreaElement>("textarea.tb-field-name")?.value, "First table");
      assert.equal(readTable(scanFencedBlocks(note)[0].body).tableId, first.tableId);
      assert.equal(readTable(scanFencedBlocks(note)[1].body).records.length, shiftKey ? 1 : 2);
    }
  } finally { controller.destroy(); root.remove(); }
});
test("[interaction][storage] reading-view host rebuilds retain focus across paste undo and redo", async () => {
  const table = fixture(); const path = "reading-rebuild-history.md";
  let note = serializeTable(table);
  const containerEl = document.createElement("div"); document.body.append(containerEl);
  const hiddenEditorTable = document.createElement("div"); hiddenEditorTable.className = "tablebase-root";
  hiddenEditorTable.dataset.tableId = table.tableId; hiddenEditorTable.tabIndex = -1;
  containerEl.append(hiddenEditorTable);
  const readingSurface = document.createElement("div"); readingSurface.className = "markdown-preview-view"; containerEl.append(readingSurface);
  let root: HTMLDivElement; let controller: ReturnType<typeof renderTable> | undefined;
  const plugin = { app: {
    workspace: { getActiveViewOfType: () => ({ file: { path }, getMode: () => "preview", editor: {}, containerEl }) },
    vault: { getAbstractFileByPath: () => new TFile(path), process: async (_: unknown, update: (text: string) => string) => {
      note = update(note); controller?.destroy(); root.remove(); mountReading();
      containerEl.tabIndex = -1; containerEl.focus();
    } },
  } } as any;
  function mountReading() {
    root = document.createElement("div"); readingSurface.append(root);
    controller = renderTable(plugin, scanFencedBlocks(note)[0].body, { root, sourcePath: path });
  }
  mountReading();
  try {
    pointerClick(root!.querySelector<HTMLTableCellElement>("td.tb-cell")!);
    pasteClipboardText(document.activeElement!, "Reading view paste");
    await waitForCondition(() => readTable(scanFencedBlocks(note)[0].body).records.some((row) => Object.values(row.values).includes("Reading view paste")) && root.contains(document.activeElement), "paste rebuild focus");
    for (const shiftKey of [false, true, false]) {
      document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey, bubbles: true, cancelable: true }));
      await waitForCondition(() => root.contains(document.activeElement), "history rebuild focus");
      assert.equal(readTable(scanFencedBlocks(note)[0].body).records.some((row) => Object.values(row.values).includes("Reading view paste")), shiftKey);
    }
  } finally { controller?.destroy(); containerEl.remove(); }
});
test("[interaction][storage] reading-view table history does not capture note undo after focus leaves the table", async () => {
  const table = fixture(); const source = serializeTableBody(table); const path = "reading-row-history-focus.md";
  let note = `before\n\`\`\`super-table\n${source}\n\`\`\`\nafter`;
  const containerEl = document.createElement("div"); document.body.append(containerEl);
  const view = { file: { path }, getMode: () => "preview", editor: { undo() {} }, containerEl };
  const plugin = { app: {
    workspace: { getActiveViewOfType: () => view },
    vault: { getAbstractFileByPath: () => new TFile(path), process: async (_: unknown, update: (text: string) => string) => { note = update(note); } },
  } } as any;
  const root = document.createElement("div"); containerEl.append(root);
  const controller = renderTable(plugin, source, { root, sourcePath: path });
  const outside = document.createElement("button"); document.body.append(outside);
  let obsidianUndoCalls = 0;
  const normalNoteUndo = (event: KeyboardEvent) => {
    if (event.key.toLowerCase() === "z" && event.metaKey && !event.defaultPrevented) {
      obsidianUndoCalls++;
      event.preventDefault();
    }
  };
  document.addEventListener("keydown", normalNoteUndo);
  try {
    click(byLabel(root, "Row")); await settle();
    assert.equal(readTable(scanFencedBlocks(note)[0].body).records.length, table.records.length + 1);
    const noteAfterTableWrite = note;
    outside.focus(); await settle();

    // No pointerdown occurs here, so the recent-table-write marker remains set.
    // Focus alone must determine which undo history owns the shortcut.
    const undo = new dom.window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true });
    outside.dispatchEvent(undo); await settle();
    assert.equal(obsidianUndoCalls, 1, "the note editor should receive Cmd-Z after focus leaves the table");
    assert.equal(note, noteAfterTableWrite, "the table history must remain untouched");
  } finally {
    document.removeEventListener("keydown", normalNoteUndo);
    controller.destroy(); containerEl.remove(); outside.remove();
  }
});
test("[storage] vault writes return the exact multiline body for subsequent saves and reject external changes", async () => {
  const table = fixture(); const source = JSON.stringify(table);
  let note = `before\n\`\`\`super-table\n${source}\n\`\`\`\nafter`;
  const plugin = { app: {
    vault: { getAbstractFileByPath: () => new TFile("note.md"), process: async (_: unknown, update: (text: string) => string) => { note = update(note); } },
    workspace: { getActiveViewOfType: () => null },
  } } as any;
  const next = { ...table, records: table.records.slice(1) };
  const first = await persistTable(plugin, "note.md", table.tableId, source, next);
  assert.equal(scanFencedBlocks(note)[0].body, first);
  const second = await persistTable(plugin, "note.md", table.tableId, first, table);
  assert.equal(scanFencedBlocks(note)[0].body, second);
  note = note.replace("WinMTR", "Changed externally"); const external = note;
  await assert.rejects(persistTable(plugin, "note.md", table.tableId, second, next), /changed elsewhere/);
  assert.equal(note, external);
});
test("[table-block] live preview creates one atomic widget per valid table; source mode stays raw", () => {
  const extension = tableEditorExtension({} as any) as any[]; const field = extension[0];
  const state = EditorState.create({ doc: `${serializeTable(fixture())}\n\n${serializeTable(createDefaultTable())}`, extensions: [editorInfoField, editorLivePreviewField, extension] });
  assert.equal(state.field(field).size, 2);
  const updated = state.update({ changes: { from: 0, to: 0, insert: "Heading\n\n" } }).state; assert.equal(updated.field(field).size, 2);
  const raw = EditorState.create({ doc: serializeTable(fixture()), extensions: [editorInfoField, extension] }); assert.equal(raw.field(field).size, 0);
});
test("[table-block] live preview leaves tablebase blocks as source and renders only super-table blocks", () => {
  const table = fixture();
  const otherBlock = `\`\`\`tablebase\n${serializeTableBody(table)}\n\`\`\``;
  const extension = tableEditorExtension({} as any) as any[]; const field = extension[0];
  const otherState = EditorState.create({ doc: otherBlock, extensions: [editorInfoField, editorLivePreviewField, extension] });
  assert.equal(otherState.field(field).size, 0);
  const note = `${otherBlock}\n\n${serializeTable(table)}`;
  const state = EditorState.create({ doc: note, extensions: [editorInfoField, editorLivePreviewField, extension] });
  assert.equal(state.field(field).size, 1);
  state.field(field).between(0, state.doc.length, (from: number, to: number) => {
    assert.equal(state.doc.sliceString(from, to), serializeTable(table));
  });
  assert.equal(state.doc.toString(), note);
});
test("[table-block] live preview replaces a thousand-record multiline block as one complete widget", () => {
  const table = fixture();
  table.records = Array.from({ length: 1000 }, (_, index) => ({ id: `row-${index}`, values: { ...table.records[0].values } }));
  const note = `before\n\n${serializeTable(table)}\n\nafter`;
  const extension = tableEditorExtension({} as any) as any[]; const field = extension[0];
  const state = EditorState.create({ doc: note, extensions: [editorInfoField, editorLivePreviewField, extension] });
  assert.equal(state.field(field).size, 1);
  state.field(field).between(0, state.doc.length, (from: number, to: number) => {
    assert.equal(note.slice(from, to), serializeTable(table));
  });
});

const dom = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://local.test", pretendToBeVisual: true });
Object.defineProperty(dom.window.HTMLElement.prototype, "setCssStyles", {
  value(this: HTMLElement, styles: Partial<CSSStyleDeclaration>) { Object.assign(this.style, styles); },
});
for (const name of ["window", "document", "Node", "HTMLElement", "Element", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSpanElement", "MouseEvent", "KeyboardEvent", "DOMException", "File", "MutationObserver"])
  Object.defineProperty(globalThis, name, { configurable: true, value: (dom.window as any)[name] });
Object.defineProperty(globalThis, "navigator", { configurable: true, value: dom.window.navigator });
Object.defineProperty(dom.window, "matchMedia", { configurable: true, value: () => ({ matches: true, addListener() {}, removeListener() {} }) });
Object.defineProperty(dom.window.navigator, "clipboard", { configurable: true, value: { writeText: async () => {} } });
const requestTestFrame = (callback: (timestamp: number) => void) => setTimeout(() => callback(dom.window.performance.now()), 0);
const cancelTestFrame = (frame: number) => clearTimeout(frame);
Object.defineProperty(dom.window, "requestAnimationFrame", { configurable: true, value: requestTestFrame });
Object.defineProperty(dom.window, "cancelAnimationFrame", { configurable: true, value: cancelTestFrame });
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: requestTestFrame });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: cancelTestFrame });
installObsidianDomHelpers(dom.window.document);
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));
test("[attachments][localization] plugin preferences keep their saved shape and stay separate from host settings", async () => {
  setObsidianLanguage("en");
  const plugin = new SuperTablePlugin({ workspace: { on: () => ({}), getActiveViewOfType: () => null } } as any, {} as any);
  const hostSettings = { hostOnly: true };
  plugin.settings = hostSettings;
  plugin.data = { attachmentImagePasteLocation: "note-folder" };
  await plugin.onload();
  assert.equal(plugin.superTableSettings.attachmentImagePasteLocation, "note-folder");
  const settingTab = plugin.settingTabs[0] as any;
  assert.deepEqual(settingTab.getSettingDefinitions(), [{
    name: "Attachment image paste location",
    desc: "Choose where images pasted into attachment cells are saved. This does not affect device imports.",
    control: {
      type: "dropdown",
      key: "attachmentImagePasteLocation",
      defaultValue: "obsidian",
      options: {
        obsidian: "Use Obsidian attachment settings",
        "note-folder": "Use sibling 附件/<note name>/ folder",
      },
    },
  }]);
  assert.equal(settingTab.getControlValue("attachmentImagePasteLocation"), "note-folder");
  assert.equal(settingTab.getControlValue("unknown"), undefined);

  await settingTab.setControlValue("attachmentImagePasteLocation", "note-folder");
  assert.deepEqual(plugin.data, { attachmentImagePasteLocation: "note-folder" });
  await settingTab.setControlValue("attachmentImagePasteLocation", "invalid-value");
  assert.equal(settingTab.getControlValue("attachmentImagePasteLocation"), "obsidian");
  assert.deepEqual(plugin.data, { attachmentImagePasteLocation: "obsidian" });
  await settingTab.setControlValue("unknown", "note-folder");
  assert.deepEqual(plugin.data, { attachmentImagePasteLocation: "obsidian" }, "unknown controls do not write host or plugin data");

  assert.equal(plugin.settings, hostSettings);
});
test("[layout] renderer schedules and cancels animation frames in the root's owning window", () => {
  const secondary = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://secondary.test", pretendToBeVisual: true });
  const requestedByOwner: number[] = [];
  const canceledByOwner: number[] = [];
  const requestedGlobally: number[] = [];
  const canceledGlobally: number[] = [];
  let nextOwnerFrame = 0;
  let nextGlobalFrame = 0;
  const previousRequest = Object.getOwnPropertyDescriptor(globalThis, "requestAnimationFrame");
  const previousCancel = Object.getOwnPropertyDescriptor(globalThis, "cancelAnimationFrame");
  const previousActiveDocument = Object.getOwnPropertyDescriptor(globalThis, "activeDocument");
  const previousActiveWindow = Object.getOwnPropertyDescriptor(globalThis, "activeWindow");
  Object.defineProperty(secondary.window, "requestAnimationFrame", {
    configurable: true,
    value: (_callback: (timestamp: number) => void) => { const id = ++nextOwnerFrame; requestedByOwner.push(id); return id; },
  });
  Object.defineProperty(secondary.window, "cancelAnimationFrame", {
    configurable: true,
    value: (id: number) => { canceledByOwner.push(id); },
  });
  Object.defineProperty(globalThis, "requestAnimationFrame", {
    configurable: true,
    value: (_callback: (timestamp: number) => void) => { const id = ++nextGlobalFrame; requestedGlobally.push(id); return id; },
  });
  Object.defineProperty(globalThis, "cancelAnimationFrame", {
    configurable: true,
    value: (id: number) => { canceledGlobally.push(id); },
  });
  Object.defineProperty(globalThis, "activeDocument", { configurable: true, value: secondary.window.document });
  Object.defineProperty(globalThis, "activeWindow", { configurable: true, value: secondary.window });
  const root = secondary.window.document.createElement("div");
  secondary.window.document.body.append(root);
  let controller: ReturnType<typeof renderTable> | null = null;
  try {
    controller = renderTable({ app: {} } as any, JSON.stringify(fixture()), { root, sourcePath: "secondary.md" });
    assert.ok(requestedByOwner.length > 0, "the renderer schedules layout work through the root document's window");
    assert.deepEqual(requestedGlobally, [], "a different global window does not receive renderer frames");
    controller.destroy();
    controller = null;
    assert.deepEqual(canceledByOwner, requestedByOwner, "destroy cancels each pending owner-window frame");
    assert.deepEqual(canceledGlobally, [], "destroy uses the same owner window for frame cleanup");
  } finally {
    controller?.destroy();
    if (previousRequest) Object.defineProperty(globalThis, "requestAnimationFrame", previousRequest);
    else delete (globalThis as { requestAnimationFrame?: unknown }).requestAnimationFrame;
    if (previousCancel) Object.defineProperty(globalThis, "cancelAnimationFrame", previousCancel);
    else delete (globalThis as { cancelAnimationFrame?: unknown }).cancelAnimationFrame;
    if (previousActiveDocument) Object.defineProperty(globalThis, "activeDocument", previousActiveDocument);
    else delete (globalThis as { activeDocument?: unknown }).activeDocument;
    if (previousActiveWindow) Object.defineProperty(globalThis, "activeWindow", previousActiveWindow);
    else delete (globalThis as { activeWindow?: unknown }).activeWindow;
    secondary.window.close();
  }
});
async function waitForCondition(condition: () => boolean, description: string, timeoutMs = 1500): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}
async function editTextCell(root: HTMLElement, value: string, selector = ".tb-markdown-content"): Promise<void> {
  const preview = root.querySelector<HTMLElement>(selector);
  assert.ok(preview, `missing Markdown preview ${selector}`);
  const cell = preview.closest<HTMLTableCellElement>("td.tb-cell"); assert.ok(cell);
  const input = openMarkdownEditor(cell);
  input.value = value; input.blur(); await waitForCondition(() => !cell.isConnected, "edited cell save and refresh");
}

test("[markdown] Markdown task mapping distinguishes source lines and ignores code and ordinary HTML checkboxes", () => {
  const source = [
    "- [ ] duplicate", "- [x] duplicate", "  - [ ] nested", "1. [ ] ordered", "> - [x] quoted",
    "~~~md", "- [ ] fenced", "~~~", "    - [ ] indented code", '<input type="checkbox" checked>', "- [ ]",
  ].join("\r\n");
  const markers = findMarkdownTaskMarkers(source);
  assert.deepEqual(markers.map(({ line, checked }) => [line, checked]), [[0, false], [1, true], [2, false], [3, false], [4, true], [10, false]]);
  const toggled = setMarkdownTaskState(source, markers[1], false);
  assert.equal(toggled, source.replace("- [x] duplicate", "- [ ] duplicate"));
  const emptyToggled = setMarkdownTaskState(source, markers[5], true);
  assert.equal(emptyToggled, source.slice(0, markers[5].start) + "x" + source.slice(markers[5].end));
  assert.equal(setMarkdownTaskState(source, { ...markers[0], start: 99, end: 100 }, true), source);
  assert.deepEqual(findMarkdownTaskMarkers("   ```md\n- [ ] fenced\n   ```\n- [ ] after fence").map(({ line }) => line), [3]);
});

test("[markdown] Markdown preview sanitizer keeps code literal and avoids non-image embeds and HTML media", () => {
  const source = [
    "![[report.pdf]] ![[photo.PNG]] `![[inline.pdf]]`",
    "````md", "```", "![[fenced.pdf]]", "````",
    "> ~~~md", "> ![[quoted.pdf]]", "> ~~~",
    "    ![[indented.pdf]]", "`multiline", "![[crossline.pdf]]`",
    '<video src="clip.mp4"></video><audio controls></audio>',
  ].join("\n");
  const safe = safeMarkdownEmbeds(source);
  assert.ok(safe.includes("[[report.pdf]] ![[photo.PNG]] `![[inline.pdf]]`"));
  assert.ok(safe.includes("![[fenced.pdf]]") && safe.includes("> ![[quoted.pdf]]") && safe.includes("    ![[indented.pdf]]"));
  assert.ok(safe.includes("`multiline\n![[crossline.pdf]]`"));
  assert.ok(safe.includes("&lt;video src=\"clip.mp4\"&gt;&lt;/video&gt;&lt;audio controls&gt;&lt;/audio&gt;"));
});
test("[markdown] Markdown fast path catches CJK emphasis, strike-through and bare URLs", () => {
  assert.equal(needsMarkdownRendering("这是**粗体**内容"), true);
  assert.equal(needsMarkdownRendering("文字~~删除~~"), true);
  assert.equal(needsMarkdownRendering("文字*斜体*"), true);
  assert.equal(needsMarkdownRendering("https://example.com/path"), true);
  assert.equal(needsMarkdownRendering("普通的单行文本"), false);
  assert.equal(needsMarkdownRendering("普通的第一行\n普通的第二行"), false);
});
test("[markdown] Markdown rendering is scheduled after cell attachment when IntersectionObserver is unavailable", async () => {
  const original = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: undefined });
  const table = fixture(); table.records[0].values[table.fields[0].id] = "**中文** ![[manual.pdf]]";
  const before = markdownRenderCalls.length; const ui = mount(table);
  try {
    const content = ui.root.querySelector<HTMLElement>(".tb-markdown-content")!;
    assert.equal(content.textContent, "**中文** ![[manual.pdf]]");
    await waitForCondition(() => markdownRenderCalls.slice(before).includes("**中文** [[manual.pdf]]"), "scheduled Markdown renderer completion");
    assert.ok(markdownRenderCalls.slice(before).includes("**中文** [[manual.pdf]]"));
    assert.equal(content.textContent, "**中文** [[manual.pdf]]");
  } finally {
    ui.cleanup();
    if (original) Object.defineProperty(globalThis, "IntersectionObserver", original);
    else delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  }
});
test("[markdown][storage][layout] Reading view remounts keep unchanged link previews while fresh Markdown rendering is pending", async () => {
  const originalObserver = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: undefined });
  const originalRender = MarkdownRenderer.render;
  const jobs: Array<{ element: HTMLElement; component: Parameters<typeof MarkdownRenderer.render>[4]; resolve: () => void; reject: (error: Error) => void }> = [];
  MarkdownRenderer.render = (_app, _source, element, _path, component) => new Promise<void>((resolve, reject) => {
    jobs.push({ element, component, resolve, reject });
  });
  const table = fixture(); delete table.views[0].sort; delete table.views[0].group;
  const linkSource = "[Device details](https://example.com/catalog/a-long-device-path)";
  table.records[0].values[table.fields[0].id] = linkSource;
  const noteField: Field = { id: "note", name: "Note", type: "text" };
  table.fields.push(noteField); table.records.forEach((row) => { row.values[noteField.id] = "Before"; });
  const path = "reading-markdown-preview.md";
  let note = `before\n${serializeTable(table)}\nafter`;
  const roots: Array<{ root: HTMLElement; controller: ReturnType<typeof renderTable> }> = [];
  let active: typeof roots[number];
  const plugin = { app: {
    workspace: { getActiveViewOfType: () => null },
    vault: { getAbstractFileByPath: () => new TFile(path), process: async (_file: unknown, update: (text: string) => string) => {
      note = update(note);
      active.controller.destroy(); active.root.remove();
      active = createRenderer(scanFencedBlocks(note)[0].body);
    } },
  } } as any;
  function createRenderer(body: string, sourcePath = path) {
    const root = document.createElement("div"); document.body.append(root);
    const controller = renderTable(plugin, body, { root, sourcePath });
    const result = { root, controller }; roots.push(result); return result;
  }
  const finishLink = (job: typeof jobs[number]) => {
    job.element.innerHTML = '<p><a class="external-link" href="https://example.com/catalog/a-long-device-path">Device details</a></p>';
    const link = job.element.querySelector("a");
    job.resolve();
    return link;
  };
  const preview = (root: HTMLElement) => root.querySelector<HTMLElement>(`.tb-data-row td[data-field-id="${table.fields[0].id}"] .tb-markdown-content`)!;
  try {
    active = createRenderer(serializeTableBody(table));
    await waitForCondition(() => jobs.length === 1, "first Markdown render");
    finishLink(jobs[0]);
    await waitForCondition(() => !!preview(active.root).querySelector("a"), "initial rendered link");
    let unloaded = 0; jobs[0].component.onunload = () => { unloaded++; };
    const oldRoot = active.root; const oldLink = preview(oldRoot).querySelector("a");
    await editTextCell(oldRoot, "After", `td[data-field-id="${noteField.id}"] .tb-markdown-content`);
    await waitForCondition(() => jobs.length === 2, "fresh render after Reading view save");
    assert.equal(oldRoot.isConnected, false, "the simulated host replaces the entire code block after Vault.process");
    assert.equal(preview(active.root).textContent, "Device details", "the new block never exposes the longer Markdown URL while rendering is pending");
    assert.equal(preview(active.root).classList.contains("is-markdown-pending"), false, "the restored preview retains rendered whitespace rules");
    assert.notEqual(preview(active.root).querySelector("a"), oldLink, "cached output must not retain old live DOM or event handlers");
    assert.equal(unloaded, 1, "the old Markdown component still unloads");
    assert.notEqual(jobs[1].component, jobs[0].component, "fresh rendering gets a fresh component");
    assert.equal(readTable(scanFencedBlocks(note)[0].body).records[0].values[noteField.id], "After");
    const freshLink = finishLink(jobs[1]);
    await settle();
    assert.equal(preview(active.root).querySelector("a"), freshLink, "fresh Obsidian output replaces the temporary copy");

    active.controller.destroy(); active.root.remove();
    active = createRenderer(scanFencedBlocks(note)[0].body);
    await waitForCondition(() => jobs.length === 3, "another fresh render");
    jobs[2].reject(new Error("temporary renderer failure")); await settle();
    assert.equal(preview(active.root).textContent, "Device details", "a refresh failure retains the exact-source rendered preview");
    assert.ok(preview(active.root).querySelector("a"));

    const changed = readTable(scanFencedBlocks(note)[0].body);
    changed.records[0].values[changed.fields[0].id] = "[Changed](https://example.com/new)";
    const changedRenderer = createRenderer(serializeTableBody(changed));
    assert.equal(preview(changedRenderer.root).textContent, changed.records[0].values[changed.fields[0].id], "changed source must not display an old label");
    const otherNote = createRenderer(scanFencedBlocks(note)[0].body, "other-note.md");
    assert.equal(preview(otherNote.root).textContent, linkSource, "previews must not cross note contexts");
  } finally {
    roots.forEach(({ root, controller }) => { controller.destroy(); root.remove(); });
    MarkdownRenderer.render = originalRender;
    if (originalObserver) Object.defineProperty(globalThis, "IntersectionObserver", originalObserver);
    else delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
  }
});
test("[markdown] preview reuse excludes component-dependent content and bounds retained output", () => {
  const owner = {}; const content = document.createElement("div"); const rendered = document.createElement("div");
  const cache = markdownPreviewCache(owner, document, "note.md");
  for (const html of ['<p><img src="image.png"></p>', '<p><button>Task</button></p>', '<p><a class="internal-link" href="note">Note</a></p>', '<p id="block">Named block</p>', '<div class="internal-embed">Embed</div>']) {
    rendered.innerHTML = html;
    cache.remember(html, rendered);
    assert.equal(cache.restore(html, content), false);
  }
  rendered.innerHTML = "<p><strong>Rendered</strong></p>";
  for (let index = 0; index < 129; index++) cache.remember(`**${index}**`, rendered);
  assert.equal(cache.restore("**0**", content), false, "old previews are evicted");
  assert.equal(cache.restore("**128**", content), true);
  assert.equal(markdownPreviewCache({}, document, "note.md").restore("**128**", content), false, "plugin instances have separate caches");
  const otherDocument = document.implementation.createHTMLDocument();
  assert.equal(markdownPreviewCache(owner, otherDocument, "note.md").restore("**128**", otherDocument.createElement("div")), false);
  rendered.innerHTML = `<p>${"a".repeat(16_385)}</p>`;
  cache.remember("**large**", rendered);
  assert.equal(cache.restore("**large**", content), false, "large rendered output is not retained");
});
test("[markdown] cached previews are adopted into the document that owns the table", () => {
  const secondary = new JSDOM("<!doctype html><html><body></body></html>", { url: "https://preview.test" });
  const otherDocument = secondary.window.document;
  const nativeAdoptNode = otherDocument.adoptNode.bind(otherDocument);
  let adoptionCount = 0;
  let sourceDocument: Document | null = null;
  let adoptedDocument: Document | null = null;
  Object.defineProperty(otherDocument, "adoptNode", {
    configurable: true,
    value: (node: Node) => {
      adoptionCount++;
      sourceDocument = node.ownerDocument;
      const adopted = nativeAdoptNode(node);
      adoptedDocument = adopted.ownerDocument;
      return adopted;
    },
  });
  const rendered = document.createElement("div");
  rendered.innerHTML = "<p><strong>Rendered in another document</strong></p>";
  const content = otherDocument.createElement("div");
  const cache = markdownPreviewCache({}, otherDocument, "other-document.md");
  try {
    cache.remember("**Rendered in another document**", rendered);
    assert.equal(adoptionCount, 1, "the preview fragment is adopted by the table's document");
    assert.equal(sourceDocument, document, "the global Obsidian fragment helper starts in the test's primary document");
    assert.equal(adoptedDocument, otherDocument);
    assert.equal(cache.restore("**Rendered in another document**", content), true);
    assert.equal(content.querySelector("strong")?.textContent, "Rendered in another document");
    assert.ok([...content.querySelectorAll("*")].every((element) => element.ownerDocument === otherDocument));
  } finally {
    secondary.window.close();
  }
});
test("[markdown] Markdown previews preserve source line breaks after editing and rendering", async () => {
  const originalObserver = Object.getOwnPropertyDescriptor(globalThis, "IntersectionObserver");
  const scrollHeightDescriptor = Object.getOwnPropertyDescriptor(dom.window.HTMLTextAreaElement.prototype, "scrollHeight");
  Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: undefined });
  Object.defineProperty(dom.window.HTMLTextAreaElement.prototype, "scrollHeight", {
    configurable: true,
    get(this: HTMLTextAreaElement) { return this.value.split(/\r\n|\r|\n/).length * 20 + 8; },
  });
  const style = document.createElement("style"); style.textContent = readFileSync("styles.css", "utf8"); document.head.append(style);
  const ui = mount();
  try {
    const rowId = ui.table.records[0].id; const fieldId = ui.table.fields[0].id;
    const cell = ui.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${fieldId}"]`)!;
    const value = "first line\n\n\n";
    const input = openMarkdownEditor(cell);
    assert.ok(cell.classList.contains("is-cell-editing"), "the active text cell should expose its editing state");
    input.value = value; input.blur();
    assert.equal(cell.classList.contains("is-cell-editing"), false, "saving should clear the editing state before refresh");
    await waitForCondition(() => !cell.isConnected, "multiline edit save and refresh");
    const preview = ui.root.querySelector<HTMLElement>(`tr[data-row-id="${rowId}"] td[data-field-id="${fieldId}"] .tb-markdown-content`)!;
    await waitForCondition(() => !preview.classList.contains("is-markdown-pending"), "multiline Markdown preview rendering");
    assert.equal(ui.saved()?.records[0].values[fieldId], value);
    assert.ok(preview.classList.contains("has-source-line-breaks"));
    assert.equal(dom.window.getComputedStyle(preview).whiteSpace, "normal");
    assert.equal(preview.textContent, value, "the plain-text preview should retain all source line breaks");
    assert.deepEqual([...preview.querySelectorAll<HTMLElement>(".tb-markdown-plain-line")].map((line) => line.textContent), ["first line", "", "", ""]);
    assert.equal(preview.querySelectorAll(".tb-markdown-line-separator").length, 3);
    assert.equal(dom.window.getComputedStyle(preview.querySelector<HTMLElement>(".tb-markdown-plain-line")!).minHeight, "1.4em");
    assert.equal(dom.window.getComputedStyle(preview.querySelector<HTMLElement>(".tb-markdown-plain-line")!).whiteSpace, "pre-wrap");

    const reopenedCell = preview.closest<HTMLTableCellElement>("td")!;
    Object.defineProperty(reopenedCell, "clientHeight", { configurable: true, value: 30 });
    const reopenedInput = openMarkdownEditor(reopenedCell);
    assert.equal(reopenedInput.style.height, "88px", "reopening should use the source content height when the row is shorter");
    reopenedInput.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(reopenedCell.classList.contains("is-cell-editing"), false, "cancelling should clear the editing state");
  } finally {
    ui.cleanup(); style.remove();
    if (originalObserver) Object.defineProperty(globalThis, "IntersectionObserver", originalObserver);
    else delete (globalThis as { IntersectionObserver?: unknown }).IntersectionObserver;
    if (scrollHeightDescriptor) Object.defineProperty(dom.window.HTMLTextAreaElement.prototype, "scrollHeight", scrollHeightDescriptor);
    else delete (dom.window.HTMLTextAreaElement.prototype as { scrollHeight?: number }).scrollHeight;
  }
});
test("[markdown] host br/newline pairs render once while paragraph blank lines and spaces survive", () => {
  for (const newline of ["\n", "\r\n", "\r"]) {
    const rendered = document.createElement("div");
    rendered.innerHTML = '<p>131<br>\n2131<br>\n<a href="https://example.com">Link</a></p>';
    const source = ["131", "2131", "[Link](https://example.com)"].join(newline);
    normalizeMarkdownPreviewLineBreaks(rendered, source);
    assert.equal(rendered.querySelector("p")!.innerHTML, '131<br>2131<br><a href="https://example.com">Link</a>');
    assert.equal(rendered.querySelectorAll("br").length, 2);
    assert.equal(rendered.querySelectorAll(".tb-markdown-blank-lines").length, 0);
  }
  for (const count of [1, 2, 3]) {
    const rendered = document.createElement("div");
    rendered.innerHTML = '<p><strong>first  line</strong></p>\n<p>second<br>\n<a href="https://example.com">Link</a></p>';
    const source = `\n\n**first  line**${"\n".repeat(count + 1)}second\n[Link](https://example.com)\n\n`;
    normalizeMarkdownPreviewLineBreaks(rendered, source);
    assert.deepEqual([...rendered.querySelectorAll<HTMLElement>(".tb-markdown-blank-lines")].map((node) => node.style.height), ["2.8em", `${count * 1.4}em`, "2.8em"]);
    assert.equal(rendered.querySelector("strong")!.textContent, "first  line");
    const html = rendered.innerHTML;
    normalizeMarkdownPreviewLineBreaks(rendered, source);
    assert.equal(rendered.innerHTML, html, "normalization must be idempotent");
    const cache = markdownPreviewCache({}, document, "line-breaks.md");
    cache.remember(source, rendered);
    const restored = document.createElement("div");
    assert.equal(cache.restore(source, restored), true);
    assert.equal(restored.innerHTML, html, "cached previews retain normalized breaks and blank lines");
  }
});
test("[markdown] spacing normalization keeps block structures, code whitespace and unmatched paragraphs", () => {
  for (const [source, html] of [
    ["- one\n- two", "<ul>\n<li>one</li>\n<li>two</li>\n</ul>"],
    ["```text\na\n\nb\n```", "<pre><code>a\n\nb\n</code></pre>"],
    ["<pre>a<br>\n b</pre>", "<pre>a<br>\n b</pre>"],
    ["`a\n\nb`", "<p><code>a b</code></p>"],
    ["<p>one</p>\n\n<p>two</p>", "<p>one</p>\n<p>two</p>"],
  ]) {
    const rendered = document.createElement("div"); rendered.innerHTML = html;
    normalizeMarkdownPreviewLineBreaks(rendered, source);
    assert.equal(rendered.innerHTML, html);
  }
  const rendered = document.createElement("div");
  rendered.innerHTML = '<blockquote><p>one<br>\ntwo</p></blockquote><ul><li><input type="checkbox">task<br>\ncontinued</li></ul>';
  normalizeMarkdownPreviewLineBreaks(rendered, "> one\n> two\n\n- [ ] task\n  continued");
  assert.equal(rendered.querySelector("blockquote p")!.innerHTML, "one<br>two");
  assert.ok(rendered.querySelector('li input[type="checkbox"]'));
  assert.equal(rendered.querySelectorAll(".tb-markdown-source-paragraph").length, 0);
});
test("[markdown][interaction] rendered multiline links keep their source when reopened and saved", async () => {
  const originalRender = MarkdownRenderer.render;
  const source = "\n**first**\n\n\nsecond\n[Link](https://example.com)\n";
  MarkdownRenderer.render = async (_app, markdown, element) => {
    assert.equal(markdown, source);
    element.innerHTML = '<p><strong>first</strong></p>\n<p>second<br>\n<a href="https://example.com">Link</a></p>';
  };
  const table = fixture(); delete table.views[0].sort; delete table.views[0].group;
  const fieldId = table.fields[0].id;
  table.records[0].values[fieldId] = source;
  const ui = mount(table);
  try {
    const preview = ui.root.querySelector<HTMLElement>(`td[data-field-id="${fieldId}"] .tb-markdown-content`)!;
    await waitForCondition(() => !!preview.querySelector(".tb-markdown-source-paragraph"), "normalized Markdown paragraphs");
    assert.equal(preview.getAttribute("contenteditable"), "false", "the preview must not inherit the cell's plaintext-only editing mode");
    assert.ok(preview.classList.contains("markdown-rendered"), "Live Preview needs the same host Markdown style scope as reading view");
    assert.equal(preview.querySelector("br")!.nextSibling!.textContent, "");
    assert.equal(preview.querySelector("a")!.getAttribute("href"), "https://example.com");
    assert.equal(preview.querySelector("a")!.getAttribute("contenteditable"), "false");
    const cell = preview.closest<HTMLTableCellElement>("td")!;
    const editor = openMarkdownEditor(cell);
    assert.equal(editor.value, source);
    editor.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(ui.saved(), null, "cancelling must not write normalized preview text");
    const reopened = openMarkdownEditor(cell);
    assert.equal(reopened.value, source);
    reopened.blur();
    assert.equal(table.records[0].values[fieldId], source);
  } finally { ui.cleanup(); MarkdownRenderer.render = originalRender; }
});
test("[markdown][layout] list previews inherit host indentation and spacing without preserving structural newlines", () => {
  const hostStyle = document.createElement("style");
  hostStyle.textContent = `
    .markdown-rendered ul, .markdown-rendered ol { padding-inline-start: 0; margin-block: 16px; }
    .markdown-rendered ul > li { margin-inline-start: 3ch; }
    .markdown-rendered ol > li { margin-inline-start: 4ch; }
    .markdown-rendered ul ul, .markdown-rendered ul ol, .markdown-rendered ol ul, .markdown-rendered ol ol { margin-block: 0; }
    .markdown-rendered li p { margin-block: 16px; }
  `;
  const style = document.createElement("style"); style.textContent = readFileSync("styles.css", "utf8");
  const root = document.createElement("div"); root.className = "tablebase-root";
  const preview = document.createElement("div"); preview.className = "tb-markdown-content markdown-rendered has-source-line-breaks";
  preview.innerHTML = '<ul>\n<li>one<br>\ncontinued\n<ol>\n<li>nested</li>\n</ol>\n</li>\n<li><p>two</p>\n<p>another paragraph</p></li>\n</ul>\n<p>Link</p><pre><code>a\n\nb\n</code></pre>';
  root.append(preview); document.head.append(hostStyle, style); document.body.append(root);
  try {
    const source = "- one\n  continued\n  1. nested\n- two\n\n  another paragraph\n\n[Link](https://example.com)\n\n```\na\n\nb\n```";
    normalizeMarkdownPreviewLineBreaks(preview, source);
    assert.equal(dom.window.getComputedStyle(preview).whiteSpace, "normal", "host HTML formatting newlines must not become line boxes");
    for (const list of preview.querySelectorAll<HTMLElement>("ul, ol")) {
      assert.equal(dom.window.getComputedStyle(list).paddingInlineStart, "0", "the plugin must not add a second list indent");
    }
    assert.equal(dom.window.getComputedStyle(preview.querySelector("li")!).marginInlineStart, "3ch");
    assert.equal(dom.window.getComputedStyle(preview.querySelector("ol li")!).marginInlineStart, "4ch");
    assert.equal(dom.window.getComputedStyle(preview.querySelector("ol")!).marginBlock, "0");
    assert.equal(dom.window.getComputedStyle(preview.querySelector("li p")!).marginBlock, "16px", "loose-list paragraphs retain the host's spacing");
    assert.equal(preview.querySelector("li br")!.nextSibling!.textContent, "continued\n");
    assert.equal(preview.querySelector("pre code")!.textContent, "a\n\nb\n");
    assert.equal(dom.window.getComputedStyle(preview.querySelector("pre code")!).whiteSpace, "pre-wrap");
    const paragraph = document.createElement("p"); paragraph.className = "tb-markdown-source-paragraph";
    paragraph.textContent = "one  two\nthree"; preview.append(paragraph);
    assert.equal(dom.window.getComputedStyle(paragraph).whiteSpace, "pre-wrap");
    assert.equal(dom.window.getComputedStyle(paragraph).marginBlock, "0");
    preview.classList.add("is-markdown-pending");
    assert.equal(dom.window.getComputedStyle(preview).whiteSpace, "pre-wrap", "the raw source shown before rendering still preserves whitespace");
  } finally { root.remove(); hostStyle.remove(); style.remove(); }
});
function installObsidianTaskCheckboxDOM(states: () => boolean[]): () => void {
  const original = MarkdownRenderer.render;
  MarkdownRenderer.render = async (_app, _markdown, element) => {
    // Supply the DOM shape Obsidian exposes for a task list; this tests the table's
    // event/save glue, not Markdown parsing or how Obsidian creates that DOM.
    const list = document.createElement("ul");
    states().forEach((checked) => {
      const item = document.createElement("li"); item.classList.add("task-list-item");
      const checkbox = document.createElement("input"); checkbox.type = "checkbox";
      checkbox.classList.add("task-list-item-checkbox"); checkbox.checked = checked;
      item.append(checkbox, document.createTextNode(" task")); list.append(item);
    });
    element.replaceChildren(list);
  };
  return () => { MarkdownRenderer.render = original; };
}
test("[markdown] rendered Markdown task click saves the mapped source line and serializes concurrent toggles", async () => {
  const table = fixture(); delete table.views[0].sort; delete table.views[0].group;
  const field = table.fields[0]; const source = "- [ ] first\n- [x] second\n- [ ] third";
  table.records[0].values[field.id] = source;
  let renderedStates = [false, true, false];
  const restoreRenderer = installObsidianTaskCheckboxDOM(() => renderedStates);
  const root = document.createElement("div"); document.body.append(root);
  const snapshots: TableDocument[] = []; let finishSave!: (body: string) => void;
  const pendingSave = new Promise<string>((resolve) => { finishSave = resolve; });
  const controller = renderTable({ app: {} } as any, JSON.stringify(table), {
    root, sourcePath: "task.md",
    save: async (_, next) => { snapshots.push(JSON.parse(JSON.stringify(next))); return pendingSave; },
  });
  try {
    await waitForCondition(() => root.querySelectorAll(".tb-markdown-task-toggle").length === 3, "Obsidian task checkbox DOM adaptation");
    const originalCell = root.querySelector<HTMLTableCellElement>(`tr[data-row-id="${table.records[0].id}"] td[data-field-id="${field.id}"]`)!;
    const toggles = [...originalCell.querySelectorAll<HTMLButtonElement>(".tb-markdown-task-toggle")];
    click(toggles[0]);
    await waitForCondition(() => snapshots.length === 1, "task-list save callback");
    assert.equal(snapshots[0].records[0].values[field.id], "- [x] first\n- [x] second\n- [ ] third");
    assert.ok(toggles.every((toggle) => toggle.disabled), "all controls in the cell are disabled during the queued write");
    renderedStates = [true, true, false];
    click(toggles[2]);
    assert.equal(snapshots.length, 1, "a stale, disabled task control cannot enqueue a second write");
    finishSave(JSON.stringify(snapshots[0]));
    await waitForCondition(() => !originalCell.isConnected, "task save and cell refresh");
    const updated = root.querySelector<HTMLTableCellElement>(`tr[data-row-id="${table.records[0].id}"] td[data-field-id="${field.id}"]`)!;
    await waitForCondition(() => updated.querySelector<HTMLButtonElement>(".tb-markdown-task-toggle")?.getAttribute("aria-checked") === "true", "updated task preview");
    assert.deepEqual([...updated.querySelectorAll<HTMLButtonElement>(".tb-markdown-task-toggle")].map((toggle) => toggle.getAttribute("aria-checked")), ["true", "true", "false"]);
  } finally { controller.destroy(); root.remove(); restoreRenderer(); }
});
test("[markdown] failed Markdown task save restores the source checkbox state and allows retry", async () => {
  const table = fixture(); delete table.views[0].sort; delete table.views[0].group;
  const field = table.fields[0]; const source = "- [ ] first\n- [x] second";
  table.records[0].values[field.id] = source;
  const restoreRenderer = installObsidianTaskCheckboxDOM(() => [false, true]);
  const root = document.createElement("div"); document.body.append(root);
  const noticeCount = notices.length; let writes = 0;
  const controller = renderTable({ app: {} } as any, JSON.stringify(table), {
    root, sourcePath: "task-failure.md",
    save: async () => { writes++; throw new Error("read only"); },
  });
  try {
    await waitForCondition(() => root.querySelectorAll(".tb-markdown-task-toggle").length === 2, "initial task preview");
    const originalCell = root.querySelector<HTMLTableCellElement>(`tr[data-row-id="${table.records[0].id}"] td[data-field-id="${field.id}"]`)!;
    click(originalCell.querySelector(".tb-markdown-task-toggle")!);
    await waitForCondition(() => !originalCell.isConnected && notices.length === noticeCount + 1, "failed task write rollback");
    const restored = root.querySelector<HTMLTableCellElement>(`tr[data-row-id="${table.records[0].id}"] td[data-field-id="${field.id}"]`)!;
    await waitForCondition(() => restored.querySelectorAll(".tb-markdown-task-toggle").length === 2, "restored task preview");
    assert.deepEqual([...restored.querySelectorAll<HTMLButtonElement>(".tb-markdown-task-toggle")].map((toggle) => toggle.getAttribute("aria-checked")), ["false", "true"]);
    assert.ok([...restored.querySelectorAll<HTMLButtonElement>(".tb-markdown-task-toggle")].every((toggle) => !toggle.disabled), "a failed write should permit retry");
    assert.equal(writes, 1);
  } finally { controller.destroy(); root.remove(); restoreRenderer(); }
});
test("[markdown] task checkbox DOM with an unreliable source mapping is disabled", async () => {
  const table = fixture(); delete table.views[0].sort; delete table.views[0].group;
  const field = table.fields[0]; table.records[0].values[field.id] = "- [ ] first\n- [ ] second";
  const restoreRenderer = installObsidianTaskCheckboxDOM(() => [false]);
  const root = document.createElement("div"); document.body.append(root);
  const controller = renderTable({ app: {} } as any, JSON.stringify(table), { root, sourcePath: "task-map-mismatch.md", save: async (_, next) => JSON.stringify(next) });
  try {
    await waitForCondition(() => {
      const input = root.querySelector<HTMLInputElement>("input.task-list-item-checkbox");
      return !!input?.disabled;
    }, "fail-closed task checkbox mapping");
    const input = root.querySelector<HTMLInputElement>("input.task-list-item-checkbox")!;
    assert.equal(input.getAttribute("aria-disabled"), "true");
    assert.equal(input.getAttribute("aria-label"), "Task list mapping is unavailable.");
    assert.equal(root.querySelector(".tb-markdown-task-toggle"), null);
  } finally { controller.destroy(); root.remove(); restoreRenderer(); }
});
test("[storage][data-format][table-block] actual Reading view and Live Preview cell saves preserve opaque data", async () => {
  for (const mode of ["reading", "live-preview"]) {
    const raw = fixtureWithOpaqueData(); const source = JSON.stringify(raw);
    const original = `before\n\n\`\`\`super-table\n${source}\n\`\`\`\n\nafter`;
    let note = original; let writes = 0;
    const plugin = { app: {
      workspace: { getActiveViewOfType: () => mode === "reading" ? null : { file: { path: "test.md" }, getMode: () => "source", containerEl: document.body } },
      vault: { getAbstractFileByPath: () => new TFile("test.md"), process: async (_: unknown, update: (text: string) => string) => { note = update(note); writes++; } },
    } } as any;
    const extension = tableEditorExtension(plugin) as any[];
    let state = EditorState.create({ doc: original, extensions: [editorInfoField, editorLivePreviewField, extension] });
    let widget: any;
    state.field(extension[0]).between(0, state.doc.length, (_from: number, _to: number, decoration: any) => { widget = decoration.spec.widget; });
    const scrollDOM = document.createElement("div"); document.body.append(scrollDOM);
    const view = { dom: document.createElement("div"), scrollDOM, get state() { return state; }, requestMeasure() {}, dispatch(spec: any) { state = state.update(spec).state; writes++; } };
    const root = mode === "reading" ? document.createElement("div") : widget.toDOM(view);
    document.body.append(root);
    const controller = mode === "reading" ? renderTable(plugin, source, { root, sourcePath: "test.md" }) : widget;
    try {
      assert.equal(writes, 0);
      await editTextCell(root, "Unrelated edit");
      const savedNote = mode === "reading" ? note : state.doc.toString();
      const expected = JSON.parse(source); expected.records[0].values[raw.fields[0].id] = "Unrelated edit";
      assert.equal(writes, 1, mode);
      assert.deepEqual(JSON.parse(scanFencedBlocks(savedNote)[0].body), expected, mode);
      assert.ok(savedNote.startsWith("before\n\n")); assert.ok(savedNote.endsWith("\n\nafter"));
      assert.deepEqual(readTable(scanFencedBlocks(savedNote)[0].body), expected);
    } finally { controller.destroy(); root.remove(); scrollDOM.remove(); }
  }
});
test("[data-format][table-block][localization] unsafe data shows its location without editable controls or note writes", () => {
  try {
    for (const language of ["en", "zh-CN"]) for (const kind of ["cell", "option"]) {
      setLanguage(language);
      const raw = fixtureWithOpaqueData();
      if (kind === "cell") { raw.fields[0].type = "checkbox"; raw.records[0].values[raw.fields[0].id] = 1; }
      else delete raw.fields[1].options[0].label;
      const source = JSON.stringify(raw); const note = `\`\`\`super-table\n${source}\n\`\`\``;
      let writes = 0;
      const plugin = { app: { workspace: { getActiveViewOfType: () => null }, vault: { process: () => { writes++; } } } } as any;
      const root = document.createElement("div"); document.body.append(root);
      const controller = renderTable(plugin, source, { root, sourcePath: "test.md" });
      try {
        assert.ok(root.classList.contains("tb-invalid"));
        assert.equal(root.querySelector("pre")?.textContent, source);
        assert.equal(root.querySelector("table, textarea, input, button"), null);
        assert.match(root.querySelector("p")!.textContent!, language === "en" ? /Editing is disabled/ : /已禁用编辑/);
        assert.ok(root.textContent!.includes(kind === "cell" ? `records[0].values.${raw.fields[0].id}` : "fields[1].options[0]"));
        const extension = tableEditorExtension(plugin) as any[];
        const state = EditorState.create({ doc: note, extensions: [editorInfoField, editorLivePreviewField, extension] });
        assert.equal(state.field(extension[0]).size, 0, "unsafe Live Preview blocks remain source for repair");
        assert.equal(state.doc.toString(), note);
        assert.equal(writes, 0);
      } finally { controller.destroy(); root.remove(); }
    }
  } finally { setLanguage("en"); }
});
test("[data-format][table-block][localization] duplicate IDs disable table editing and preserve raw data in both languages", () => {
  try {
    for (const language of ["en", "zh-CN"]) for (const kind of ["view", "select", "multiselect", "status"]) {
      setLanguage(language);
      const raw = fixtureWithOpaqueData(); const field = raw.fields[1];
      if (kind === "view") raw.views.push({ ...raw.views[0], name: "Second view" });
      else { field.type = kind; field.options.push({ ...field.options[0], label: "Another option" }); }
      const source = JSON.stringify(raw); const note = `\`\`\`super-table\n${source}\n\`\`\``;
      let writes = 0;
      const plugin = { app: { workspace: { getActiveViewOfType: () => null } } } as any;
      const root = document.createElement("div"); document.body.append(root);
      const controller = renderTable(plugin, source, { root, sourcePath: "duplicate-ids.md", save: async () => { writes++; return source; } });
      try {
        assert.ok(root.classList.contains("tb-invalid"));
        assert.equal(root.querySelector("pre")?.textContent, source);
        assert.equal(root.querySelector("table, textarea, input, button"), null);
        assert.equal(root.querySelector("p")?.textContent, kind === "view"
          ? t("Duplicate view identifier: {id}.", { id: raw.views[0].id })
          : t("Duplicate option identifier in field {field}: {id}.", { field: field.id, id: field.options[0].id }));
        const extension = tableEditorExtension(plugin) as any[];
        const state = EditorState.create({ doc: note, extensions: [editorInfoField, editorLivePreviewField, extension] });
        assert.equal(state.field(extension[0]).size, 0);
        assert.equal(state.doc.toString(), note); assert.equal(writes, 0);
      } finally { controller.destroy(); root.remove(); }
    }
  } finally { setLanguage("en"); }
});
test("[storage][table-block][localization] empty tables use localized defaults without writing on selection; invalid data and unknown sections stay safe", async () => {
  try {
    for (const language of ["en", "zh-CN"]) {
      setLanguage(language);
      let note = "```super-table\n```"; let writes = 0;
      const plugin = { app: {
        workspace: { getActiveViewOfType: () => null },
        vault: { getAbstractFileByPath: () => new TFile("note.md"), process: async (_: unknown, update: (text: string) => string) => { note = update(note); writes++; } },
      } } as any;
      const root = document.createElement("div"); document.body.append(root);
      const controller = renderTable(plugin, " \t\n", { root, sourcePath: "note.md", emptySection: () => null });
      try {
        const preview = root.querySelector<HTMLElement>(".tb-markdown-content"); assert.ok(preview);
        assert.equal(preview.textContent, language === "en" ? "First task" : "第一个任务");
        assert.equal(root.querySelector("textarea.tb-markdown-editor"), null);
        const cell = preview.closest<HTMLTableCellElement>("td")!;
        pointerClick(cell);
        assert.equal(writes, 0);
        assert.equal(cell.querySelector(".tb-markdown-edit"), null);
        assert.equal(cell.querySelector("textarea.tb-markdown-editor"), null);
        const noticeCount = notices.length;
        pointerClick(cell);
        const input = cell.querySelector<HTMLTextAreaElement>("textarea.tb-markdown-editor"); assert.ok(input);
        input.value = "Cannot locate source"; input.blur(); await settle();
        assert.equal(writes, 0); assert.equal(note, "```super-table\n```"); assert.equal(notices.length, noticeCount + 1);
      } finally { controller.destroy(); root.remove(); }
      const invalidRoot = document.createElement("div");
      const invalid = renderTable(plugin, "{broken", { root: invalidRoot, sourcePath: "note.md" });
      assert.ok(invalidRoot.classList.contains("tb-invalid")); assert.equal(invalidRoot.querySelector("pre")!.textContent, "{broken");
      assert.equal(invalidRoot.querySelector("textarea"), null); assert.equal(writes, 0); invalid.destroy();
    }
  } finally { setLanguage("en"); }
});
test("[storage][table-block] live preview keeps empty tables independent across mapped edits, first saves and undo", async () => {
  const original = "before\n```super-table\n```\nbetween\n  ```super-table\n  \t\n  ```\nafter\n```super-table\n{broken\n```";
  const extension = tableEditorExtension(livePreviewPlugin() as any) as any[]; const field = extension[0];
  let state = EditorState.create({ doc: original, extensions: [editorInfoField, editorLivePreviewField, extension] });
  const widgets = () => {
    const result: any[] = [];
    state.field(field).between(0, state.doc.length, (_from: number, _to: number, decoration: any) => { result.push(decoration.spec.widget); });
    return result;
  };
  const initial = widgets(); assert.equal(initial.length, 2); assert.notEqual(initial[0].id, initial[1].id);
  assert.equal(state.doc.toString(), original);
  state = state.update({ changes: { from: 0, insert: "Heading\n" } }).state;
  assert.deepEqual(widgets().map((widget) => widget.id), initial.map((widget) => widget.id));
  const beforeSave = state.doc.toString(); const inverses: any[] = [];
  const scrollDOM = document.createElement("div"); document.body.append(scrollDOM);
  const view = { dom: document.createElement("div"), scrollDOM, get state() { return state; }, requestMeasure() {}, dispatch(spec: any) {
    const transaction = state.update(spec); inverses.push(transaction.changes.invert(state.doc)); state = transaction.state;
  } };
  const mounted = widgets().map((widget) => { const root = widget.toDOM(view); document.body.append(root); return { widget, root }; });
  const edit = (index: number, value: string) => editTextCell(mounted[index].root, value);
  try {
    await edit(1, "Second table");
    let blocks = scanFencedBlocks(state.doc.toString()); assert.equal(blocks[0].body, "");
    const second = readTable(blocks[1].body); assert.equal(second.tableId, initial[1].id); assert.equal(blocks[1].indent, "  ");
    assert.equal(second.records[0].values[second.fields[0].id], "Second table");
    await edit(0, "First table"); await edit(1, "Second edit");
    blocks = scanFencedBlocks(state.doc.toString());
    const first = readTable(blocks[0].body); assert.equal(first.tableId, initial[0].id);
    assert.equal(first.records[0].values[first.fields[0].id], "First table");
    assert.equal(readTable(blocks[1].body).records[0].values[second.fields[0].id], "Second edit");
    assert.equal(blocks[2].body, "{broken");
    while (inverses.length) state = state.update({ changes: inverses.pop() }).state;
    assert.equal(state.doc.toString(), beforeSave); assert.equal(widgets().length, 2);
    const retry = widgets()[0]; const root = retry.toDOM(view); document.body.append(root);
    try {
      await editTextCell(root, "After undo");
      assert.equal(readTable(scanFencedBlocks(state.doc.toString())[0].body).tableId, retry.id);
    } finally { retry.destroy(); root.remove(); }
  } finally { mounted.forEach(({ widget, root }) => { widget.destroy(); root.remove(); }); scrollDOM.remove(); }
  const raw = EditorState.create({ doc: original, extensions: [editorInfoField, extension] }); assert.equal(raw.field(field).size, 0);
});
test("[storage][table-block] a stale empty live-preview widget cannot overwrite a replaced or removed block", async () => {
  for (const replacement of ["{broken\n", "removed\n"]) {
    const original = "```super-table\n```\n\n```super-table\n```";
    const extension = tableEditorExtension(livePreviewPlugin() as any) as any[]; const field = extension[0];
    let state = EditorState.create({ doc: original, extensions: [editorInfoField, editorLivePreviewField, extension] });
    let widget: any;
    state.field(field).between(0, 0, (_from: number, _to: number, decoration: any) => { widget = decoration.spec.widget; });
    const view = { dom: document.createElement("div"), get state() { return state; }, requestMeasure() {}, dispatch(spec: any) { state = state.update(spec).state; } };
    const root = widget.toDOM(view); document.body.append(root);
    try {
      state = replacement.startsWith("{") ? state.update({ changes: { from: state.doc.line(2).from, insert: replacement } }).state
        : state.update({ changes: { from: 0, to: state.doc.line(3).from, insert: replacement } }).state;
      const external = state.doc.toString();
      const noticeCount = notices.length;
      await editTextCell(root, "Must not save");
      assert.equal(state.doc.toString(), external); assert.equal(notices.length, noticeCount + 1);
      assert.match(notices.at(-1)!, /removed or its ID/);
    } finally { widget.destroy(); root.remove(); }
  }
});
test("[storage][table-block] reading-view processor initializes empty blocks lazily and fetches current section info only for the first save", async () => {
  let note = "```super-table\n```\n\n```super-table\n \t\n```"; const original = note;
  let processor: any; let sectionReads = 0;
  const plugin = Object.assign(new SuperTablePlugin({} as any, {} as any), {
    app: {
      workspace: { on: () => {}, getActiveViewOfType: () => null },
      vault: { getAbstractFileByPath: () => new TFile("note.md"), process: async (_: unknown, update: (text: string) => string) => { note = update(note); } },
    },
    registerEditorExtension() {}, registerMarkdownCodeBlockProcessor: (_: string, callback: any) => { processor = callback; },
    registerEvent() {}, addRibbonIcon() {}, addCommand() {},
  });
  await plugin.onload();
  const children: any[] = []; const roots: HTMLElement[] = [];
  for (let index = 0; index < 2; index++) {
    const root = document.createElement("div"); roots.push(root); document.body.append(root);
    processor(index ? " \t" : "", root, { sourcePath: "note.md", addChild: (child: any) => { children.push(child); child.onload(); }, getSectionInfo: () => {
      sectionReads++; const block = scanFencedBlocks(note)[index]; return { text: note, lineStart: block.startLine, lineEnd: block.endLine };
    } });
  }
  const edit = (index: number, value: string) => editTextCell(roots[index], value);
  try {
    assert.equal(note, original); assert.equal(sectionReads, 0);
    assert.equal(roots[0].querySelectorAll("tbody tr[data-row-id]").length, 2);
    await edit(0, "First"); await edit(1, "Second"); await edit(0, "Again");
    const tables = scanFencedBlocks(note).map((block) => readTable(block.body));
    assert.notEqual(tables[0].tableId, tables[1].tableId); assert.equal(sectionReads, 2);
    assert.equal(tables[0].records[0].values[tables[0].fields[0].id], "Again");
    assert.equal(tables[1].records[0].values[tables[1].fields[0].id], "Second");
  } finally { children.forEach((child) => child.onunload()); roots.forEach((root) => root.remove()); }
});
test("[storage][table-block] live-preview saves preserve multiline indentation and transaction rollback restores compact data", async () => {
  const table = fixture(); delete table.views[0].sort; delete table.views[0].group;
  const original = `before\n\n  \`\`\`super-table\n  ${JSON.stringify(table)}\n  \`\`\`\n\nafter`;
  const extension = tableEditorExtension(livePreviewPlugin() as any) as any[]; const field = extension[0];
  let state = EditorState.create({ doc: original, extensions: [editorInfoField, editorLivePreviewField, extension] });
  let widget: any;
  state.field(field).between(0, state.doc.length, (_from: number, _to: number, decoration: any) => { widget = decoration.spec.widget; });
  const inverses: any[] = [];
  const scrollDOM = document.createElement("div"); document.body.append(scrollDOM);
  const view = {
    dom: document.createElement("div"), scrollDOM, get state() { return state; }, requestMeasure() {},
    dispatch(spec: any) {
      const transaction = state.update(spec);
      inverses.push(transaction.changes.invert(state.doc)); state = transaction.state;
    },
  };
  const root = widget.toDOM(view); document.body.append(root);
  try {
    const edit = async (value: string) => {
      await editTextCell(root, value);
    };
    await edit("First edit");
    const first = state.doc.toString(); const block = scanFencedBlocks(first)[0];
    assert.equal(block.indent, "  "); assert.equal(block.body, widget.body);
    assert.equal(readTable(block.body).records[0].values[table.fields[0].id], "First edit");
    assert.ok(first.startsWith("before\n\n  ```super-table\n  {\n")); assert.ok(first.endsWith("\n  ```\n\nafter"));
    await edit("Second edit\nwith a newline");
    assert.equal(inverses.length, 2);
    assert.equal(readTable(scanFencedBlocks(state.doc.toString())[0].body).records[0].values[table.fields[0].id], "Second edit\nwith a newline");
    state = state.update({ changes: inverses.pop() }).state;
    assert.equal(state.doc.toString(), first); assert.equal(state.field(field).size, 1);
    state = state.update({ changes: inverses.pop() }).state;
    assert.equal(state.doc.toString(), original); assert.equal(state.field(field).size, 1);
  } finally { widget.destroy(); root.remove(); scrollDOM.remove(); }
});
test("[storage][table-block] live-preview save restores the CodeMirror scroll position after layout shifts", async () => {
  const table = fixture(); delete table.views[0].sort; delete table.views[0].group;
  const original = serializeTable(table);
  const extension = tableEditorExtension(livePreviewPlugin() as any) as any[]; const field = extension[0];
  let state = EditorState.create({ doc: original, extensions: [editorInfoField, editorLivePreviewField, extension] });
  let widget: any;
  state.field(field).between(0, state.doc.length, (_from: number, _to: number, decoration: any) => { widget = decoration.spec.widget; });
  const win = dom.window;
  const scrollDOM = document.createElement("div"); document.body.append(scrollDOM);
  scrollDOM.style.overflowY = "auto";
  Object.defineProperties(scrollDOM, { clientHeight: { value: 400 }, scrollHeight: { value: 1500 } });
  scrollDOM.scrollTop = 480; scrollDOM.scrollLeft = 67;
  const view = {
    dom: scrollDOM, scrollDOM, get state() { return state; }, requestMeasure() {},
    dispatch(spec: any) {
      state = state.update(spec).state;
      win.requestAnimationFrame(() => { scrollDOM.scrollTop = 0; scrollDOM.scrollLeft = 0; });
    },
  };
  const root = widget.toDOM(view); scrollDOM.append(root);
  const prototype = dom.window.HTMLElement.prototype; const originalRect = prototype.getBoundingClientRect;
  prototype.getBoundingClientRect = function () {
    if (root.contains(this) || this === root) {
      const top = 500 - scrollDOM.scrollTop;
      return { top, bottom: top + 40, left: 0, right: 800, width: 800, height: 40, x: 0, y: top, toJSON() {} } as DOMRect;
    }
    return originalRect.call(this);
  };
  try {
    await editTextCell(root, "Saved while scrolled");
    let updatedWidget: any;
    state.field(field).between(0, state.doc.length, (_from: number, _to: number, decoration: any) => { updatedWidget = decoration.spec.widget; });
    assert.strictEqual(updatedWidget, widget, "a table's own cell save should retain its Live Preview widget instead of refreshing the table");
    assert.equal(widget.body, scanFencedBlocks(state.doc.toString())[0].body.trim());
    for (let frame = 0; frame < 3; frame++) await new Promise<void>((resolve) => win.requestAnimationFrame(() => resolve()));
    assert.equal(scrollDOM.scrollTop, 480);
    assert.equal(scrollDOM.scrollLeft, 67);
    assert.equal(readTable(scanFencedBlocks(state.doc.toString())[0].body).records[0].values[table.fields[0].id], "Saved while scrolled");
  } finally { widget.destroy(); root.remove(); scrollDOM.remove(); prototype.getBoundingClientRect = originalRect; }
});
test("[storage][table-block][layout] saving a lower-row choice keeps the tall widget in CodeMirror's height map", async () => {
  const table = fixture(); delete table.views[0].sort; delete table.views[0].group;
  table.records = Array.from({ length: 40 }, (_, index) => ({ id: `tall-${index}`, values: { ...table.records[0].values } }));
  const parent = document.createElement("div"); document.body.append(parent);
  const note = "before\n\n" + serializeTable(table) + "\n\n" + "after\n".repeat(80);
  const blockFrom = note.indexOf("```super-table");
  const extension = tableEditorExtension(livePreviewPlugin() as any);
  let heightDuringSave = 0;
  const editor = new EditorView({
    state: EditorState.create({ doc: note, extensions: [editorInfoField, editorLivePreviewField, extension] }), parent,
    dispatchTransactions(transactions, view) {
      view.update(transactions);
      heightDuringSave = view.lineBlockAt(blockFrom).height;
    },
  });
  try {
    const root = parent.querySelector<HTMLElement>(".tb-live-preview")!;
    assert.ok(root);
    let renderedHeight = 1985;
    Object.defineProperty(root, "offsetHeight", { get: () => renderedHeight });
    const choice = table.fields[1];
    const chooseLastRow = async (label: string) => {
      const cell = root.querySelector<HTMLElement>(`tr[data-row-id="tall-39"] td[data-field-id="${choice.id}"]`)!;
      pointerClick(cell);
      click(byLabel(cell, `Choose ${choice.name}`));
      shownMenus.at(-1)!.items.find((item) => item.title === label)!.action!({});
      for (let i = 0; i < 10; i++) await Promise.resolve();
    };
    await chooseLastRow("MAC");
    assert.equal(heightDuringSave, 1985, "the transaction must not estimate a multi-screen table as one line before DOM measurement");
    assert.strictEqual(parent.querySelector(".tb-live-preview"), root, "the existing table must remain rendered");
    assert.equal(readTable(scanFencedBlocks(editor.state.doc.toString())[0].body).records[39].values[choice.id], choice.options![1].id);
    renderedHeight = 2400;
    await chooseLastRow("PC");
    assert.equal(heightDuringSave, 2400, "subsequent saves use the current height after layout changes");
  } finally { editor.destroy(); parent.remove(); }
});
test("[storage][views][layout] editing the sort field keeps its moved cell anchored after all editor save frames", async () => {
  const table = fixture(); delete table.views[0].group;
  table.views[0].sort = { fieldId: table.fields[0].id, direction: "asc" };
  table.records = Array.from({ length: 30 }, (_, index) => ({ id: `sorted-${index}`, values: { ...table.records[0].values, [table.fields[0].id]: `Item ${String(index).padStart(2, "0")}` } }));
  const scroller = document.createElement("div"); scroller.style.overflowY = "auto";
  Object.defineProperties(scroller, { clientHeight: { value: 600 }, scrollHeight: { value: 2500 } });
  document.body.append(scroller); scroller.scrollTop = 120;
  const view = { file: { path: "test.md" }, getMode: () => "source", containerEl: scroller };
  const plugin = { app: { workspace: { getActiveViewOfType: () => view } } } as any;
  const extension = tableEditorExtension(plugin) as any[]; const field = extension[0];
  let state = EditorState.create({ doc: serializeTable(table), extensions: [editorInfoField, editorLivePreviewField, extension] });
  let widget: any;
  state.field(field).between(0, state.doc.length, (_from: number, _to: number, decoration: any) => { widget = decoration.spec.widget; });
  const editor = { dom: scroller, scrollDOM: scroller, get state() { return state; }, requestMeasure() {},
    dispatch(spec: any) { state = state.update(spec).state; },
  };
  const prototype = dom.window.HTMLElement.prototype; const previousRect = prototype.getBoundingClientRect;
  let root: HTMLElement;
  prototype.getBoundingClientRect = function () {
    const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 800, width: 800, height, x: 0, y: top, toJSON() {} }) as DOMRect;
    if (this === scroller) return rect(0, 600);
    if (root && (this === root || root.contains(this))) {
      const row = this.closest("tr.tb-data-row"); const index = row ? [...root.querySelectorAll("tr.tb-data-row")].indexOf(row) : 0;
      return rect(140 + index * 40 - scroller.scrollTop, 40);
    }
    return previousRect.call(this);
  };
  try {
    root = widget.toDOM(editor); scroller.append(root);
    await editTextCell(root, "ZZZ sorted last");
    for (let i = 0; i < 4; i++) await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
    assert.equal(scroller.scrollTop, 1280, "the editor offset fallback must not undo the moved cell anchor");
    root.querySelector("td.tb-cell")!.append(document.createTextNode("late rendering"));
    for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
    assert.equal(scroller.scrollTop, 1280);
  } finally { widget.destroy(); scroller.remove(); prototype.getBoundingClientRect = previousRect; }
});
function mount(table = fixture(), preserveView = false, parent: HTMLElement = document.body,
  app: any = { workspace: { getActiveViewOfType: () => undefined } }) {
  if (!preserveView) { delete table.views[0].sort; delete table.views[0].group; }
  const root = document.createElement("div"); parent.append(root); let saved: TableDocument | null = null;
  const controller = renderTable({ app } as any, JSON.stringify(table), { root, sourcePath: `${table.tableId}.md`, save: async (_, next) => { saved = next; return JSON.stringify(next); } });
  return { root, table, controller, saved: () => saved, cleanup: () => { const filter = root.querySelector<HTMLButtonElement>(".tb-filter-toggle"); if (filter?.getAttribute("aria-expanded") === "true") click(filter); controller.destroy(); root.remove(); } };
}
const click = (element: Element) => element.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true }));
function pointerClick(element: HTMLElement): void {
  element.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
  element.focus();
  click(element);
}
function pasteClipboardText(target: Element, text: string): ClipboardEvent {
  const event = new dom.window.Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  Object.defineProperty(event, "clipboardData", { value: { getData: (type: string) => type === "text/plain" ? text : "" } });
  target.dispatchEvent(event);
  return event;
}
function clipboardImageFile(name: string, type: string, bytes = [1, 255, 42]): File {
  const file = new dom.window.File([new Uint8Array(bytes)], name, { type }) as unknown as File;
  Object.defineProperty(file, "arrayBuffer", { configurable: true, value: async () => new Uint8Array(bytes).buffer });
  return file;
}
function pasteClipboardImage(target: Element, file: File): ClipboardEvent {
  const event = new dom.window.Event("paste", { bubbles: true, cancelable: true }) as ClipboardEvent;
  const item = { kind: "file", type: file.type, getAsFile: () => file };
  Object.defineProperty(event, "clipboardData", { value: { items: [item], files: [file], getData: () => "" } });
  target.dispatchEvent(event);
  return event;
}
function openMarkdownEditor(cell: HTMLTableCellElement): HTMLTextAreaElement {
  pointerClick(cell);
  assert.equal(cell.querySelector(".tb-markdown-edit"), null, "text cells should not show an edit button");
  assert.equal(cell.querySelector(".tb-markdown-editor"), null, "the first click should only select the cell");
  pointerClick(cell);
  const input = cell.querySelector<HTMLTextAreaElement>(".tb-markdown-editor");
  assert.ok(input, "the next click should open the Markdown source editor");
  assert.ok(cell.classList.contains("is-cell-editing"), "the text editor should mark its cell as editing");
  return input;
}
function dragDataTransfer() {
  const values = new Map<string, string>();
  return {
    types: [] as string[], effectAllowed: "none",
    setData(type: string, value: string) { values.set(type, value); this.types = [...values.keys()]; },
    getData(type: string) { return values.get(type) ?? ""; },
  };
}
function dispatchDrag(target: Element, type: string, dataTransfer: ReturnType<typeof dragDataTransfer>, clientY = 0) {
  const event = new dom.window.Event(type, { bubbles: true, cancelable: true }) as Event & { dataTransfer: typeof dataTransfer; clientY: number };
  Object.defineProperties(event, { dataTransfer: { value: dataTransfer }, clientY: { value: clientY } });
  target.dispatchEvent(event);
  return event;
}
const byLabel = (root: Element, label: string) => [...root.querySelectorAll<HTMLElement>("[aria-label], [aria-labelledby]")].find((element) => {
  if (element.getAttribute("aria-label") === label) return true;
  return element.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? "").join(" ") === label;
})!;
const closeDisplayConfig = () => document.querySelector<HTMLButtonElement>(".tb-display-config-close")?.click();
const byEditorName = (root: Element, label: string) => [...root.querySelectorAll<HTMLElement>("[aria-labelledby], button, input, select, textarea")].find((element) => {
  const labelledBy = element.getAttribute("aria-labelledby")?.split(/\s+/).map((id) => document.getElementById(id)?.textContent?.trim() ?? "").join(" ");
  if (labelledBy === label) return true;
  if (element.matches("button") && element.textContent?.trim() === label) return true;
  if (!element.matches("input, select, textarea")) return false;
  const wrapper = element.closest("label");
  if (!wrapper) return false;
  const text = wrapper.cloneNode(true) as HTMLLabelElement;
  text.querySelectorAll("input, select, textarea").forEach((control) => control.remove());
  return text.textContent?.trim() === label;
})!;

function mountWithHistory(table = fixture()) {
  const root = document.createElement("div"); document.body.append(root);
  const calls = { undo: 0, redo: 0 };
  const view = { file: { path: `${table.tableId}.md` }, getMode: () => "source", containerEl: document.body, editor: {
    undo() { calls.undo++; }, redo() { calls.redo++; },
  } };
  const plugin = { app: { workspace: { getActiveViewOfType: () => view } } };
  const controller = renderTable(plugin as any, JSON.stringify(table), {
    root, sourcePath: `${table.tableId}.md`, save: async (_, next) => JSON.stringify(next),
  });
  return { root, table, calls, controller, view, cleanup: () => { const filter = root.querySelector<HTMLButtonElement>(".tb-filter-toggle"); if (filter?.getAttribute("aria-expanded") === "true") click(filter); controller.destroy(); root.remove(); } };
}

test("[interaction][storage] selected cell history shortcuts use the active note editor and focus loss clears selection", async () => {
  const ui = mountWithHistory();
  try {
    const cell = ui.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${ui.table.fields[1].id}"]`)!;
    pointerClick(cell);
    assert.ok(cell.classList.contains("is-cell-active"));
    assert.ok(cell.querySelector(".tb-cell-action"));

    const undo = new dom.window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true });
    cell.dispatchEvent(undo);
    assert.equal(ui.calls.undo, 1);
    assert.equal(undo.defaultPrevented, true);

    const redo = new dom.window.KeyboardEvent("keydown", { key: "y", ctrlKey: true, bubbles: true, cancelable: true });
    cell.dispatchEvent(redo);
    assert.equal(ui.calls.redo, 1);
    assert.equal(redo.defaultPrevented, true);

    const outside = document.createElement("button"); document.body.append(outside); outside.focus();
    await settle();
    assert.equal(cell.classList.contains("is-cell-active"), false);
    assert.equal(cell.querySelector(".tb-cell-action"), null);
    outside.remove();
  } finally { ui.cleanup(); }
});

test("[interaction][storage] widget replacement during undo preserves focus for the next redo", () => {
  const ui = mountWithHistory();
  const host = document.createElement("div"); host.className = "cm-editor"; document.body.append(host); host.append(ui.root);
  const replacement = document.createElement("div"); replacement.className = "tablebase-root";
  const replacementController = renderTable({ app: { workspace: { getActiveViewOfType: () => ui.view } } } as any, JSON.stringify(ui.table), {
    root: replacement, sourcePath: ui.view.file.path, save: async (_, next) => JSON.stringify(next),
  });
  ui.view.editor.undo = () => { ui.calls.undo++; ui.root.replaceWith(replacement); };
  try {
    pointerClick(ui.root.querySelector<HTMLTableCellElement>("td.tb-cell")!);
    ui.root.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true }));
    assert.equal(ui.calls.undo, 1); assert.ok(replacement.contains(document.activeElement));
    document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey: true, bubbles: true, cancelable: true }));
    assert.equal(ui.calls.redo, 1);
  } finally { replacementController.destroy(); ui.cleanup(); host.remove(); }
});
test("[interaction][storage] history shortcuts reach cell editors without invoking note undo", () => {
  const textUi = mountWithHistory();
  try {
    const input = openMarkdownEditor(textUi.root.querySelector<HTMLTableCellElement>("td.tb-cell")!);
    const undo = new dom.window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true });
    let reachedInput = false;
    input.addEventListener("keydown", (event) => { if (event === undo) reachedInput = true; });
    input.dispatchEvent(undo);
    assert.equal(textUi.calls.undo, 0);
    assert.equal(reachedInput, true, "the table input must receive the shortcut for native text undo");
    assert.equal(undo.defaultPrevented, false, "the editor can keep its native text undo behavior");
  } finally { textUi.cleanup(); }

  const table = fixture();
  const linkField: Field = { id: "link", name: "Link", type: "link", width: 220 };
  table.fields.push(linkField);
  table.records.forEach((row) => { row.values[linkField.id] = "https://example.com"; });
  const linkUi = mountWithHistory(table);
  try {
    const cell = linkUi.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${linkField.id}"]`)!;
    pointerClick(cell);
    click(cell.querySelector(".tb-link-edit")!);
    const input = document.querySelector<HTMLInputElement>(".tb-link-editor-text")!;
    const undo = new dom.window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true });
    let reachedInput = false;
    input.addEventListener("keydown", (event) => { if (event === undo) reachedInput = true; });
    input.dispatchEvent(undo);
    assert.equal(linkUi.calls.undo, 0);
    assert.equal(reachedInput, true, "the link input must receive the shortcut for native text undo");
    assert.equal(undo.defaultPrevented, false);
  } finally { linkUi.cleanup(); }
});

test("[interaction][storage] native input redo stays in the input even when the host prevents the shortcut", () => {
  const preventRedo = (event: KeyboardEvent) => { if (event.key === "z" && event.shiftKey) event.preventDefault(); };
  window.addEventListener("keydown", preventRedo, true);
  const ui = mountWithHistory(); const originalExec = document.execCommand; const commands: string[] = [];
  document.execCommand = (command: string) => { commands.push(command); return true; };
  try {
    const input = openMarkdownEditor(ui.root.querySelector<HTMLTableCellElement>("td.tb-cell")!);
    const redo = new dom.window.KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(redo);
    assert.deepEqual(commands, ["redo"]); assert.equal(ui.calls.redo, 0); assert.equal(redo.defaultPrevented, true);
  } finally { document.execCommand = originalExec; ui.cleanup(); window.removeEventListener("keydown", preventRedo, true); }
});
test("[interaction][storage] Live Preview history shortcuts on the surrounding editor surface reach note undo", () => {
  const ui = mountWithHistory();
  const cmEditor = document.createElement("div"); cmEditor.className = "cm-editor";
  const content = document.createElement("div"); content.className = "cm-content"; content.contentEditable = "true"; content.tabIndex = 0;
  cmEditor.append(content); document.body.append(cmEditor); content.append(ui.root);
  try {
    const cell = ui.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${ui.table.fields[1].id}"]`)!;
    pointerClick(cell);
    content.focus();
    document.getSelection()!.selectAllChildren(cell);
    const undo = new dom.window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true });
    content.dispatchEvent(undo);
    assert.equal(ui.calls.undo, 1);
    assert.equal(undo.defaultPrevented, true);
  } finally { ui.cleanup(); cmEditor.remove(); }
});

test("[interaction][storage] Live Preview table history does not capture note undo after focus leaves a selected cell", async () => {
  const ui = mountWithHistory();
  const cmEditor = document.createElement("div"); cmEditor.className = "cm-editor";
  const content = document.createElement("div"); content.className = "cm-content"; content.contentEditable = "true"; content.tabIndex = 0;
  const paragraph = document.createElement("p"); paragraph.tabIndex = 0; paragraph.textContent = "note text";
  cmEditor.append(content); document.body.append(cmEditor); content.append(ui.root, paragraph);
  try {
    const cell = ui.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${ui.table.fields[1].id}"]`)!;
    pointerClick(cell);
    assert.ok(cell.classList.contains("is-cell-active"));
    pointerClick(paragraph);
    await settle();
    assert.equal(cell.classList.contains("is-cell-active"), false);

    const undo = new dom.window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true });
    let reachedNoteEditor = false;
    paragraph.addEventListener("keydown", (event) => { if (event === undo) reachedNoteEditor = true; });
    paragraph.dispatchEvent(undo);
    assert.equal(reachedNoteEditor, true, "the focused note editor must receive Cmd-Z after focus leaves the table");
    assert.equal(ui.calls.undo, 0, "the table history must not claim note-editor Cmd-Z");
    assert.equal(undo.defaultPrevented, false);
  } finally { ui.cleanup(); cmEditor.remove(); }
});

test("[interaction][layout] undoing a Live Preview table edit after focus leaves the table preserves the note viewport", async () => {
  const table = fixture(); const source = JSON.stringify(table); const path = "test.md";
  const beforeDocument = `before\n\`\`\`super-table\n${source}\n\`\`\`\nafter`;
  let documentText = beforeDocument;
  const scroller = document.createElement("div"); scroller.style.overflowY = "visible";
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 1400 },
  });
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 400, left: 0, right: 800, width: 800, height: 400, x: 0, y: 0, toJSON() {} }) as DOMRect;
  const historyRoot = document.createElement("div"); document.body.append(historyRoot);
  const fakeEditorDom = document.createElement("div"); historyRoot.append(fakeEditorDom);
  const markdownView = { file: { path }, getMode: () => "source", containerEl: document.body, editor: { undo() {}, redo() {} } };
  const plugin = { app: { workspace: { getActiveViewOfType: () => markdownView } } };
  const editorView = {
    dom: fakeEditorDom,
    scrollDOM: scroller,
    state: { get doc() { return { toString: () => documentText }; } },
  };
  const root = document.createElement("div"); historyRoot.append(root);
  const controller = renderTable(plugin as any, source, {
    root,
    sourcePath: path,
    editorView: editorView as any,
    save: async (expectedBody, next) => {
      const body = serializeTableBody(next);
      documentText = documentText.replace(expectedBody, body);
      return body;
    },
  });
  let editor: EditorView | null = null;
  const previousMatchMedia = Object.getOwnPropertyDescriptor(dom.window, "matchMedia")!;
  const previousMutationObserver = Object.getOwnPropertyDescriptor(globalThis, "MutationObserver");
  try {
    await editTextCell(root, "edited cell");
    const afterTableEdit = documentText;
    assert.notEqual(afterTableEdit, beforeDocument);

    document.body.append(scroller);
    scroller.replaceChildren();
    Object.defineProperty(globalThis, "MutationObserver", { configurable: true, value: dom.window.MutationObserver });
    Object.defineProperty(dom.window, "matchMedia", { configurable: true, value: () => ({ matches: true, addListener() {}, removeListener() {}, addEventListener() {}, removeEventListener() {} }) });
    markdownView.containerEl = scroller;
    editor = new EditorView({
      state: EditorState.create({ doc: afterTableEdit, extensions: [editorInfoField, editorLivePreviewField, tableEditorExtension(plugin as any)] }),
      parent: scroller,
    });
    Object.defineProperties(editor.scrollDOM, {
      clientHeight: { configurable: true, value: 400 },
      scrollHeight: { configurable: true, value: 1400 },
    });
    editor.scrollDOM.scrollTop = 350;
    editor.scrollDOM.dispatchEvent(new dom.window.Event("scroll"));
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: beforeDocument } });
    editor.scrollDOM.scrollTop = 0;
    editor.scrollDOM.dispatchEvent(new dom.window.Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(editor.scrollDOM.scrollTop, 350, "native undo scroll changes should restore the viewport recorded before the table history transition");

    const noteAfterEdit = `${beforeDocument}\nsubsequent note edit`;
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: noteAfterEdit } });
    editor.scrollDOM.scrollTop = 350;
    editor.scrollDOM.dispatchEvent(new dom.window.Event("scroll"));
    editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: beforeDocument } });
    editor.scrollDOM.scrollTop = 0;
    editor.scrollDOM.dispatchEvent(new dom.window.Event("scroll"));
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(editor.scrollDOM.scrollTop, 0, "ordinary note undo should keep its native scroll behavior");
  } finally {
    editor?.destroy(); controller.destroy(); historyRoot.remove(); scroller.remove();
    Object.defineProperty(dom.window, "matchMedia", previousMatchMedia);
    if (previousMutationObserver) Object.defineProperty(globalThis, "MutationObserver", previousMutationObserver);
    else delete (globalThis as { MutationObserver?: MutationObserverConstructor }).MutationObserver;
  }
});

test("[interaction][layout] undo in a focused Live Preview table preserves the note viewport", async () => {
  const ui = mountWithHistory();
  const scroller = document.createElement("div");
  scroller.style.overflowY = "auto";
  Object.defineProperties(scroller, {
    clientHeight: { configurable: true, value: 400 },
    scrollHeight: { configurable: true, value: 1200 },
  });
  scroller.scrollTop = 350;
  scroller.getBoundingClientRect = () => ({ top: 0, bottom: 400, left: 0, right: 800, width: 800, height: 400, x: 0, y: 0, toJSON() {} }) as DOMRect;
  document.body.append(scroller); scroller.append(ui.root); ui.view.containerEl = scroller;
  const cell = ui.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${ui.table.fields[1].id}"]`)!;
  cell.getBoundingClientRect = () => {
    const top = 500 - scroller.scrollTop;
    return { top, bottom: top + 24, left: 0, right: 120, width: 120, height: 24, x: 0, y: top, toJSON() {} } as DOMRect;
  };
  ui.view.editor.undo = () => {
    ui.calls.undo++;
    scroller.scrollTop = 0;
    scroller.append(document.createElement("span"));
  };
  try {
    pointerClick(cell);
    const undo = new dom.window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true });
    cell.dispatchEvent(undo);
    assert.equal(undo.defaultPrevented, true);
    assert.equal(ui.calls.undo, 1);
    await new Promise((resolve) => setTimeout(resolve, 60));
    assert.equal(scroller.scrollTop, 350, "undo should restore the scroll position around the table anchor");
  } finally { ui.cleanup(); scroller.remove(); }
});

for (const scenario of [
  { name: "fully visible", headerTop: 220, expectedTop: 220 },
  { name: "above the viewport", headerTop: -160, expectedTop: 140 },
  { name: "covered by the sticky toolbar", headerTop: 120, expectedTop: 140 },
  { name: "clipped at the viewport bottom", headerTop: 690, expectedTop: 140 },
]) {
  test(`[views][layout] grouping changes anchor a table header that is ${scenario.name}`, async () => {
    const table = fixture(); delete table.views[0].group;
    const scroller = document.createElement("div"); scroller.style.overflowY = "auto";
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 600 },
      scrollHeight: { configurable: true, value: 3000 },
    });
    scroller.scrollTop = 500; scroller.scrollLeft = 67;
    const rect = (top: number, height: number) => ({ top, bottom: top + height, left: 0, right: 800, width: 800, height, x: 0, y: top, toJSON() {} }) as DOMRect;
    scroller.getBoundingClientRect = () => rect(100, 600);
    document.body.append(scroller);
    const root = document.createElement("div"); scroller.append(root);
    let documentTop = scenario.headerTop - 40 + scroller.scrollTop;
    let saves = 0;
    const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
    dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
      if (this === root) return rect(documentTop - scroller.scrollTop, 1600);
      if (root.contains(this)) {
        if (this.matches(".tb-toolbar")) return rect(Math.max(100, documentTop - scroller.scrollTop), 40);
        if (this.matches(".tb-grid thead")) return rect(documentTop + 40 - scroller.scrollTop, 32);
        if (this.matches("td.tb-cell")) return rect(documentTop + 72 - scroller.scrollTop, 32);
      }
      return originalRect.call(this);
    };
    const noteView = { file: { path: `${table.tableId}.md` }, getMode: () => "source", containerEl: scroller };
    const controller = renderTable({ app: { workspace: { getActiveViewOfType: () => noteView } } } as any, JSON.stringify(table), {
      root, sourcePath: noteView.file.path,
      save: async (_before, next) => {
        saves++;
        // Simulate a host layout shift and scroll adjustment during the save.
        documentTop += 250; scroller.scrollTop += 700; scroller.scrollLeft = 0;
        return JSON.stringify(next);
      },
    });
    const finishSave = async (count: number) => {
      await waitForCondition(() => saves === count, "grouping save");
      for (let frame = 0; frame < 3; frame++) await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
      assert.equal(root.querySelector("thead")!.getBoundingClientRect().top, scenario.expectedTop);
      assert.equal(scroller.scrollLeft, 67, "grouping preserves horizontal note scroll");
    };
    const restoreScenario = () => {
      document.body.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
      scroller.scrollTop = documentTop + 40 - scenario.headerTop;
    };
    try {
      click(byLabel(root, "Group"));
      click(document.body.querySelector(".tb-group-select")!);
      shownMenus.at(-1)!.items.find((item) => item.title === table.fields[0].name)!.action!({});
      await finishSave(1);
      restoreScenario();
      if (!document.body.querySelector(".tb-group-panel")) click(byLabel(root, "Group"));
      click(byEditorName(document.body.querySelector(".tb-group-panel")!, "Descending"));
      await finishSave(2);
      restoreScenario();
      if (!document.body.querySelector(".tb-group-panel")) click(byLabel(root, "Group"));
      click(document.body.querySelector(".tb-group-clear")!);
      await finishSave(3);
      assert.equal(root.querySelector(".tb-group-row"), null);
    } finally {
      document.body.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
      controller.destroy(); scroller.remove();
      dom.window.HTMLElement.prototype.getBoundingClientRect = originalRect;
    }
  });
}

test("[views][layout] changing filter relationships preserves note scroll instead of following result rows", async () => {
  const table = fixture(); delete table.views[0].group;
  table.views[0].filters = { mode: "and", conditions: [
    { id: "name-match", fieldId: table.fields[0].id, operator: "contains", value: "IINA" },
    { id: "name-present", fieldId: table.fields[0].id, operator: "isNotEmpty" },
  ] };
  const scroller = document.createElement("div"); scroller.style.overflowY = "auto";
  Object.defineProperties(scroller, {
    clientHeight: { value: 600 }, scrollHeight: { value: 3000 },
  });
  scroller.scrollTop = 500; scroller.scrollLeft = 67;
  const root = document.createElement("div"); scroller.append(root); document.body.append(scroller);
  const rect = (top: number) => ({ top, bottom: top + 32, left: 0, right: 800, width: 800, height: 32, x: 0, y: top, toJSON() {} }) as DOMRect;
  let layoutShift = 0; let saves = 0;
  const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this === scroller) return { ...rect(100), bottom: 700, height: 600 };
    if (this === root || root.contains(this)) return rect(650 + layoutShift - scroller.scrollTop);
    return originalRect.call(this);
  };
  const noteView = { file: { path: `${table.tableId}.md` }, getMode: () => "source", containerEl: scroller };
  const controller = renderTable({ app: { workspace: { getActiveViewOfType: () => noteView } } } as any, JSON.stringify(table), {
    root, sourcePath: noteView.file.path,
    save: async (_before, next) => {
      saves++; layoutShift += 250; scroller.scrollTop += 700; scroller.scrollLeft = 0;
      return JSON.stringify(next);
    },
  });
  try {
    click(root.querySelector(".tb-filter-toggle")!);
    const panel = document.querySelector(".tb-filter-popover")!;
    const mode = panel.querySelector<HTMLButtonElement>(".tb-filter-mode")!;
    for (const [index, relationship] of ["or", "and"].entries()) {
      mode.focus(); selectFilterChoice(mode, t(relationship === "or" ? "Meet any condition" : "Meet all conditions"));
      await waitForCondition(() => saves === index + 1, "filter relationship save");
      for (let frame = 0; frame < 3; frame++) await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
      assert.equal(root.querySelectorAll(".tb-data-row").length, relationship === "or" ? 2 : 1);
      assert.equal(scroller.scrollTop, 500, "filtering must preserve the note offset even when result rows move");
      assert.equal(scroller.scrollLeft, 67);
      assert.equal(document.activeElement, mode);
      assert.equal(document.querySelector(".tb-filter-popover"), panel);
    }
  } finally {
    document.body.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
    controller.destroy(); scroller.remove();
    dom.window.HTMLElement.prototype.getBoundingClientRect = originalRect;
  }
});

test("[interaction][storage] Live Preview table undo still routes after an earlier window listener prevents the key", () => {
  const preventHistory = (event: KeyboardEvent) => {
    if (event.key.toLowerCase() === "z" && event.metaKey) event.preventDefault();
  };
  window.addEventListener("keydown", preventHistory, true);
  const ui = mountWithHistory();
  const cmEditor = document.createElement("div"); cmEditor.className = "cm-editor";
  const content = document.createElement("div"); content.className = "cm-content"; content.contentEditable = "true"; content.tabIndex = 0;
  cmEditor.append(content); document.body.append(cmEditor); content.append(ui.root);
  try {
    const cell = ui.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${ui.table.fields[1].id}"]`)!;
    pointerClick(cell);
    content.focus();
    document.getSelection()!.selectAllChildren(cell);
    const undo = new dom.window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true });
    content.dispatchEvent(undo);
    assert.equal(ui.calls.undo, 1);
    assert.equal(undo.defaultPrevented, true);
  } finally {
    ui.cleanup(); cmEditor.remove(); window.removeEventListener("keydown", preventHistory, true);
  }
});

test("[interaction][storage] an open table choice menu suppresses note undo while its cell remains focused", () => {
  const ui = mountWithHistory();
  try {
    const cell = ui.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${ui.table.fields[1].id}"]`)!;
    pointerClick(cell);
    const action = cell.querySelector<HTMLButtonElement>(".tb-cell-action")!;
    click(action);
    const menu = shownMenus.at(-1)!;
    const undo = new dom.window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true });
    action.dispatchEvent(undo);
    assert.equal(ui.calls.undo, 0);
    assert.equal(undo.defaultPrevented, false);
    menu.hide();
  } finally { ui.cleanup(); }
});

test("[interaction][storage] an open group field menu suppresses note undo", () => {
  const ui = mountWithHistory();
  try {
    click(byLabel(ui.root, "Group"));
    const select = document.body.querySelector<HTMLButtonElement>(".tb-group-select")!;
    click(select);
    const menu = shownMenus.at(-1)!;
    const undo = new dom.window.KeyboardEvent("keydown", { key: "z", metaKey: true, bubbles: true, cancelable: true });
    select.dispatchEvent(undo);
    assert.equal(ui.calls.undo, 0);
    assert.equal(undo.defaultPrevented, false);
    menu.hide();
  } finally { ui.cleanup(); }
});

test("[layout] initial layout and width changes coalesce; text edits measure only their row", async () => {
  const originalObserver = Object.getOwnPropertyDescriptor(globalThis, "ResizeObserver");
  class TestResizeObserver {
    static instances: TestResizeObserver[] = [];
    target?: Element;
    constructor(private readonly callback: ResizeObserverCallback) { TestResizeObserver.instances.push(this); }
    observe(target: Element): void { this.target = target; }
    disconnect(): void {}
    trigger(width: number, height: number): void {
      const contentRect = { x: 0, y: 0, top: 0, right: width, bottom: height, left: 0, width, height, toJSON: () => ({}) } as DOMRectReadOnly;
      this.callback([{ target: this.target!, contentRect } as ResizeObserverEntry], this as unknown as ResizeObserver);
    }
  }
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: TestResizeObserver });
  TestResizeObserver.instances = [];
  const table = fixture(); table.tableId = "row-layout-measurement-test";
  table.fields.push({ id: "details", name: "详情", type: "text", width: 180 });
  table.records.forEach((row, index) => { row.values.details = `详情 ${index + 1}`; });
  const root = document.createElement("div"); document.body.append(root);
  let controller: ReturnType<typeof renderTable> | null = null;
  let layoutObserver: TestResizeObserver | undefined;
  let simulateOwnHeightChange = false;
  let simulatedHeight = 220;
  try {
    controller = renderTable({ app: {} } as any, JSON.stringify(table), {
      root, sourcePath: "row-layout-measurement-test.md", save: async (_, next) => JSON.stringify(next),
      onLayout: () => {
        if (!simulateOwnHeightChange || !layoutObserver) return;
        simulatedHeight += 1; layoutObserver.trigger(401, simulatedHeight);
      },
    });
    const firstTextCell = root.querySelector<HTMLTableCellElement>(`.tb-data-row[data-row-id="${table.records[0].id}"] td[data-field-id="${table.fields[0].id}"]`)!;
    openMarkdownEditor(firstTextCell);
    const inputs = [...root.querySelectorAll<HTMLTextAreaElement>("textarea.tb-auto-height")];
    const reads = new Map<HTMLTextAreaElement, number>();
    const naturalHeights = new Map<HTMLTextAreaElement, number>();
    inputs.forEach((input) => Object.defineProperty(input, "scrollHeight", {
      configurable: true,
      get: () => { reads.set(input, (reads.get(input) ?? 0) + 1); return naturalHeights.get(input) ?? 30; },
    }));
    root.querySelectorAll<HTMLTableRowElement>(".tb-data-row").forEach((row) => {
      const rowInputs = [...row.querySelectorAll<HTMLTextAreaElement>("textarea.tb-auto-height")];
      const rowHeight = () => Math.max(0, ...rowInputs.map((input) => naturalHeights.get(input) ?? 30));
      row.querySelectorAll("td").forEach((cell) => Object.defineProperty(cell, "clientHeight", { configurable: true, get: rowHeight }));
    });
    layoutObserver = TestResizeObserver.instances[0];
    assert.ok(layoutObserver);

    // The first observer notification establishes the size baseline. A width update
    // before the initial animation frame must join that already-pending full pass.
    layoutObserver.trigger(400, 180);
    layoutObserver.trigger(401, 220);
    simulateOwnHeightChange = true;
    await settle();
    simulateOwnHeightChange = false;
    assert.equal(inputs.length, table.fields.length + 1, "only the explicit cell editor should be added beside the existing header editors");
    assert.ok(inputs.every((input) => reads.get(input) === 1), "initial render, width update and the pass's own height change should share one measurement pass");

    inputs.forEach((input) => reads.set(input, 0));
    layoutObserver.trigger(401, 300);
    await settle();
    assert.ok(inputs.every((input) => reads.get(input) === 1), "a later external height change should still remeasure the full table");

    inputs.forEach((input) => reads.set(input, 0));
    const editedRow = root.querySelector<HTMLTableRowElement>(`tr[data-row-id="${table.records[0].id}"]`)!;
    const editedInputs = [...editedRow.querySelectorAll<HTMLTextAreaElement>("textarea.tb-auto-height")];
    assert.equal(editedInputs.length, 1);
    naturalHeights.set(editedInputs[0], 50);
    editedInputs[0].value = "Updated text";
    editedInputs[0].dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle();
    assert.ok(editedInputs.every((input) => reads.get(input) === 1), "all textareas in the edited row should be measured once");
    assert.ok(inputs.filter((input) => !editedRow.contains(input)).every((input) => (reads.get(input) ?? 0) === 0), "unaffected rows and headers should not be measured while typing");
    assert.equal(editedInputs[0].style.height, "50px", "the active source editor should grow to fit its text");

    inputs.forEach((input) => reads.set(input, 0));
    layoutObserver.trigger(402, 300);
    await settle();
    assert.ok(inputs.every((input) => reads.get(input) === 1), "a real width change should schedule one full measurement");
  } finally {
    controller?.destroy(); root.remove();
    if (originalObserver) Object.defineProperty(globalThis, "ResizeObserver", originalObserver);
    else Reflect.deleteProperty(globalThis, "ResizeObserver");
  }
});

test("[layout] text editor keeps the row height on entry, then grows and shrinks with content", async () => {
  const ui = mount();
  try {
    await settle();
    const row = ui.root.querySelector<HTMLTableRowElement>(`.tb-data-row[data-row-id="${ui.table.records[0].id}"]`)!;
    const cell = row.querySelector<HTMLTableCellElement>(`td[data-field-id="${ui.table.fields[0].id}"]`)!;
    let entryHeight = 58;
    let otherCellHeight = 46;
    let contentHeight = 34;
    let editing = false;
    Object.defineProperty(cell, "clientHeight", {
      configurable: true,
      get: () => editing ? Math.max(otherCellHeight, contentHeight) : entryHeight,
    });

    const input = openMarkdownEditor(cell);
    editing = true;
    assert.equal(input.rows, 1, "a single-line value should not inherit a two-row minimum");
    assert.equal(input.style.height, `${entryHeight}px`, "entering edit should preserve the displayed row height");
    Object.defineProperty(input, "scrollHeight", { configurable: true, get: () => contentHeight });

    contentHeight = 72;
    input.value = "a longer\nvalue";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle();
    assert.equal(input.style.height, "72px", "content growth should expand the row");

    contentHeight = 30;
    input.value = "short";
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle();
    assert.equal(input.style.height, `${otherCellHeight}px`, "shorter content should shrink to the height required by other cells");

    otherCellHeight = 20;
    input.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    await settle();
    assert.equal(input.style.height, "30px", "the row should be allowed to shrink below its entry height");
  } finally { ui.cleanup(); }
});

test("[layout] renderer has compact icon toolbar, type icons, plain pills and separate colored multi-tags", () => {
  const ui = mount();
  assert.equal(ui.root.querySelector(".tb-view-name")?.textContent, "Imported view");
  assert.equal(ui.root.querySelector(".tb-view-type-icon svg")?.getAttribute("data-icon"), "table");
  const toolbarButtons = [...ui.root.querySelectorAll<HTMLButtonElement>(".tb-toolbar button")];
  assert.ok(toolbarButtons.every((button) => !button.hasAttribute("aria-label") && !button.hasAttribute("title")), "visible toolbar labels should not create hover tooltips");
  assert.ok(toolbarButtons.every((button) => {
    const labelId = button.getAttribute("aria-labelledby");
    return !!labelId && !!document.getElementById(labelId)?.textContent?.trim();
  }), "toolbar buttons should retain accessible names through their visible labels");
  assert.deepEqual([...ui.root.querySelectorAll(".tb-toolbar button:not(.tb-view-menu-button) span:not(:has(svg)):not(.tb-sr-only)")].map((element) => element.textContent), ["Display configuration", "Row", "Column", "Filter", "Group", "Search", "Select"]);
  assert.equal(ui.root.querySelector(".tb-view-menu-icon svg")?.getAttribute("data-icon"), "chevron-down");
  assert.equal(ui.root.querySelector(".tb-table-actions")?.lastElementChild?.classList.contains("tb-table-menu-button"), true);
  assert.equal(ui.root.querySelectorAll(".tb-type-icon").length, 3);
  assert.equal(ui.root.querySelector(".tb-type-icon svg")?.getAttribute("data-icon"), "text");
  assert.equal(ui.root.querySelectorAll(".tb-tags .tb-tag").length, 4);
  assert.equal(ui.root.querySelectorAll(".tb-cell-action, .tb-choice-remove, .tb-tag-remove").length, 0);
  assert.equal(ui.root.querySelectorAll(".tb-choice-summary").length, 0);
  assert.equal(ui.root.querySelector<HTMLTextAreaElement>(".tb-field-name")?.value, "名称");
  assert.equal(ui.root.querySelector<HTMLTableElement>(".tb-grid")?.style.width, "644px"); ui.cleanup();
});
test("[import-export][localization] table actions menu groups whole-table copy and the existing export submenus", () => {
  const previousLocale = getLocale();
  try {
    for (const language of ["en", "zh-CN"]) {
      setLanguage(language);
      const ui = mount();
      try {
        const exportButton = ui.root.querySelector<HTMLButtonElement>(".tb-table-menu-button")!;
        click(exportButton);
        const menu = shownMenus.at(-1)!;
        assert.equal(menu.useNativeMenu, false);
        assert.deepEqual(menu.items.map((item) => item.title), [t("Copy table"), t("Export CSV"), t("Export Markdown")]);
        assert.equal(exportButton.getAttribute("aria-expanded"), "true");
        const csvMenu = menu.items[1].child!;
        const markdownMenu = menu.items[2].child!;
        assert.equal(csvMenu.useNativeMenu, false);
        assert.deepEqual(csvMenu.items.map((item) => item.title), [t("Current view"), t("All fields and records")]);
        assert.equal(markdownMenu.useNativeMenu, false);
        assert.deepEqual(markdownMenu.items.map((item) => item.title), [
          t("Current view"),
          t("All fields and records"),
          t("Copy current view"),
          t("Copy all fields and records"),
        ]);
        assert.ok(markdownMenu.items.slice(2).every((item) => item.icon === "clipboard-copy"));
      } finally { ui.cleanup(); }
    }
  } finally { setLanguage(previousLocale); }
});
test("[table-block][views][localization] table actions copy all data and use the currently displayed view without saving the source", async () => {
  const previousLocale = getLocale(); const originalWrite = navigator.clipboard.writeText;
  try {
    for (const language of ["en", "zh-CN"]) {
      setLanguage(language);
      const table = readTable(JSON.stringify(fixtureWithOpaqueData()));
      table.views.push({ id: "copy-view", name: "Copy view", filters: emptyFilters(), visibleFieldIds: [] });
      const source = JSON.stringify(table);
      const ui = mount(table, true);
      let copied = "";
      navigator.clipboard.writeText = async (text) => { copied = text; };
      try {
        click(ui.root.querySelector(".tb-view-menu-button")!);
        shownMenus.at(-1)!.items.find((item) => item.title === "Copy view")!.action!({});
        click(byLabel(ui.root, t("Table actions")));
        const menu = shownMenus.at(-1)!;
        await menu.items.find((item) => item.title === t("Copy table"))!.action!({});
        const result = readTable(scanFencedBlocks(copied)[0].body);
        assert.ok(copied.endsWith("\n\n"), "leave a body cursor outside the block for the next paste");
        assert.ok(prepareTablePaste(copied, copied, copied.length, copied.length), "immediately pasting the same clipboard again must allocate a new ID");
        assert.notEqual(result.tableId, table.tableId);
        assert.equal(result.defaultViewId, "copy-view");
        assert.deepEqual({ ...result, tableId: table.tableId, defaultViewId: table.defaultViewId }, table);
        assert.equal(JSON.stringify(table), source);
        assert.equal(ui.saved(), null);
        assert.equal(notices.at(-1), t("Table copied. Paste it into a note to create an independent copy."));
        menu.hide();
        assert.equal(byLabel(ui.root, t("Table actions")).getAttribute("aria-expanded"), "false");
      } finally { ui.cleanup(); }
    }
  } finally { navigator.clipboard.writeText = originalWrite; setLanguage(previousLocale); }
});
test("[table-block][storage] whole-table copy waits for a pending edit and refuses stale data after a save failure", async () => {
  const originalWrite = navigator.clipboard.writeText;
  try {
    for (const fail of [false, true]) {
      const table = fixture(); delete table.views[0].sort; delete table.views[0].group;
      const root = document.createElement("div"); document.body.append(root);
      let finishSave!: () => void;
      const gate = new Promise<void>((resolve) => { finishSave = resolve; });
      const controller = renderTable({ app: {} } as any, JSON.stringify(table), {
        root, sourcePath: "pending-copy.md", save: async (_, next) => {
          await gate; if (fail) throw new Error("conflict"); return JSON.stringify(next);
        },
      });
      const copied: string[] = []; navigator.clipboard.writeText = async (text) => { copied.push(text); };
      try {
        click(byLabel(root, "Table actions"));
        const copy = shownMenus.at(-1)!.items.find((item) => item.title === "Copy table")!;
        const input = openMarkdownEditor(root.querySelector<HTMLTableCellElement>("td.tb-cell")!);
        input.value = "Latest committed edit"; input.blur();
        const pending = copy.action!({});
        await Promise.resolve(); assert.equal(copied.length, 0);
        finishSave(); await pending;
        if (fail) {
          assert.equal(copied.length, 0);
          assert.match(notices.at(-1)!, /Could not copy table/);
        } else {
          assert.equal(copied.length, 1);
          assert.equal(readTable(scanFencedBlocks(copied[0])[0].body).records[0].values[table.fields[0].id], "Latest committed edit");
        }
      } finally { finishSave(); controller.destroy(); root.remove(); }
    }
  } finally { navigator.clipboard.writeText = originalWrite; }
});
test("[table-block][interaction] editor paste repairs collisions in one edit and respects input, table, handled and multiple-selection boundaries", async () => {
  const handlers = new Map<string, (...args: any[]) => void>();
  const plugin = new SuperTablePlugin({ workspace: { on: (name: string, handler: (...args: any[]) => void) => { handlers.set(name, handler); return {}; } } } as any, {} as any);
  await plugin.onload(); const handle = handlers.get("editor-paste")!;
  const source = serializeTable(fixture()); let note = source + "\n\n"; let changes = 0;
  let selections = [{ anchor: { line: 0, ch: note.length }, head: { line: 0, ch: note.length } }];
  const editor = {
    getValue: () => note, listSelections: () => selections, posToOffset: (position: { ch: number }) => position.ch,
    replaceSelection: (text: string, origin: string) => { assert.equal(origin, "input.paste"); changes++; note += text; },
  };
  const surface = document.createElement("div"); surface.className = "cm-content"; surface.setAttribute("contenteditable", "true"); document.body.append(surface);
  const makeEvent = (target: Element = surface) => pasteClipboardText(target, source);
  try {
    const handled = makeEvent(); handled.preventDefault(); handle(handled, editor); assert.equal(changes, 0);
    selections.push(selections[0]); handle(makeEvent(), editor); assert.equal(changes, 0); selections.pop();
    for (const tag of ["input", "textarea", "select", "div"]) {
      const target = document.createElement(tag); if (tag === "div") target.className = "tablebase-root";
      surface.append(target); handle(makeEvent(target), editor); target.remove(); assert.equal(changes, 0);
    }
    const event = makeEvent(); handle(event, editor);
    assert.equal(event.defaultPrevented, true); assert.equal(changes, 1);
    const tables = scanFencedBlocks(note).map((block) => readTable(block.body));
    assert.notEqual(tables[0].tableId, tables[1].tableId);
    note = ""; selections = [{ anchor: { line: 0, ch: 0 }, head: { line: 0, ch: 0 } }];
    const ordinary = makeEvent(); handle(ordinary, editor);
    assert.equal(ordinary.defaultPrevented, false); assert.equal(changes, 1);
  } finally { surface.remove(); }
});
test("[import-export] Markdown copy actions use the view projection or full stored table and report clipboard errors", async () => {
  const previousLocale = getLocale();
  setLanguage("en");
  const clipboard = navigator.clipboard;
  const originalWriteText = clipboard.writeText;
  const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
  const copied: string[] = [];
  clipboard.writeText = async (text: string) => { copied.push(text); };
  let ui: ReturnType<typeof mount> | undefined;
  try {
    const table = fixture();
    const [name, platform, tags] = table.fields;
    const optionId = (field: Field, label: string) => field.options!.find((option) => option.label === label)!.id;
    table.records = [
      { id: "alpha", values: { [name.id]: "Alpha", [platform.id]: optionId(platform, "PC"), [tags.id]: [optionId(tags, "A")] } },
      { id: "echo", values: { [name.id]: "Echo", [platform.id]: optionId(platform, "MAC"), [tags.id]: [] } },
      { id: "gamma", values: { [name.id]: "Gamma", [platform.id]: optionId(platform, "PC"), [tags.id]: [optionId(tags, "B")] } },
    ];
    const view = table.views[0];
    view.visibleFieldIds = [name.id];
    view.filters = filtersFor(name.id, "a");
    view.sort = { fieldId: name.id, direction: "desc" };
    delete view.group;
    ui = mount(table, true);

    click(byLabel(ui.root, "Table actions"));
    const markdownMenu = shownMenus.at(-1)!.items.find((item) => item.title === t("Export Markdown"))!.child!;
    const copyCurrent = markdownMenu.items.find((item) => item.title === t("Copy current view"))!;
    const copyAll = markdownMenu.items.find((item) => item.title === t("Copy all fields and records"))!;
    const noticeCount = notices.length;

    await copyCurrent.action!({});
    assert.equal(copied[0], "| 名称 |\n| --- |\n| Gamma |\n| Alpha |", "current-view copy should use visible fields, filters, and sort order");
    assert.equal(notices.at(noticeCount), t("Markdown table copied to clipboard."));

    await copyAll.action!({});
    assert.equal(copied[1], [
      "| 名称 | 平台 | 标签 |",
      "| --- | --- | --- |",
      "| Alpha | PC | A |",
      "| Echo | MAC |  |",
      "| Gamma | PC | B |",
    ].join("\n"), "all-data copy should include hidden fields and retain stored record order");
    assert.equal(notices.at(noticeCount + 1), t("Markdown table copied to clipboard."));

    Object.defineProperty(document, "execCommand", { configurable: true, value: () => false });
    clipboard.writeText = async () => { throw new Error("clipboard blocked"); };
    await copyCurrent.action!({});
    assert.equal(notices.at(-1), t("Could not copy Markdown table: {message}", { message: t("Clipboard access is unavailable.") }));
  } finally {
    ui?.cleanup();
    clipboard.writeText = originalWriteText;
    if (originalExecCommand) Object.defineProperty(document, "execCommand", originalExecCommand);
    else delete (document as Document & { execCommand?: (command: string) => boolean }).execCommand;
    setLanguage(previousLocale);
  }
});
test("[import-export][interaction] clipboard fallback cleans up and restores focus after success, refusal, or an exception", async () => {
  const originalWriteText = navigator.clipboard.writeText;
  const originalExecCommand = Object.getOwnPropertyDescriptor(document, "execCommand");
  const previousLocale = getLocale(); setLanguage("en");
  navigator.clipboard.writeText = async () => { throw new Error("clipboard blocked"); };
  try {
    for (const outcome of ["success", "refused", "throws"] as const) {
      const ui = mount(fixture(), true);
      const previous = document.createElement("input"); document.body.append(previous);
      try {
        click(byLabel(ui.root, "Table actions"));
        const menu = shownMenus.at(-1)!.items.find((item) => item.title === t("Export Markdown"))!.child!;
        const copy = menu.items.find((item) => item.title === t("Copy current view"))!;
        previous.focus();
        let calls = 0;
        Object.defineProperty(document, "execCommand", { configurable: true, value: (command: string) => {
          calls++; assert.equal(command, "copy");
          const helper = document.querySelector<HTMLTextAreaElement>(".tb-clipboard-helper");
          assert.ok(helper); assert.match(helper.value, /^\|/);
          helper.focus();
          if (outcome === "throws") throw new Error("copy command failed");
          return outcome === "success";
        } });
        await copy.action!({});
        assert.equal(calls, 1, "a denied async clipboard still tries the native copy fallback");
        assert.equal(document.querySelector(".tb-clipboard-helper"), null, outcome);
        assert.equal(document.activeElement, previous, outcome);
        assert.equal(ui.saved(), null, "copying must not write note data");
        assert.equal(notices.at(-1), outcome === "success" ? t("Markdown table copied to clipboard.") : t("Could not copy Markdown table: {message}", {
          message: outcome === "throws" ? "copy command failed" : t("Clipboard access is unavailable."),
        }));
      } finally { previous.remove(); ui.cleanup(); }
    }
  } finally {
    navigator.clipboard.writeText = originalWriteText;
    if (originalExecCommand) Object.defineProperty(document, "execCommand", originalExecCommand);
    else delete (document as Document & { execCommand?: (command: string) => boolean }).execCommand;
    setLanguage(previousLocale);
  }
});
test("[import-export][localization] export filenames identify the selected scope and sanitize view names", () => {
  for (const language of ["en", "zh-CN"]) {
    setLanguage(language);
    assert.equal(createExportFileName("Planning", "current", "csv"), "Planning.csv");
    assert.equal(createExportFileName("Planning", "all", "md"), `Planning - ${t("All data")}.md`);
    assert.equal(createExportFileName("Bad/Name", "current", "csv"), "Bad-Name.csv");
  }
  setLanguage("en");
  for (let code = 0; code <= 0x1f; code++) {
    const control = String.fromCharCode(code);
    assert.equal(createExportFileName(`A${control}B`, "current", "csv"), "A-B.csv", `U+${code.toString(16).padStart(4, "0")}`);
  }
  assert.equal(createExportFileName(`A${String.fromCharCode(0, 1, 31)}B`, "current", "csv"), "A-B.csv");
  assert.equal(createExportFileName(" 中文 😀 A B ", "current", "csv"), "中文 😀 A B.csv");
});
test("[import-export][localization] Markdown conversion defaults to insertion and warns only when replacement is selected", async () => {
  for (const language of ["en", "zh-CN"]) {
    setLanguage(language);
    const table = fixture();
    const markdown = convertSuperTableToMarkdown(table);
    const dialog = confirmMarkdownReplacement({} as any, table, markdown);
    const modal = document.querySelector<HTMLElement>(".tb-markdown-replacement-modal")!;
    const warning = modal.querySelector<HTMLElement>("[role=alert]")!;
    const checkbox = modal.querySelector<HTMLInputElement>("input[type=checkbox]")!;
    const submit = modal.querySelector<HTMLButtonElement>(".tb-dialog-actions .tb-button.mod-cta")!;
    assert.equal(checkbox.checked, false);
    assert.equal(warning.hidden, true);
    assert.equal(warning.classList.contains("tb-markdown-replacement-warning"), true);
    assert.equal(warning.textContent, t(
      "Replacing removes {fields} field type definitions, {options} option definitions, and {views} view configurations. Cell values remain in the Markdown table.",
      { fields: table.fields.length, options: table.fields.reduce((count, field) => count + (field.options?.length ?? 0), 0), views: table.views.length },
    ));
    assert.equal(submit.textContent, t("Insert Markdown table"));
    assert.equal(submit.classList.contains("mod-cta"), true);
    assert.equal(modal.querySelector(".tb-markdown-replacement-option span")?.textContent, t("Replace original Super Table"));
    assert.equal(modal.querySelector(".tb-import-preview-sample")?.textContent, t("The Markdown table will be inserted below the Super Table block. The original block remains unless replacement is selected."));
    assert.equal(modal.querySelector(".tb-markdown-export-preview")?.textContent, markdown);
    checkbox.click();
    assert.equal(warning.hidden, false);
    assert.equal(submit.textContent, t("Confirm replacement"));
    assert.equal(submit.classList.contains("mod-warning"), true);
    checkbox.click();
    assert.equal(warning.hidden, true);
    assert.equal(submit.textContent, t("Insert Markdown table"));
    submit.click();
    assert.deepEqual(await dialog, { confirmed: true, replace: false });

    const replaceDialog = confirmMarkdownReplacement({} as any, table, markdown);
    const replaceModal = document.querySelector<HTMLElement>(".tb-markdown-replacement-modal")!;
    replaceModal.querySelector<HTMLInputElement>("input[type=checkbox]")!.click();
    replaceModal.querySelector<HTMLButtonElement>(".tb-button.mod-warning")!.click();
    assert.deepEqual(await replaceDialog, { confirmed: true, replace: true });
  }
  setLanguage("en");
});
test("[import-export][storage][localization] Markdown conversion command inserts by default or replaces only an unchanged unique source block", async () => {
  const table = fixture();
  const markdown = convertSuperTableToMarkdown(table);
  const original = `before\n${serializeTable(table)}\nafter`;
  const linesOf = (value: string) => value.split(/\r?\n/);
  const makeEditor = (initial: string) => {
    let value = initial;
    const offset = (position: { line: number; ch: number }) => linesOf(value).slice(0, position.line).reduce((total, line) => total + line.length + 1, 0) + position.ch;
    return {
      getValue: () => value,
      getCursor: () => ({ line: 2, ch: 0 }),
      lineCount: () => linesOf(value).length,
      getLine: (line: number) => linesOf(value)[line] ?? "",
      replaceRange: (insert: string, from: { line: number; ch: number }, to: { line: number; ch: number }) => {
        value = `${value.slice(0, offset(from))}${insert}${value.slice(offset(to))}`;
      },
      setValue: (next: string) => { value = next; },
    };
  };
  const loadCommand = async () => {
    const commands: any[] = [];
    const plugin = Object.assign(new SuperTablePlugin({} as any, {} as any), {
      app: { workspace: { on: () => ({}) } },
      addCommand: (command: any) => commands.push(command),
    });
    await plugin.onload();
    return commands.find((command) => command.id === "convert-to-markdown");
  };

  const command = await loadCommand();
  const editor = makeEditor(original);
  const pending = command.editorCallback(editor);
  const modal = document.querySelector<HTMLElement>(".tb-markdown-replacement-modal")!;
  modal.querySelector<HTMLButtonElement>(".tb-button.mod-cta")!.click();
  await pending;
  const insertedValue = `before\n${serializeTable(table)}\n\n${markdown}\n\nafter`;
  assert.equal(editor.getValue(), insertedValue);

  const replaceCommand = await loadCommand();
  const replaceEditor = makeEditor(original);
  const replacePending = replaceCommand.editorCallback(replaceEditor);
  const replaceModal = document.querySelector<HTMLElement>(".tb-markdown-replacement-modal")!;
  replaceModal.querySelector<HTMLInputElement>("input[type=checkbox]")!.click();
  replaceModal.querySelector<HTMLButtonElement>(".tb-button.mod-warning")!.click();
  await replacePending;
  assert.equal(replaceEditor.getValue(), `before\n${markdown}\nafter`);
  assert.equal(editor.getValue(), insertedValue);

  for (const conflict of ["changed", "missing", "duplicate"] as const) {
    const currentCommand = await loadCommand();
    const currentEditor = makeEditor(original);
    const operation = currentCommand.editorCallback(currentEditor);
    const currentModal = document.querySelector<HTMLElement>(".tb-markdown-replacement-modal")!;
    if (conflict === "changed") currentEditor.setValue(original.replace("WinMTR", "Changed elsewhere"));
    if (conflict === "missing") currentEditor.setValue("before\nafter");
    if (conflict === "duplicate") currentEditor.setValue(`${original}\n${serializeTable(table)}`);
    const beforeConfirm = currentEditor.getValue();
    const noticeCount = notices.length;
    currentModal.querySelector<HTMLButtonElement>(".tb-button.mod-cta")!.click();
    await operation;
    assert.equal(currentEditor.getValue(), beforeConfirm, `${conflict} source must not be written`);
    assert.ok(notices.length > noticeCount, `${conflict} source should explain that conversion was stopped`);
  }
});
test("[import-export][localization] Markdown import command reports extra cells without preview or writes, then accepts corrected input", async () => {
  try {
    for (const language of ["en", "zh-CN"]) {
      setObsidianLanguage(language);
      const source = "| Name | Count |\n| --- | --- |\n| Apple | 3 |\n| Pear | 2 |\n| Plum | 1 |\n| Peach | 5 | Notes |";
      let value = `Before\n\n${source}\n\nAfter`; let writes = 0;
      let cursor = { line: 4, ch: 0 };
      const editor = {
        getValue: () => value, getCursor: () => cursor, lineCount: () => value.split("\n").length,
        getLine: (line: number) => value.split("\n")[line] ?? "",
        replaceRange: (insert: string, from: { line: number; ch: number }) => {
          const offset = value.split("\n").slice(0, from.line).reduce((total, line) => total + line.length + 1, 0) + from.ch;
          value = value.slice(0, offset) + insert + value.slice(offset); writes++;
        },
        setCursor: (next: { line: number; ch: number }) => { cursor = next; },
      };
      const commands: any[] = [];
      const plugin = Object.assign(new SuperTablePlugin({} as any, {} as any), {
        app: { workspace: { on: () => ({}), getActiveViewOfType: () => ({ editor }) } },
        addCommand: (command: any) => commands.push(command),
      });
      await plugin.onload();
      const command = commands.find((item) => item.id === "convert-markdown-table");
      const original = value; const noticeCount = notices.length;
      await command.callback();
      assert.equal(value, original); assert.equal(writes, 0);
      assert.equal(document.querySelector(".tb-import-preview-modal"), null);
      assert.equal(notices.length, noticeCount + 1);
      assert.equal(notices.at(-1), language === "en"
        ? "Super Table import failed: Markdown table line 6 has nonempty cells beyond its 2-column header. Correct the source table and try again."
        : "Super Table 导入失败：Markdown 表格第 6 行含有超出 2 列表头的非空单元格，请修正原表后重试。");

      value = value.replace("| Peach | 5 | Notes |", "| Peach | 5 | | ");
      const corrected = value;
      const pending = command.callback();
      const modal = document.querySelector<HTMLElement>(".tb-import-preview-modal"); assert.ok(modal);
      try {
        assert.equal(writes, 0); assert.equal(value, corrected);
        assert.equal(modal.querySelectorAll("tbody tr").length, 3, "existing three-record preview remains unchanged");
        modal.querySelector<HTMLButtonElement>(".tb-button.mod-cta")!.click();
        await pending;
        assert.equal(writes, 1);
        const table = readTable(scanFencedBlocks(value)[0].body);
        assert.equal(table.fields.length, 2); assert.equal(table.records.length, 4);
        assert.deepEqual(table.records.map((row) => row.values[table.fields[0].id]), ["Apple", "Pear", "Plum", "Peach"]);
        assert.ok(value.startsWith(corrected.split("\n\nAfter")[0]));
        assert.ok(value.endsWith("\n\nAfter"));
      } finally { if (modal.isConnected) modal.querySelector<HTMLButtonElement>(".tb-button")!.click(); await pending; }
    }
  } finally { setObsidianLanguage("en"); setLanguage("en"); }
});
test("[layout] column name fields keep accessible labels without hover tooltip attributes", () => {
  for (const language of ["en", "zh-CN"]) {
    setLanguage(language); const ui = mount();
    try {
      const names = [...ui.root.querySelectorAll<HTMLTextAreaElement>(".tb-field-name")];
      assert.ok(names.every((name) => !name.hasAttribute("aria-label") && !name.hasAttribute("title")));
      names.forEach((name, index) => {
        const labelId = name.getAttribute("aria-labelledby");
        assert.ok(labelId);
        assert.equal(document.getElementById(labelId)?.textContent, t("Column name: {name}", { name: ui.table.fields[index].name }));
      });
    } finally { ui.cleanup(); setLanguage("en"); }
  }
});
test("[layout] numeric cells keep accessible labels without hover tooltip attributes", () => {
  const table = fixture(); const field: Field = { id: "quantity", name: "数量", type: "number" };
  table.fields.push(field); table.records.forEach((row, index) => { row.values[field.id] = index + 1; });
  const ui = mount(table);
  try {
    const cell = ui.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${field.id}"]`)!;
    assert.equal(cell.querySelector("input"), null, "a number cell should be a preview until editing starts");
    const doubleClick = new dom.window.MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 });
    cell.dispatchEvent(doubleClick);
    assert.equal(doubleClick.defaultPrevented, true);
    const input = cell.querySelector<HTMLInputElement>("input")!;
    assert.equal(input.type, "text"); assert.equal(input.inputMode, "decimal");
    assert.equal(input.hasAttribute("aria-label"), false);
    assert.equal(input.hasAttribute("title"), false);
    const labelId = input.getAttribute("aria-labelledby");
    assert.ok(labelId);
    assert.equal(document.getElementById(labelId)?.textContent, t("{name} value", { name: field.name }));
    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
  } finally { ui.cleanup(); }
});
test("[layout] text cells keep accessible labels without hover tooltip attributes", () => {
  for (const language of ["en", "zh-CN"]) {
    setLanguage(language); const ui = mount();
    try {
      const field = ui.table.fields.find((item) => item.type === "text")!;
      const cell = ui.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${field.id}"]`)!;
      const input = openMarkdownEditor(cell);
      assert.equal(input.hasAttribute("aria-label"), false);
      assert.equal(input.hasAttribute("title"), false);
      const labelId = input.getAttribute("aria-labelledby");
      assert.ok(labelId);
      assert.equal(document.getElementById(labelId)?.textContent, t("{name} value", { name: field.name }));
      input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    } finally { ui.cleanup(); setLanguage("en"); }
  }
});
test("[layout] Markdown cells do not reserve space for a hidden edit button", () => {
  const dom = new JSDOM(`<style>${readFileSync("styles.css", "utf8")}</style><div class="tablebase-root"><div class="tb-markdown-cell"></div></div>`);
  assert.equal(dom.window.getComputedStyle(dom.window.document.querySelector(".tb-markdown-cell")!).paddingRight, "8px");
  dom.window.close();
});
test("[layout] Markdown editor keeps its preview inset and hides its vertical scrollbar", () => {
  const dom = new JSDOM(`<style>${readFileSync("styles.css", "utf8")}</style><div class="tablebase-root"><div class="tb-markdown-cell tb-preview"></div><div class="tb-markdown-cell is-editing"><textarea class="tb-cell-input tb-markdown-editor"></textarea></div></div>`);
  const { document } = dom.window;
  const preview = dom.window.getComputedStyle(document.querySelector(".tb-preview")!);
  const cell = dom.window.getComputedStyle(document.querySelector(".tb-markdown-cell.is-editing")!);
  const editor = dom.window.getComputedStyle(document.querySelector(".tb-markdown-editor")!);
  assert.equal(cell.paddingLeft, preview.paddingLeft);
  assert.equal(cell.paddingRight, preview.paddingRight);
  assert.equal(cell.paddingTop, "0px");
  assert.equal(cell.paddingBottom, "0px");
  assert.equal(editor.paddingLeft, "0px");
  assert.equal(editor.paddingRight, "0px");
  const css = readFileSync("styles.css", "utf8");
  assert.match(css, /padding-block: calc\(var\(--tb-cell-base-padding, 6px\) \+ var\(--tb-cell-extra-space, 0px\) \/ 2\);/);
  assert.equal(editor.getPropertyValue("--tb-cell-base-padding"), "4px");
  assert.equal(editor.overflowY, "hidden");
  dom.window.close();
});
test("[records][layout] toolbar add row scrolls the saved row into view when it is outside the viewport", async () => {
  const ui = mount();
  const prototype = HTMLElement.prototype as HTMLElement & { scrollIntoView?: (options?: ScrollIntoViewOptions) => void };
  const previous = Object.getOwnPropertyDescriptor(prototype, "scrollIntoView");
  const rowPrototype = dom.window.HTMLTableRowElement.prototype;
  const previousRect = Object.getOwnPropertyDescriptor(rowPrototype, "getBoundingClientRect");
  const calls: Array<{ rowId?: string; options?: ScrollIntoViewOptions }> = [];
  Object.defineProperty(prototype, "scrollIntoView", {
    configurable: true,
    value(this: HTMLElement, options?: ScrollIntoViewOptions) { calls.push({ rowId: this.dataset.rowId, options }); },
  });
  Object.defineProperty(rowPrototype, "getBoundingClientRect", {
    configurable: true,
    value() { return { top: 900, bottom: 940, left: 0, right: 500, width: 500, height: 40 } as DOMRect; },
  });
  try {
    click(byLabel(ui.root, "Row"));
    await waitForCondition(() => {
      const added = ui.saved()?.records.at(-1);
      return !!added && calls.some((call) => call.rowId === added.id);
    }, "new row save and scrollIntoView");
    const added = ui.saved()?.records.at(-1);
    assert.ok(added);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].rowId, added.id);
    assert.equal(calls[0].options?.block, "center");
    assert.equal(calls[0].options?.inline, "nearest");
    assert.equal(calls[0].options?.behavior, "instant");
  } finally {
    if (previous) Object.defineProperty(prototype, "scrollIntoView", previous);
    else delete (prototype as HTMLElement & { scrollIntoView?: (options?: ScrollIntoViewOptions) => void }).scrollIntoView;
    if (previousRect) Object.defineProperty(rowPrototype, "getBoundingClientRect", previousRect);
    else delete (rowPrototype as HTMLTableRowElement & { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect;
    ui.cleanup();
  }
});
for (const mode of ["live-preview", "reading"] as const) for (const direction of ["asc", "desc"] as const) {
  test(`[records][views][storage] ${mode} ${direction} add row stays visible after save restoration and delayed rendering`, async () => {
    const table = fixture(); delete table.views[0].group;
    table.views[0].sort = { fieldId: table.fields[0].id, direction };
    table.records = Array.from({ length: 40 }, (_, index) => ({
      id: `row-${index}`, values: { ...table.records[0].values, [table.fields[0].id]: `Item ${String(index).padStart(2, "0")}` },
    }));
    const scroller = document.createElement("div"); scroller.style.overflowY = "auto";
    Object.defineProperties(scroller, {
      clientHeight: { configurable: true, value: 600 }, scrollHeight: { configurable: true, value: 3000 },
    });
    scroller.scrollTop = 120; document.body.append(scroller);
    const rect = (top: number, height = 40) => ({ top, bottom: top + height, left: 0, right: 800, width: 800, height, x: 0, y: top, toJSON() {} }) as DOMRect;
    const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
    const prototype = dom.window.HTMLElement.prototype;
    const originalScroll = Object.getOwnPropertyDescriptor(prototype, "scrollIntoView");
    let root: HTMLElement | null = null;
    let revealedTop: number | undefined;
    let revealedRowId: string | undefined;
    const rowTop = (row: HTMLElement) => 140 + [...root!.querySelectorAll("tr.tb-data-row")].indexOf(row) * 40;
    prototype.getBoundingClientRect = function () {
      if (this === scroller) return rect(0, 600);
      if (root && (this === root || root.contains(this))) {
        const row = this.closest<HTMLElement>("tr.tb-data-row");
        return rect((row ? rowTop(row) : 100) - scroller.scrollTop);
      }
      return originalRect.call(this);
    };
    Object.defineProperty(prototype, "scrollIntoView", { configurable: true, value(this: HTMLElement) {
      if (!this.matches("tr.tb-data-row")) return;
      revealedRowId = this.dataset.rowId;
      revealedTop = rowTop(this) - 280;
      scroller.scrollTop = revealedTop;
    } });
    let note = serializeTable(table);
    const noteView = { file: { path: "test.md" }, getMode: () => mode === "reading" ? "preview" : "source", containerEl: scroller };
    const plugin = { app: {
      workspace: { getActiveViewOfType: () => noteView },
      vault: { getAbstractFileByPath: () => new TFile("test.md"), process: async (_file: unknown, update: (text: string) => string) => {
        note = update(note);
        // Reading View rebuilds its code block after the Vault write.
        cleanup();
        const replacement = document.createElement("div"); root!.replaceWith(replacement); root = replacement;
        const controller = renderTable(plugin, scanFencedBlocks(note)[0].body, { root, sourcePath: "test.md" });
        cleanup = () => controller.destroy();
      } },
    } } as any;
    let cleanup = () => {};
    try {
      if (mode === "live-preview") {
        const extension = tableEditorExtension(plugin) as any[]; const field = extension[0];
        let state = EditorState.create({ doc: note, extensions: [editorInfoField, editorLivePreviewField, extension] });
        let widget: any;
        state.field(field).between(0, state.doc.length, (_from: number, _to: number, decoration: any) => { widget = decoration.spec.widget; });
        const editor = { dom: scroller, scrollDOM: scroller, get state() { return state; }, requestMeasure() {},
          dispatch(spec: any) { state = state.update(spec).state; },
        };
        root = widget.toDOM(editor); cleanup = () => widget.destroy();
      } else {
        root = document.createElement("div");
        const controller = renderTable(plugin, serializeTableBody(table), { root, sourcePath: "test.md" });
        cleanup = () => controller.destroy();
      }
      scroller.append(root!);
      click(byLabel(root!, "Row"));
      await waitForCondition(() => revealedTop !== undefined, "new row navigation");
      assert.ok(!table.records.some((row) => row.id === revealedRowId), "navigation targets the newly created row");
      for (let frame = 0; frame < 3; frame++) await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
      assert.equal(scroller.scrollTop, revealedTop, "save callbacks must not restore the old offset after new row navigation");
      root!.querySelector("td.tb-cell")!.append(document.createTextNode("late Markdown render"));
      for (let frame = 0; frame < 3; frame++) await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve()));
      assert.equal(scroller.scrollTop, revealedTop, "late content rendering must not pull the viewport back to the old anchor");
      const added = [...root!.querySelectorAll<HTMLTableRowElement>("tr.tb-data-row")].find((row) => row.dataset.rowId === revealedRowId)!;
      assert.ok(added.getBoundingClientRect().top >= 0 && added.getBoundingClientRect().bottom <= 600);
    } finally {
      document.body.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
      cleanup(); scroller.remove(); prototype.getBoundingClientRect = originalRect;
      if (originalScroll) Object.defineProperty(prototype, "scrollIntoView", originalScroll);
      else delete (prototype as HTMLElement & { scrollIntoView?: () => void }).scrollIntoView;
    }
  });
}
test("[records] right-click row insertion does not scroll when the inserted row is already visible", async () => {
  const ui = mount();
  const prototype = HTMLElement.prototype as HTMLElement & { scrollIntoView?: (options?: ScrollIntoViewOptions) => void };
  const previous = Object.getOwnPropertyDescriptor(prototype, "scrollIntoView");
  const rowPrototype = dom.window.HTMLTableRowElement.prototype;
  const previousRect = Object.getOwnPropertyDescriptor(rowPrototype, "getBoundingClientRect");
  const calls: Array<{ rowId?: string }> = [];
  Object.defineProperty(prototype, "scrollIntoView", {
    configurable: true,
    value(this: HTMLElement) { calls.push({ rowId: this.dataset.rowId }); },
  });
  Object.defineProperty(rowPrototype, "getBoundingClientRect", {
    configurable: true,
    value() { return { top: 100, bottom: 140, left: 0, right: 500, width: 500, height: 40 } as DOMRect; },
  });
  try {
    ui.root.querySelector(".tb-data-row")!.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true }));
    shownMenus.at(-1)!.items.find((item) => item.title === "Insert row below")!.action!({});
    await waitForCondition(() => ui.saved()?.records.length === ui.table.records.length + 1, "right-click row insertion save");
    await settle();
    assert.equal(calls.length, 0);
  } finally {
    if (previous) Object.defineProperty(prototype, "scrollIntoView", previous);
    else delete (prototype as HTMLElement & { scrollIntoView?: (options?: ScrollIntoViewOptions) => void }).scrollIntoView;
    if (previousRect) Object.defineProperty(rowPrototype, "getBoundingClientRect", previousRect);
    else delete (rowPrototype as HTMLTableRowElement & { getBoundingClientRect?: () => DOMRect }).getBoundingClientRect;
    ui.cleanup();
  }
});
test("[records][views] toolbar add row preserves filters and reports when the new row is hidden", async () => {
  const table = fixture(); const field = table.fields[0];
  table.views[0].filters = filtersFor(field.id, "WinMTR");
  const ui = mount(table); const noticeCount = notices.length;
  try {
    click(byLabel(ui.root, "Row"));
    await waitForCondition(() => ui.saved()?.records.length === table.records.length + 1 && notices.length === noticeCount + 1, "filtered row save and visibility notice");
    assert.equal(ui.saved()?.records.length, table.records.length + 1);
    assert.deepEqual(ui.saved()?.views[0].filters, table.views[0].filters);
    assert.equal(ui.root.querySelectorAll(".tb-data-row").length, 1);
    assert.equal(notices.length, noticeCount + 1);
    assert.equal(notices.at(-1), "The row was added, but is not visible in this view.");
  } finally { ui.cleanup(); }
});
test("[interaction][layout] cell operation controls are created on activation and removed when another cell becomes active", async () => {
  const table = fixture(); table.tableId = "lazy-cell-actions-test";
  table.fields.push({ id: "date", name: "日期", type: "date" }, { id: "url", name: "网址", type: "link" });
  table.records.forEach((row) => { row.values.date = "2026-10-07"; row.values.url = "example.com"; });
  const ui = mount(table);
  const countActions = () => ui.root.querySelectorAll(".tb-cell-action, .tb-choice-remove, .tb-tag-remove").length;
  const cell = (fieldId: string) => ui.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${fieldId}"]`)!;
  try {
    assert.equal(countActions(), 0);
    click(cell(table.fields[1].id));
    assert.equal(cell(table.fields[1].id).querySelectorAll(".tb-cell-action").length, 1);
    assert.equal(cell(table.fields[1].id).querySelectorAll(".tb-choice-remove").length, 1);
    click(cell(table.fields[2].id));
    assert.equal(cell(table.fields[1].id).querySelectorAll(".tb-cell-action, .tb-choice-remove").length, 0);
    assert.equal(cell(table.fields[2].id).querySelectorAll(".tb-cell-action").length, 1);
    assert.equal(cell(table.fields[2].id).querySelectorAll(".tb-tag-remove").length, 2);
    click(cell("date"));
    assert.equal(cell(table.fields[2].id).querySelectorAll(".tb-cell-action, .tb-tag-remove").length, 0);
    assert.equal(cell("date").querySelectorAll(".tb-cell-action").length, 1);
    cell("date").dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    assert.ok(cell("date").querySelector(".tb-date-input"));
    (cell("date").querySelector(".tb-date-input") as HTMLInputElement).value = "2026-10-09";
    click(cell("url"));
    await settle();
    assert.equal(cell("date").querySelectorAll(".tb-cell-action").length, 0);
    assert.equal(cell("date").querySelector(".tb-date-input"), null);
    assert.equal(cell("date").querySelector(".tb-date-label")?.textContent, "2026-10-09");
    assert.ok(ui.saved()?.records.some((row) => Object.values(row.values).includes("2026-10-09")));
    assert.equal(cell("url").querySelectorAll(".tb-cell-action").length, 1);
    click(byLabel(cell("url"), "Edit link"));
    const editor = document.querySelector<HTMLElement>(".tb-link-editor-popover"); assert.ok(editor);
    assert.equal(editor.querySelector<HTMLInputElement>(".tb-link-editor-text")?.value, "example.com");
    assert.equal(editor.querySelector<HTMLInputElement>(".tb-link-editor-url")?.value, "example.com");
    click(byEditorName(editor, "Cancel"));
    assert.equal(document.querySelector(".tb-link-editor-popover"), null);
  } finally { ui.cleanup(); }
});
test("[attachments] attachment keyboard entry opens the panel, picker cancel preserves data, and unlink keeps the Vault file", async () => {
  const table = fixture();
  const field: Field = { id: "files", name: "Files", type: "attachment", width: 220 };
  table.fields.push(field);
  table.records[0].values[field.id] = ["Assets/photo.png"];
  const file = new TFile("Assets/photo.png"); let saved: TableDocument | null = null; let deleteCalls = 0;
  const plugin = { app: {
    fileManager: { getAvailablePathForAttachment: async (name: string) => `Attachments/${name}` },
    vault: {
      getAbstractFileByPath: (path: string) => path === file.path ? file : null,
      getFiles: () => [file], getResourcePath: () => "obsidian://resource/Assets/photo.png",
      delete: async () => { deleteCalls++; },
    },
    workspace: { openLinkText: async () => {} },
  } } as any;
  const root = document.createElement("div"); document.body.append(root);
  const controller = renderTable(plugin, JSON.stringify(table), {
    root, sourcePath: "note.md", save: async (_, next) => { saved = next; return JSON.stringify(next); },
  });
  try {
    const cell = root.querySelector<HTMLTableCellElement>(`tr[data-row-id="${table.records[0].id}"] td[data-field-id="${field.id}"]`)!;
    const event = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    cell.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    let panel = document.querySelector<HTMLElement>(".tb-attachment-popover"); assert.ok(panel);
    click(panel.querySelector(".tb-attachment-add")!);
    const picker = document.querySelector<HTMLElement>(".tb-attachment-picker"); assert.ok(picker);
    const importButton = byEditorName(picker, "Import from device") as HTMLButtonElement;
    assert.equal(importButton.disabled, false, "the supported host path API enables device import");
    assert.equal(picker.querySelector(".tb-attachment-picker-unavailable"), null);
    byLabel(picker, file.path).focus();
    const fileList = picker.querySelector<HTMLElement>(".tb-attachment-picker-list")!;
    fileList.scrollTop = 32;
    click(byLabel(picker, file.path));
    assert.equal(byLabel(picker, file.path).getAttribute("aria-pressed"), "true");
    assert.equal(document.activeElement, byLabel(picker, file.path), "selection redraw preserves the focused file");
    assert.equal(fileList.scrollTop, 32);
    const search = picker.querySelector<HTMLInputElement>(".tb-attachment-picker-search")!;
    search.focus(); search.value = "no-matching-file";
    search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.ok(picker.querySelector(".tb-attachment-picker-empty"));
    search.value = "photo"; search.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
    assert.equal(byLabel(picker, file.path).getAttribute("aria-pressed"), "true", "filtering preserves selected files");
    assert.equal(document.activeElement, search, "filtering keeps focus in the search field");
    assert.equal(cell.querySelector(".tb-attachment-name"), null);
    assert.equal(cell.querySelector(".tb-attachment-direct")?.getAttribute("aria-label"), "Open photo.png");
    assert.deepEqual(table.records[0].values[field.id], ["Assets/photo.png"]);
    assert.equal(saved, null);
    click(byEditorName(picker, "Cancel"));
    assert.equal(saved, null, "canceling after selection must not update the table");

    const originalCell = cell;
    originalCell.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    panel = document.querySelector<HTMLElement>(".tb-attachment-popover"); assert.ok(panel);
    click(panel.querySelector(".tb-attachment-remove")!);
    await waitForCondition(() => !originalCell.isConnected, "unlink save");
    const savedRow = saved?.records.find((row) => row.id === table.records[0].id);
    assert.deepEqual(savedRow?.values[field.id], []);
    assert.equal(plugin.app.vault.getAbstractFileByPath(file.path), file, "unlinking must not remove the Vault file");
    assert.equal(deleteCalls, 0);
  } finally {
    const picker = document.querySelector<HTMLElement>(".tb-attachment-picker");
    if (picker?.isConnected) {
      const cancel = [...picker.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Cancel");
      cancel?.click();
    }
    controller.destroy(); root.remove();
  }
});
test("[attachments] attachment import delegates collision-free path selection to Obsidian and stores the returned Vault path", async () => {
  const style = document.createElement("style"); style.textContent = readFileSync("styles.css", "utf8"); document.head.append(style);
  const table = fixture(); delete table.views[0].sort; delete table.views[0].group;
  const field: Field = { id: "files-import", name: "Files", type: "attachment", width: 220 };
  table.fields.push(field);
  const existing = new TFile("Assets/existing.md"); const collision = new TFile("Attachments/photo.png");
  const vaultFiles = [existing, collision]; const pathCalls: Array<[string, string | undefined]> = [];
  let createdPath = ""; let createdBytes: number[] = []; let saved: TableDocument | null = null;
  const importedPath = "Attachments/photo 1.png";
  const plugin = { app: {
    fileManager: { getAvailablePathForAttachment: async (name: string, sourcePath?: string) => {
      pathCalls.push([name, sourcePath]); return importedPath;
    } },
    vault: {
      getFiles: () => vaultFiles,
      getAbstractFileByPath: (path: string) => vaultFiles.find((file) => file.path === path) ?? null,
      getResourcePath: (file: TFile) => `obsidian://resource/${file.path}`,
      createBinary: async (path: string, data: ArrayBuffer) => {
        createdPath = path; createdBytes = [...new Uint8Array(data)];
        const file = new TFile(path); vaultFiles.push(file); return file;
      },
    },
    workspace: { openLinkText: async () => {} },
  } } as any;
  const root = document.createElement("div"); document.body.append(root);
  const controller = renderTable(plugin, JSON.stringify(table), {
    root, sourcePath: "folder/note.md", save: async (_, next) => { saved = next; return JSON.stringify(next); },
  });
  try {
    const cell = root.querySelector<HTMLTableCellElement>(`tr[data-row-id="${table.records[0].id}"] td[data-field-id="${field.id}"]`)!;
    click(cell);
    click(cell.querySelector(".tb-attachment-expand")!);
    click(document.querySelector(".tb-attachment-popover .tb-attachment-add")!);
    const picker = await waitForCondition(() => !!document.querySelector(".tb-attachment-picker"), "attachment picker open").then(() => document.querySelector<HTMLElement>(".tb-attachment-picker")!);
    click(byLabel(picker, existing.path));
    const external = new File(["payload"], "photo.png", { type: "image/png" });
    Object.defineProperty(external, "arrayBuffer", { configurable: true, value: async () => new Uint8Array([1, 255, 42]).buffer });
    const input = picker.querySelector<HTMLInputElement>(".tb-attachment-picker-file-input")!;
    assert.equal(input.hidden, true);
    assert.equal(dom.window.getComputedStyle(input).display, "none", "the native file input stays out of the picker layout");
    assert.equal(input.multiple, true);
    let inputClicks = 0;
    const originalClick = input.click;
    input.click = () => { inputClicks++; };
    try { click(byEditorName(picker, "Import from device")); }
    finally { input.click = originalClick; }
    assert.equal(inputClicks, 1, "the visible import button still opens the hidden native input");
    Object.defineProperty(input, "files", { configurable: true, value: [external] });
    input.dispatchEvent(new dom.window.Event("change", { bubbles: true }));
    await waitForCondition(() => createdPath === importedPath, "device file import through Vault");
    assert.deepEqual(pathCalls, [["photo.png", "folder/note.md"]]);
    assert.deepEqual(createdBytes, [1, 255, 42]);
    assert.equal(byLabel(picker, importedPath).getAttribute("aria-pressed"), "true");
    click(byEditorName(picker, "Add selected"));
    await waitForCondition(() => {
      const value = saved?.records.find((row) => row.id === table.records[0].id)?.values[field.id];
      return Array.isArray(value) && value.length === 2 && value.includes(existing.path) && value.includes(importedPath);
    }, "attachment reference save");
    assert.deepEqual(saved?.records.find((row) => row.id === table.records[0].id)?.values[field.id], [existing.path, importedPath]);
    assert.equal(plugin.app.vault.getAbstractFileByPath(importedPath)?.path, importedPath);
    assert.equal(plugin.app.vault.getAbstractFileByPath(collision.path), collision, "pre-existing duplicate filename is left untouched");
  } finally {
    const picker = document.querySelector<HTMLElement>(".tb-attachment-picker");
    if (picker?.isConnected) {
      const cancel = [...picker.querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === "Cancel");
      cancel?.click();
    }
    controller.destroy(); root.remove(); style.remove();
  }
});
test("[attachments] clipboard image paste defaults to Obsidian's folder and appends the saved Vault path", async () => {
  const table = fixture(); delete table.views[0].sort; delete table.views[0].group;
  const field: Field = { id: "pasted-files", name: "Files", type: "attachment", width: 220 };
  table.fields.push(field); table.records[0].values[field.id] = ["Assets/existing.pdf"];
  const files = new Map<string, TFile>([["Assets/existing.pdf", new TFile("Assets/existing.pdf")]]);
  const pathCalls: Array<[string, string | undefined]> = [];
  let createdPath = ""; let createdBytes: number[] = []; let saved: TableDocument | null = null;
  const plugin = { superTableSettings: normalizeSuperTableSettings(undefined), app: {
    fileManager: { getAvailablePathForAttachment: async (name: string, sourcePath?: string) => {
      pathCalls.push([name, sourcePath]); return `Attachments/${name}`;
    } },
    vault: {
      getAbstractFileByPath: (path: string) => files.get(path) ?? null,
      getFiles: () => [...files.values()],
      getResourcePath: (file: TFile) => `obsidian://resource/${file.path}`,
      createBinary: async (path: string, data: ArrayBuffer) => {
        createdPath = path; createdBytes = [...new Uint8Array(data)];
        const file = new TFile(path); files.set(path, file); return file;
      },
    },
    workspace: { getActiveViewOfType: () => undefined, openLinkText: async () => {} },
  } } as any;
  const root = document.createElement("div"); document.body.append(root);
  const controller = renderTable(plugin, JSON.stringify(table), {
    root, sourcePath: "folder/note.md", save: async (_, next) => { saved = next; return JSON.stringify(next); },
  });
  try {
    let cell = root.querySelector<HTMLTableCellElement>(`tr[data-row-id="${table.records[0].id}"] td[data-field-id="${field.id}"]`)!;
    pointerClick(cell);
    const event = pasteClipboardImage(cell, clipboardImageFile("photo.png", "image/png"));
    assert.equal(event.defaultPrevented, true);
    await waitForCondition(() => !!saved, "pasted image attachment reference");
    assert.deepEqual(pathCalls, [["photo.png", "folder/note.md"]]);
    assert.equal(createdPath, "Attachments/photo.png");
    assert.deepEqual(createdBytes, [1, 255, 42]);
    assert.deepEqual(saved?.records[0].values[field.id], ["Assets/existing.pdf", "Attachments/photo.png"]);
    cell = root.querySelector<HTMLTableCellElement>(`tr[data-row-id="${table.records[0].id}"] td[data-field-id="${field.id}"]`)!;
    assert.ok(cell.querySelector(".tb-attachment-preview"), "the new image should use the existing attachment thumbnail renderer");
  } finally { controller.destroy(); root.remove(); }
});
test("[attachments] clipboard image paste works while the attachment panel is open", async () => {
  const table = fixture(); delete table.views[0].sort; delete table.views[0].group;
  const field: Field = { id: "pasted-files-panel", name: "Files", type: "attachment", width: 220 };
  table.fields.push(field);
  const files = new Map<string, TFile>(); let createdPath = ""; let saved: TableDocument | null = null;
  const plugin = { superTableSettings: normalizeSuperTableSettings(undefined), app: {
    fileManager: { getAvailablePathForAttachment: async (name: string) => `Attachments/${name}` },
    vault: {
      getAbstractFileByPath: (path: string) => files.get(path) ?? null,
      getFiles: () => [...files.values()],
      getResourcePath: (file: TFile) => `obsidian://resource/${file.path}`,
      createBinary: async (path: string) => {
        createdPath = path;
        const file = new TFile(path); files.set(path, file); return file;
      },
    },
    workspace: { getActiveViewOfType: () => undefined, openLinkText: async () => {} },
  } } as any;
  const root = document.createElement("div"); document.body.append(root);
  const controller = renderTable(plugin, JSON.stringify(table), {
    root, sourcePath: "note.md", save: async (_, next) => { saved = next; return JSON.stringify(next); },
  });
  try {
    const cell = root.querySelector<HTMLTableCellElement>(`tr[data-row-id="${table.records[0].id}"] td[data-field-id="${field.id}"]`)!;
    cell.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
    const panel = document.querySelector<HTMLElement>(".tb-attachment-popover"); assert.ok(panel);
    const pasteTarget = panel.querySelector<HTMLButtonElement>(".tb-attachment-add"); assert.ok(pasteTarget);
    assert.equal(document.activeElement, pasteTarget, "the open panel owns keyboard focus");
    assert.equal(cell.classList.contains("is-cell-active"), false, "the panel hides the cell selection appearance");
    const textPaste = pasteClipboardText(pasteTarget, "https://example.test/image.png");
    assert.equal(textPaste.defaultPrevented, false, "ordinary text paste in the panel should keep its existing behavior");
    assert.equal(saved, null, "text paste must not add an attachment");
    const event = pasteClipboardImage(pasteTarget, clipboardImageFile("panel-photo.png", "image/png"));
    assert.equal(event.defaultPrevented, true);
    await waitForCondition(() => !!saved, "pasted image from the open attachment panel");
    assert.equal(createdPath, "Attachments/panel-photo.png");
    assert.deepEqual(saved?.records[0].values[field.id], [createdPath]);
    let updatedCell = root.querySelector<HTMLTableCellElement>(`tr[data-row-id="${table.records[0].id}"] td[data-field-id="${field.id}"]`)!;
    await waitForCondition(() => {
      const refreshed = document.querySelector<HTMLElement>(".tb-attachment-popover");
      return refreshed?.querySelector(".tb-attachment-name")?.textContent === "panel-photo.png";
    }, "the refreshed attachment panel to stay open");
    const refreshedPanel = document.querySelector<HTMLElement>(".tb-attachment-popover"); assert.ok(refreshedPanel);
    assert.deepEqual([...refreshedPanel.querySelectorAll(".tb-attachment-name")].map((item) => item.textContent), ["panel-photo.png"]);
    assert.equal(document.activeElement, refreshedPanel.querySelector(".tb-attachment-open"), "focus should remain in the refreshed panel");
    assert.equal(updatedCell.getAttribute("aria-controls"), refreshedPanel.id);
    assert.ok(updatedCell.querySelector(".tb-attachment-preview"), "the pasted image should appear in the cell");
    const secondPasteTarget = refreshedPanel.querySelector<HTMLButtonElement>(".tb-attachment-open"); assert.ok(secondPasteTarget);
    const secondPaste = pasteClipboardImage(secondPasteTarget, clipboardImageFile("panel-photo-2.png", "image/png"));
    assert.equal(secondPaste.defaultPrevented, true, "the refreshed panel should accept another image paste");
    await waitForCondition(() => {
      const refreshed = document.querySelector<HTMLElement>(".tb-attachment-popover");
      return refreshed?.querySelectorAll(".tb-attachment-name").length === 2 &&
        [...refreshed.querySelectorAll(".tb-attachment-name")].some((item) => item.textContent === "panel-photo-2.png");
    }, "the panel to refresh after a second image paste");
    const secondRefreshedPanel = document.querySelector<HTMLElement>(".tb-attachment-popover"); assert.ok(secondRefreshedPanel);
    assert.deepEqual([...secondRefreshedPanel.querySelectorAll(".tb-attachment-name")].map((item) => item.textContent), ["panel-photo.png", "panel-photo-2.png"]);
    updatedCell = root.querySelector<HTMLTableCellElement>(`tr[data-row-id="${table.records[0].id}"] td[data-field-id="${field.id}"]`)!;
    assert.deepEqual(saved?.records[0].values[field.id], ["Attachments/panel-photo.png", "Attachments/panel-photo-2.png"]);
  } finally { controller.destroy(); root.remove(); }
});
test("[attachments] clipboard image paste can create a note-named sibling folder and avoids filename collisions", async () => {
  const table = fixture(); delete table.views[0].sort; delete table.views[0].group;
  const field: Field = { id: "pasted-files-custom", name: "Files", type: "attachment", width: 220 };
  table.fields.push(field); table.records[0].values[field.id] = ["Fitness/old.png"];
  const collisionPath = "Fitness/附件/健身房器材表/IMG_3948.png";
  const files = new Map<string, TFile>([
    ["Fitness/old.png", new TFile("Fitness/old.png")],
    [collisionPath, new TFile(collisionPath)],
  ]);
  const folders = new Set(["Fitness"]); const createdFolders: string[] = [];
  let pathCalls = 0; let createdPath = ""; let createdBytes: number[] = []; let saved: TableDocument | null = null;
  const plugin = { superTableSettings: { attachmentImagePasteLocation: "note-folder" }, app: {
    fileManager: { getAvailablePathForAttachment: async () => { pathCalls++; return "ObsidianSetting/should-not-use.png"; } },
    vault: {
      getAbstractFileByPath: (path: string) => files.get(path) ?? (folders.has(path) ? { path } : null),
      getFiles: () => [...files.values()],
      getResourcePath: (file: TFile) => `obsidian://resource/${file.path}`,
      createFolder: async (path: string) => { createdFolders.push(path); folders.add(path); return { path }; },
      createBinary: async (path: string, data: ArrayBuffer) => {
        if (files.has(path)) throw new Error("file already exists");
        createdPath = path; createdBytes = [...new Uint8Array(data)];
        const file = new TFile(path); files.set(path, file); return file;
      },
    },
    workspace: { getActiveViewOfType: () => undefined, openLinkText: async () => {} },
  } } as any;
  const root = document.createElement("div"); document.body.append(root);
  const controller = renderTable(plugin, JSON.stringify(table), {
    root, sourcePath: "Fitness/健身房器材表.md", save: async (_, next) => { saved = next; return JSON.stringify(next); },
  });
  try {
    const cell = root.querySelector<HTMLTableCellElement>(`tr[data-row-id="${table.records[0].id}"] td[data-field-id="${field.id}"]`)!;
    pointerClick(cell);
    pasteClipboardImage(cell, clipboardImageFile("IMG_3948", "image/png", [4, 5, 6]));
    await waitForCondition(() => !!saved, "custom-folder image reference");
    assert.deepEqual(createdFolders, ["Fitness/附件", "Fitness/附件/健身房器材表"]);
    assert.equal(pathCalls, 0, "the custom location should bypass Obsidian's configured attachment folder");
    assert.equal(createdPath, "Fitness/附件/健身房器材表/IMG_3948 1.png");
    assert.deepEqual(createdBytes, [4, 5, 6]);
    assert.deepEqual(saved?.records[0].values[field.id], ["Fitness/old.png", createdPath]);
    assert.equal(files.get(collisionPath)?.path, collisionPath, "a pre-existing image must not be overwritten");
  } finally { controller.destroy(); root.remove(); }
});
test("[attachments] URL-only clipboard data is not downloaded and failed image writes do not change the cell", async () => {
  const table = fixture(); delete table.views[0].sort; delete table.views[0].group;
  const field: Field = { id: "pasted-files-fail", name: "Files", type: "attachment", width: 220 };
  table.fields.push(field);
  let pathCalls = 0; let binaryCalls = 0; let saved: TableDocument | null = null;
  const plugin = { superTableSettings: normalizeSuperTableSettings(undefined), app: {
    fileManager: { getAvailablePathForAttachment: async () => { pathCalls++; return "Attachments/photo.png"; } },
    vault: {
      getAbstractFileByPath: () => null, getFiles: () => [], getResourcePath: () => "",
      createBinary: async () => { binaryCalls++; throw new Error("disk is full"); },
    },
    workspace: { getActiveViewOfType: () => undefined },
  } } as any;
  const root = document.createElement("div"); document.body.append(root);
  const controller = renderTable(plugin, JSON.stringify(table), {
    root, sourcePath: "note.md", save: async (_, next) => { saved = next; return JSON.stringify(next); },
  });
  try {
    const cell = root.querySelector<HTMLTableCellElement>(`tr[data-row-id="${table.records[0].id}"] td[data-field-id="${field.id}"]`)!;
    pointerClick(cell);
    const urlPaste = pasteClipboardText(cell, "https://example.test/photo.png");
    assert.equal(urlPaste.defaultPrevented, true);
    await settle();
    assert.equal(pathCalls, 0, "an image URL without image bytes must not be fetched");
    const beforeNotices = notices.length;
    pasteClipboardImage(cell, clipboardImageFile("photo.png", "image/png"));
    await waitForCondition(() => notices.length > beforeNotices, "failed import notice");
    assert.equal(binaryCalls, 1);
    assert.equal(saved, null, "a failed file write must not link an absent file");
    assert.match(notices.at(-1) ?? "", /disk is full/);
  } finally { controller.destroy(); root.remove(); }
});
test("[attachments] a supported attachment path API failure does not create or save a false file reference", async () => {
  const table = fixture(); delete table.views[0].sort; delete table.views[0].group;
  const field: Field = { id: "pasted-files-path-error", name: "Files", type: "attachment", width: 220 };
  table.fields.push(field);
  let pathCalls = 0; let creates = 0; let saved: TableDocument | null = null;
  const plugin = { superTableSettings: normalizeSuperTableSettings(undefined), app: {
    fileManager: { getAvailablePathForAttachment: async () => { pathCalls++; throw new Error("attachment path lookup failed"); } },
    vault: {
      getAbstractFileByPath: () => null, getFiles: () => [], getResourcePath: () => "",
      createBinary: async () => { creates++; return new TFile("unused.png"); },
    }, workspace: { getActiveViewOfType: () => undefined },
  } } as any;
  const root = document.createElement("div"); document.body.append(root);
  const controller = renderTable(plugin, JSON.stringify(table), {
    root, sourcePath: "note.md", save: async (_, next) => { saved = next; return JSON.stringify(next); },
  });
  try {
    const cell = root.querySelector<HTMLTableCellElement>(`tr[data-row-id="${table.records[0].id}"] td[data-field-id="${field.id}"]`)!;
    pointerClick(cell);
    const beforeNotices = notices.length;
    pasteClipboardImage(cell, clipboardImageFile("photo.png", "image/png"));
    await waitForCondition(() => notices.length > beforeNotices, "attachment path lookup failure notice");
    assert.match(notices.at(-1) ?? "", /attachment path lookup failed/);
    assert.equal(pathCalls, 1);
    assert.equal(creates, 0, "a path lookup failure must stop before binary creation");
    assert.equal(saved, null, "a failed import must not add an attachment path to note data");
  } finally { controller.destroy(); root.remove(); }
});
test("[attachments] paste settings normalize safely and resolve note-named attachment paths", () => {
  assert.equal(normalizeSuperTableSettings(undefined).attachmentImagePasteLocation, "obsidian");
  assert.equal(normalizeSuperTableSettings({ attachmentImagePasteLocation: "note-folder" }).attachmentImagePasteLocation, "note-folder");
  assert.equal(normalizeSuperTableSettings({ attachmentImagePasteLocation: "unknown" }).attachmentImagePasteLocation, "obsidian");
  assert.equal(noteNamedAttachmentFolder("Fitness/健身房器材表.md"), "Fitness/附件/健身房器材表");
  assert.equal(noteNamedAttachmentFolder("健身房器材表.md"), "附件/健身房器材表");
  assert.equal(pastedImageFileName("", "image/png", 123), "pasted-image-123.png");
  assert.equal(pastedImageFileName("IMG_3948", "image/png", 123), "IMG_3948.png");
  for (let code = 0; code <= 0x1f; code++) {
    const control = String.fromCharCode(code);
    assert.equal(pastedImageFileName(`A${control}B`, "image/png", 123), "A_B.png", `U+${code.toString(16).padStart(4, "0")}`);
  }
  assert.equal(pastedImageFileName(`A${String.fromCharCode(0, 1, 31)}B`, "image/png", 123), "A___B.png");
  assert.equal(pastedImageFileName("folder/ 中文 😀 A B .png ", "image/png", 123), "中文 😀 A B .png");
  assert.equal(attachmentFileNameWithSuffix("IMG_3948.png", 1), "IMG_3948 1.png");
});
function mountAttachmentTable(paths = ["Assets/one.png", "Assets/two.pdf"]) {
  const table = fixture(); delete table.views[0].sort; delete table.views[0].group;
  const field: Field = { id: "files-lifecycle", name: "Files", type: "attachment", width: 220 };
  table.fields.push(field); table.records[0].values[field.id] = paths;
  const files = paths.filter((path) => !path.includes("missing")).map((path) => new TFile(path));
  const opened: string[] = []; let saves = 0; let saved: TableDocument | null = null;
  const plugin = { app: {
    vault: {
      getAbstractFileByPath: (path: string) => files.find((file) => file.path === path) ?? null,
      getFiles: () => files,
      getResourcePath: (file: TFile) => `obsidian://resource/${file.path}`,
    },
    workspace: { openLinkText: async (path: string) => { opened.push(path); } },
  } } as any;
  const root = document.createElement("div"); document.body.append(root);
  const controller = renderTable(plugin, JSON.stringify(table), { root, sourcePath: "note.md", save: async (_, next) => { saves++; saved = next; return JSON.stringify(next); } });
  const cell = root.querySelector<HTMLTableCellElement>(`tr[data-row-id="${table.records[0].id}"] td[data-field-id="${field.id}"]`)!;
  return { root, cell, field, opened, saves: () => saves, saved: () => saved, controller, cleanup() { controller.destroy(); root.remove(); } };
}
test("[attachments] attachment cells stay compact, open on second pointer click or double-click, and dismiss outside or with Escape", () => {
  const ui = mountAttachmentTable(["Assets/one.png", "Assets/two.pdf", "Assets/three.txt", "Assets/four.png"]);
  try {
    const { cell } = ui;
    assert.equal(cell.querySelector(".tb-attachment-name"), null);
    assert.equal(cell.querySelectorAll(".tb-attachment-thumbnail").length, 3);
    assert.equal(cell.querySelector(".tb-attachment-more")?.textContent, "+1");
    pointerClick(cell);
    assert.equal(document.querySelector(".tb-attachment-popover"), null, "focusin before first click must not open the panel");
    pointerClick(cell);
    let panel = document.querySelector<HTMLElement>(".tb-attachment-popover"); assert.ok(panel);
    assert.equal(panel.querySelectorAll(".tb-attachment-remove").length, 4);
    assert.deepEqual([...panel.querySelectorAll(".tb-attachment-name")].map((item) => item.textContent), ["one.png", "two.pdf", "three.txt", "four.png"]);
    panel.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(document.querySelector(".tb-attachment-popover"), null);
    assert.equal(document.activeElement, cell);
    cell.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true, detail: 2 }));
    panel = document.querySelector<HTMLElement>(".tb-attachment-popover"); assert.ok(panel);
    document.body.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
    assert.equal(document.querySelector(".tb-attachment-popover"), null);
    assert.equal(cell.getAttribute("aria-expanded"), "false");
    pointerClick(cell);
    click(cell.querySelector(".tb-attachment-expand")!);
    const other = ui.root.querySelector<HTMLElement>(".tb-cell")!;
    pointerClick(other);
    assert.equal(document.querySelector(".tb-attachment-popover"), null);
    assert.equal(ui.saves(), 0);
  } finally { ui.cleanup(); }
});
test("[attachments] image preview leaves the table and attachment panel intact, restores focus, and cleans up on destroy", async () => {
  const ui = mountAttachmentTable();
  try {
    pointerClick(ui.cell); pointerClick(ui.cell);
    const panel = document.querySelector<HTMLElement>(".tb-attachment-popover")!;
    const open = panel.querySelector<HTMLButtonElement>(".tb-attachment-open")!;
    const scroll = ui.root.querySelector<HTMLElement>(".tb-table-scroll")!;
    scroll.scrollLeft = 67; scroll.scrollTop = 41;
    click(open);
    let modal = document.querySelector<HTMLElement>(".tb-image-preview-modal"); assert.ok(modal);
    assert.equal(modal.querySelector("img")?.getAttribute("alt"), "one.png");
    assert.deepEqual(ui.opened, [], "image preview must not navigate away from the table");
    assert.equal(ui.cell.isConnected, true);
    assert.equal(ui.cell.classList.contains("is-cell-active"), false, "focus in a popup hides the cell selection appearance");
    // The native modal owns Escape and background dismissal; the panel must defer to it.
    modal.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(panel.isConnected, true);
    click(modal.querySelector(".modal-close-button")!);
    document.body.dispatchEvent(new dom.window.FocusEvent("focusin", { bubbles: true }));
    // Native Modal may close before our document listener receives the same key.
    document.body.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    await settle();
    assert.equal(document.querySelector(".tb-image-preview-modal"), null);
    assert.equal(document.activeElement, open);
    assert.equal(scroll.scrollLeft, 67); assert.equal(scroll.scrollTop, 41);
    assert.equal(panel.isConnected, true);
    click(open);
    modal = document.querySelector<HTMLElement>(".tb-image-preview-modal"); assert.ok(modal);
    modal.querySelector("img")!.dispatchEvent(new dom.window.Event("error"));
    assert.equal(modal.querySelector<HTMLElement>(".tb-image-preview-error")?.hidden, false);
    assert.equal(ui.saves(), 0);
    ui.controller.destroy();
    assert.equal(document.querySelector(".tb-image-preview-modal"), null);
    assert.equal(document.querySelector(".tb-attachment-popover"), null);
  } finally { ui.cleanup(); }
});
test("[attachments] clicking a cell image previews it directly without opening the attachment list, including on repeated clicks", async () => {
  const ui = mountAttachmentTable();
  try {
    const button = ui.cell.querySelector<HTMLButtonElement>(".tb-attachment-direct")!;
    const scroll = ui.root.querySelector<HTMLElement>(".tb-table-scroll")!;
    scroll.scrollLeft = 57;
    pointerClick(button);
    let modal = document.querySelector<HTMLElement>(".tb-image-preview-modal"); assert.ok(modal);
    assert.equal(modal.querySelector("img")?.getAttribute("alt"), "one.png");
    assert.equal(document.querySelector(".tb-attachment-popover"), null);
    click(button);
    button.dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true, detail: 2 }));
    assert.equal(document.querySelectorAll(".tb-image-preview-modal").length, 1);
    assert.equal(document.querySelector(".tb-attachment-popover"), null);
    click(modal.querySelector(".modal-close-button")!); await settle();
    assert.equal(document.activeElement, button);
    assert.equal(scroll.scrollLeft, 57);
    assert.equal(document.querySelector(".tb-attachment-popover"), null);
    assert.equal(ui.cell.classList.contains("is-cell-active"), true);
    pointerClick(button);
    modal = document.querySelector<HTMLElement>(".tb-image-preview-modal"); assert.ok(modal);
    click(modal.querySelector(".modal-close-button")!); await settle();
    click(ui.cell.querySelector(".tb-attachment-expand")!);
    assert.ok(document.querySelector(".tb-attachment-popover"), "the dropdown button still opens the list");
    pointerClick(button);
    assert.ok(document.querySelector(".tb-image-preview-modal"));
    assert.equal(document.querySelector(".tb-attachment-popover"), null, "direct image preview closes an already open list");
    assert.deepEqual(ui.opened, []);
    assert.equal(ui.saves(), 0);
  } finally { ui.cleanup(); }
});
test("[attachments] image preview pages through the current cell's existing image attachments", async () => {
  const ui = mountAttachmentTable(["Assets/one.png", "Assets/two.pdf", "Assets/three.webp", "Assets/missing.jpg"]);
  try {
    pointerClick(ui.cell.querySelector(".tb-attachment-direct")!);
    let modal = document.querySelector<HTMLElement>(".tb-image-preview-modal"); assert.ok(modal);
    const previous = modal.querySelector<HTMLButtonElement>(".tb-image-preview-previous")!;
    const next = modal.querySelector<HTMLButtonElement>(".tb-image-preview-next")!;
    const count = modal.querySelector<HTMLElement>(".tb-image-preview-count")!;
    assert.equal(count.textContent, "1 / 2", "the counter includes only image files that exist in this cell");
    assert.equal(previous.disabled, true); assert.equal(next.disabled, false);
    assert.equal(previous.querySelector(".tb-sr-only")?.textContent, t("Previous image"));
    assert.equal(next.querySelector(".tb-sr-only")?.textContent, t("Next image"));
    click(next);
    assert.equal(count.textContent, "2 / 2");
    assert.equal(previous.disabled, false); assert.equal(next.disabled, true);
    assert.equal(modal.querySelector(".modal-title")?.textContent, "three.webp");
    assert.equal(modal.querySelector<HTMLImageElement>(".tb-image-preview-image")?.alt, "three.webp");
    click(previous);
    assert.equal(count.textContent, "1 / 2");
    assert.equal(modal.querySelector(".modal-title")?.textContent, "one.png");
    click(modal.querySelector(".modal-close-button")!); await settle();

    pointerClick(ui.cell); pointerClick(ui.cell);
    const panel = document.querySelector<HTMLElement>(".tb-attachment-popover")!;
    const thirdImage = [...panel.querySelectorAll<HTMLButtonElement>(".tb-attachment-open")]
      .find((button) => button.textContent?.includes("three.webp"))!;
    click(thirdImage);
    modal = document.querySelector<HTMLElement>(".tb-image-preview-modal"); assert.ok(modal);
    assert.equal(modal.querySelector(".tb-image-preview-count")?.textContent, "2 / 2", "opening from the attachment panel selects that image's position");
    assert.equal(modal.querySelector(".modal-title")?.textContent, "three.webp");
    assert.deepEqual(ui.opened, [], "gallery navigation stays inside the current cell");
  } finally { ui.cleanup(); }
});
test("[attachments] image preview width follows the height-fitted image while keeping room for the toolbar", async () => {
  const ui = mountAttachmentTable();
  try {
    pointerClick(ui.cell.querySelector(".tb-attachment-direct")!);
    const modal = document.querySelector<HTMLElement>(".tb-image-preview-modal"); assert.ok(modal);
    const image = modal.querySelector<HTMLImageElement>(".tb-image-preview-image")!;
    const stage = modal.querySelector<HTMLElement>(".tb-image-preview-stage")!;
    const toolbar = modal.querySelector<HTMLElement>(".tb-image-preview-toolbar")!;
    const rect = (width: number) => ({
      left: 0, top: 0, right: width, bottom: 600, x: 0, y: 0, width, height: 600,
      toJSON: () => ({}),
    }) as DOMRect;
    Object.defineProperty(modal, "getBoundingClientRect", { configurable: true, value: () => rect(1000) });
    Object.defineProperty(stage, "clientWidth", { configurable: true, value: 960 });
    Object.defineProperty(stage, "clientHeight", { configurable: true, value: 500 });
    toolbar.style.columnGap = "6px";
    [120, 1, 40, 44, 40, 32, 32].forEach((width, index) => {
      Object.defineProperty(toolbar.children[index], "getBoundingClientRect", {
        configurable: true, value: () => rect(width),
      });
    });
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 1000 });
    Object.defineProperty(image, "naturalHeight", { configurable: true, value: 2000 });
    image.dispatchEvent(new dom.window.Event("load"));

    assert.equal(modal.style.width, "385px", "the toolbar sets the minimum width when the fitted portrait is narrower");
    assert.equal(image.style.width, "250px", "the portrait fits the available height at its natural aspect ratio");
    assert.equal(image.style.height, "500px");
    click(modal.querySelector(".modal-close-button")!);
    await settle();
  } finally { ui.cleanup(); }
});
test("[attachments] image preview puts controls below the image, supports zoom, maximize and bounded panning", async () => {
  const ui = mountAttachmentTable();
  try {
    pointerClick(ui.cell.querySelector(".tb-attachment-direct")!);
    const modal = document.querySelector<HTMLElement>(".tb-image-preview-modal"); assert.ok(modal);
    const image = modal.querySelector<HTMLImageElement>(".tb-image-preview-image")!;
    const stage = modal.querySelector<HTMLElement>(".tb-image-preview-stage")!;
    const toolbar = modal.querySelector<HTMLElement>(".tb-image-preview-toolbar")!;
    const title = modal.querySelector<HTMLElement>(".modal-title")!;
    const titleText = title.querySelector<HTMLElement>(".tb-image-preview-title-text")!;
    assert.equal(title.textContent, "one.png");
    assert.equal(titleText.textContent, "one.png", "the filename remains a dedicated selectable title span");
    assert.ok(stage.compareDocumentPosition(toolbar) & dom.window.Node.DOCUMENT_POSITION_FOLLOWING, "the toolbar follows the image area");
    assert.equal(modal.querySelector(".tb-image-preview-copy"), null);
    assert.equal(modal.querySelector(".tb-image-preview-close"), null, "the native modal close button replaces the toolbar close control");
    for (const button of toolbar.querySelectorAll("button")) {
      assert.equal(button.hasAttribute("aria-label"), false, "the accessible child text avoids an Obsidian aria-label hover bubble");
      assert.equal(button.hasAttribute("title"), false);
      assert.ok(button.querySelector(".tb-sr-only"), "icon-only controls retain a screen-reader name");
    }
    assert.equal(modal.querySelector(".tb-image-preview-zoom-out [data-icon]")?.getAttribute("data-icon"), "zoom-out");
    assert.equal(modal.querySelector(".tb-image-preview-zoom-in [data-icon]")?.getAttribute("data-icon"), "zoom-in");
    const fitIcon = modal.querySelector(".tb-image-preview-fit [data-icon]")?.getAttribute("data-icon");
    const expandIcon = modal.querySelector(".tb-image-preview-expand [data-icon]")?.getAttribute("data-icon");
    assert.equal(fitIcon, "move-diagonal");
    assert.notEqual(fitIcon, expandIcon, "fit and expand controls use distinct icons");
    Object.defineProperty(stage, "clientWidth", { configurable: true, value: 800 });
    Object.defineProperty(stage, "clientHeight", { configurable: true, value: 500 });
    Object.defineProperty(image, "naturalWidth", { configurable: true, value: 1600 });
    Object.defineProperty(image, "naturalHeight", { configurable: true, value: 1000 });
    image.dispatchEvent(new dom.window.Event("load"));
    assert.equal(image.style.width, "800px", "the default size fits the preview area");
    assert.equal(image.style.height, "500px");

    click(modal.querySelector(".tb-image-preview-zoom-in")!);
    assert.equal(modal.querySelector(".tb-image-preview-zoom-level")?.textContent, "125%");
    assert.equal(image.style.width, "1000px");
    click(modal.querySelector(".tb-image-preview-fit")!);
    assert.equal(modal.querySelector(".tb-image-preview-zoom-level")?.textContent, "100%");
    click(image);
    assert.equal(modal.querySelector(".tb-image-preview-zoom-level")?.textContent, "200%", "clicking the image zooms in");
    assert.equal(image.style.width, "1600px");
    assert.equal(image.style.left, "-400px", "an oversized image starts centered inside the viewport");

    const expand = modal.querySelector<HTMLButtonElement>(".tb-image-preview-expand")!;
    click(expand);
    assert.equal(modal.classList.contains("is-expanded"), true);
    assert.equal(expand.textContent?.trim(), t("Restore preview"));
    const rect = (left: number, top: number, right: number, bottom: number) => ({
      left, top, right, bottom, x: left, y: top, width: right - left, height: bottom - top,
      toJSON: () => ({}),
    }) as DOMRect;
    Object.defineProperty(modal, "getBoundingClientRect", { configurable: true, value: () => rect(0, 0, 1000, 600) });
    Object.defineProperty(modal.querySelector(".tb-image-preview-content"), "getBoundingClientRect", {
      configurable: true, value: () => rect(0, 80, 1000, 580),
    });
    Object.defineProperty(titleText, "getBoundingClientRect", {
      configurable: true, value: () => rect(20, 20, 160, 60),
    });
    const mouseDown = (target: Element, clientX: number, clientY: number) => {
      const event = new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, clientX, clientY });
      target.dispatchEvent(event);
      return event;
    };
    assert.equal(mouseDown(modal, 800, 40).defaultPrevented, true, "blank title-bar presses do not start text selection");
    assert.equal(mouseDown(titleText, 100, 40).defaultPrevented, false, "the filename remains selectable");
    assert.equal(mouseDown(modal.querySelector(".modal-close-button")!, 980, 40).defaultPrevented, false, "the native close control keeps its normal click behavior");
    const doubleClick = (target: Element, clientX = 800, clientY = 40) => target.dispatchEvent(
      new dom.window.MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2, clientX, clientY }),
    );
    doubleClick(titleText, 100, 40);
    assert.equal(modal.classList.contains("is-expanded"), true, "double-clicking the filename leaves it available for text selection");
    doubleClick(modal);
    assert.equal(modal.classList.contains("is-expanded"), false, "double-clicking blank title-bar space restores the window");
    doubleClick(modal);
    assert.equal(modal.classList.contains("is-expanded"), true, "the full blank title-bar area expands the window");
    doubleClick(modal.querySelector(".modal-close-button")!);
    assert.equal(modal.classList.contains("is-expanded"), true, "double-clicking the close control does not toggle the window");
    doubleClick(modal, 800, 100);
    assert.equal(modal.classList.contains("is-expanded"), true, "double-clicking modal content does not toggle the window");
    click(expand);
    assert.equal(modal.classList.contains("is-expanded"), false);

    const dispatchPointer = (target: HTMLElement, type: string, x: number, y: number) => {
      target.dispatchEvent(new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, button: 0, clientX: x, clientY: y }));
    };
    dispatchPointer(image, "pointerdown", 300, 200);
    dispatchPointer(stage, "pointermove", 1200, 900);
    dispatchPointer(stage, "pointerup", 1200, 900);
    click(image);
    assert.equal(modal.querySelector(".tb-image-preview-zoom-level")?.textContent, "200%", "dragging does not trigger the image click zoom");
    assert.equal(image.style.left, "0px", "panning cannot expose space beyond the left edge");
    assert.equal(image.style.top, "0px", "panning cannot expose space beyond the top edge");
    await settle();

    dispatchPointer(image, "pointerdown", 300, 200);
    dispatchPointer(stage, "pointermove", -900, -700);
    dispatchPointer(stage, "pointerup", -900, -700);
    click(image);
    assert.equal(modal.querySelector(".tb-image-preview-zoom-level")?.textContent, "200%", "dragging does not trigger the image click zoom");
    assert.equal(image.style.left, "-800px", "panning is clamped at the right image edge");
    assert.equal(image.style.top, "-500px", "panning is clamped at the bottom image edge");
    await settle();
    click(image);
    assert.equal(modal.querySelector(".tb-image-preview-zoom-level")?.textContent, "100%");

    const css = readFileSync("styles.css", "utf8");
    assert.match(css, /\.tb-image-preview-modal \.modal-title \{[^}]*user-select: none/);
    assert.match(css, /\.tb-image-preview-title-text \{[^}]*user-select: text/);
    assert.match(css, /\.modal\.tb-image-preview-modal \{[^}]*width: min\(1120px, calc\(100vw - 32px\)\)/);
    assert.match(css, /\.tb-image-preview-stage \{[^}]*overflow: hidden/);
    click(modal.querySelector(".modal-close-button")!);
    await settle();
    assert.equal(document.querySelector(".tb-image-preview-modal"), null);
  } finally { ui.cleanup(); }
});
test("[attachments] attachment panel handles missing files, broken thumbnails, non-image navigation and keyboard focus dismissal", () => {
  const ui = mountAttachmentTable(["Assets/broken.png", "Assets/two.pdf", "Assets/missing.txt"]);
  try {
    ui.cell.querySelector("img")!.dispatchEvent(new dom.window.Event("error"));
    assert.equal(ui.cell.querySelector("img"), null);
    assert.ok(ui.cell.querySelector('[data-icon="image-off"]'));
    ui.cell.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: " ", bubbles: true }));
    let panel = document.querySelector<HTMLElement>(".tb-attachment-popover")!;
    const missing = byLabel(panel, "File not found: Assets/missing.txt") as HTMLButtonElement;
    assert.equal(missing.disabled, true);
    assert.equal(panel.querySelectorAll(".tb-attachment-remove").length, 3, "missing references must remain removable");
    click(byLabel(panel, "Open two.pdf"));
    assert.deepEqual(ui.opened, ["Assets/two.pdf"]);
    assert.equal(panel.isConnected, false);
    click(ui.cell.querySelector(".tb-attachment-expand")!);
    panel = document.querySelector<HTMLElement>(".tb-attachment-popover")!;
    ui.root.querySelector<HTMLButtonElement>(".tb-toolbar button")!.focus();
    assert.equal(panel.isConnected, false, "tabbing outside must dismiss the panel");
  } finally { ui.cleanup(); }
});

test("[attachments] queued attachment removals use the latest references and do not restore a previously removed file", async () => {
  const ui = mountAttachmentTable();
  try {
    ui.cell.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const removes = document.querySelectorAll(".tb-attachment-popover .tb-attachment-remove");
    click(removes[0]); click(removes[1]);
    await waitForCondition(() => ui.saves() === 2, "both unlink operations");
    assert.deepEqual(ui.saved()?.records[0].values[ui.field.id], []);
    const panel = document.querySelector(".tb-attachment-popover");
    assert.ok(panel, "unlinking keeps the refreshed panel open after replacing its cell");
    assert.equal(panel.querySelectorAll(".tb-attachment-remove").length, 0);
    assert.equal(panel.querySelector(".tb-attachment-count")?.textContent, "0 attachments");
  } finally { ui.cleanup(); }
});

test("[fields] column type lists share the requested order", () => {
  assert.deepEqual(FIELD_TYPES, ["text", "number", "select", "multiselect", "date", "checkbox", "link", "attachment"]);
});
test("[views][layout] view menu lists views before settings and operations and switches the active view", () => {
  const table = fixture(); table.views.push({ id: "second-view", name: "Second view", filters: emptyFilters() });
  const ui = mount(table);
  try {
    click(ui.root.querySelector(".tb-view-menu-button")!);
    const menu = shownMenus.at(-1)!;
    assert.deepEqual(menu.items.map((item) => item.title), [
      "Imported view", "Second view", "Create view", "Duplicate view", "Rename view", "Delete view",
    ]);
    assert.deepEqual(menu.items.slice(0, 2).map((item) => item.icon), ["table", "table"]);
    assert.deepEqual(menu.items.slice(0, 2).map((item) => item.checked), [true, false]);
    menu.items[1].action!({});
    assert.equal(ui.root.querySelector(".tb-view-name")?.textContent, "Second view");
    click(ui.root.querySelector(".tb-view-menu-button")!);
    assert.ok(shownMenus.at(-1)!.items.every((item) => item.title !== "Set as default view"), "non-default views do not offer a default-view action");
  } finally { ui.cleanup(); }
});

function viewStateApp(storage: Map<string, unknown>, writes: string[] = []) {
  return {
    loadLocalStorage: (key: string) => storage.get(key) ?? null,
    saveLocalStorage: (key: string, value: unknown) => { storage.set(key, value); writes.push(key); },
  };
}

test("[views][storage] last view survives renderer and app recreation without changing note data", async () => {
  const table = fixture(); table.views.push({ id: "second", name: "Second", filters: emptyFilters() });
  const original = JSON.stringify(table); const storage = new Map<string, unknown>(); const writes: string[] = [];
  const app = viewStateApp(storage, writes);
  let ui = mount(table, true, document.body, app);
  try {
    click(ui.root.querySelector(".tb-view-menu-button")!); shownMenus.at(-1)!.items[1].action!({});
    assert.equal(ui.root.querySelector(".tb-view-name")?.textContent, "Second");
    assert.equal(ui.saved(), null, "switching never writes the Markdown table");
    assert.equal(JSON.stringify(table), original);
    assert.equal(writes.length, 2, "only the initial view and changed choice are stored");
    assert.ok(writes.every((key) => key.startsWith("super-table:active-view:")), "view choices keep the existing storage key prefix");
    ui.cleanup(); ui = mount(table, true, document.body, app);
    assert.equal(ui.root.querySelector(".tb-view-name")?.textContent, "Second", "same app restores after closing a note");
    ui.cleanup(); ui = mount(table, true, document.body, viewStateApp(storage, writes));
    assert.equal(ui.root.querySelector(".tb-view-name")?.textContent, "Second", "a fresh app restores from durable local storage");
    assert.equal(writes.length, 2, "reopening does not rewrite an unchanged preference");
    await editTextCell(ui.root, "Changed record");
    assert.equal(ui.saved()?.defaultViewId, table.defaultViewId, "later edits preserve the original default");
    assert.equal(ui.saved()?.views.length, 2);
    ui.cleanup(); ui = mount(table, true, document.body, viewStateApp(new Map()));
    assert.equal(ui.root.querySelector(".tb-view-name")?.textContent, table.views[0].name, "another device has an independent choice");
    const other = { ...table, tableId: `${table.tableId}-other` };
    ui.cleanup(); ui = mount(other, true, document.body, viewStateApp(storage));
    assert.equal(ui.root.querySelector(".tb-view-name")?.textContent, table.views[0].name, "other tables do not inherit the choice");
  } finally { ui.cleanup(); }
});

test("[views][storage] missing or malformed history falls back to the stored default, then the first view", () => {
  const table = fixture(); table.views.push({ id: "default-second", name: "Default second", filters: emptyFilters() });
  table.defaultViewId = table.views[1].id;
  const storage = new Map<string, unknown>();
  let ui = mount(table, true, document.body, viewStateApp(storage));
  try {
    assert.equal(ui.root.querySelector(".tb-view-name")?.textContent, "Default second", "first visit uses the saved default even when it is not first");
    const key = [...storage.keys()][0];
    for (const value of ["deleted-view", { id: "default-second" }, 3, ""]) {
      ui.cleanup(); storage.set(key, value); ui = mount(table, true, document.body, viewStateApp(storage));
      assert.equal(ui.root.querySelector(".tb-view-name")?.textContent, "Default second");
      assert.equal(storage.get(key), "default-second", "invalid history is replaced with the resolved view");
      assert.equal(ui.saved(), null);
    }
    ui.cleanup(); table.views.pop(); ui = mount(table, true, document.body, viewStateApp(storage));
    assert.equal(ui.root.querySelector(".tb-view-name")?.textContent, table.views[0].name, "deleted last view and default fall back to the first view");
    assert.equal(storage.get(key), table.views[0].id);
  } finally { ui.cleanup(); }
});

test("[views][storage] host local storage persists choices and isolates vaults with identical table IDs", () => {
  const table = fixture(); table.views.push({ id: "second", name: "Second", filters: emptyFilters() });
  const storageA = new Map<string, unknown>(); const storageB = new Map<string, unknown>();
  const appA = viewStateApp(storageA); const appB = viewStateApp(storageB);
  let ui = mount(table, true, document.body, appA);
  try {
    click(ui.root.querySelector(".tb-view-menu-button")!); shownMenus.at(-1)!.items[1].action!({});
    ui.cleanup(); ui = mount(table, true, document.body, viewStateApp(storageA));
    assert.equal(ui.root.querySelector(".tb-view-name")?.textContent, "Second");
    ui.cleanup(); ui = mount(table, true, document.body, appB);
    assert.equal(ui.root.querySelector(".tb-view-name")?.textContent, table.views[0].name);
    assert.equal(storageB.get([...storageA.keys()][0]), table.views[0].id, "another vault starts from and stores its own default view");
    assert.equal(ui.saved(), null);
  } finally { ui.cleanup(); }
});

test("[views][storage] unavailable local storage still permits view switching and session restoration", () => {
  const table = fixture(); table.views.push({ id: "second", name: "Second", filters: emptyFilters() });
  const app = {
    loadLocalStorage() { throw new Error("unavailable"); },
    saveLocalStorage() { throw new Error("quota"); },
  };
  let ui = mount(table, true, document.body, app);
  try {
    click(ui.root.querySelector(".tb-view-menu-button")!); shownMenus.at(-1)!.items[1].action!({});
    assert.equal(ui.root.querySelector(".tb-view-name")?.textContent, "Second");
    assert.equal(ui.saved(), null);
    ui.cleanup(); ui = mount(table, true, document.body, app);
    assert.equal(ui.root.querySelector(".tb-view-name")?.textContent, "Second");
  } finally { ui.cleanup(); }
});
test("[views][layout] display configuration lists hidden fields and toggles visibility only in the active view", async () => {
  const table = fixture(); const fieldIds = table.fields.map((field) => field.id);
  table.views[0].visibleFieldIds = [fieldIds[0], fieldIds[2]];
  table.views.push({ id: "second-view", name: "Second view", filters: emptyFilters(), visibleFieldIds: [fieldIds[1]] });
  const ui = mount(table);
  try {
    click(byLabel(ui.root, "Display configuration"));
    const modal = document.querySelector<HTMLElement>(".tb-display-config-popover")!;
    const rows = [...modal.querySelectorAll<HTMLElement>(".tb-display-field-row")];
    assert.deepEqual(rows.map((row) => row.dataset.fieldId), fieldIds, "the list includes all fields in table order, including hidden fields");
    assert.equal(rows[0].classList.contains("is-hidden"), false, "visible rows use the normal text color state");
    assert.equal(rows[1].classList.contains("is-hidden"), true, "hidden rows use the subdued text color state");
    assert.equal(rows[1].querySelector<HTMLButtonElement>(".tb-display-field-visibility")?.getAttribute("aria-pressed"), "false");
    assert.equal(rows.every((row) => row.querySelectorAll("button").length === 2), true, "rows contain reorder and visibility controls only");

    click(rows[1].querySelector(".tb-display-field-visibility")!);
    await settle();
    assert.equal(modal.querySelector<HTMLElement>(`.tb-display-field-row[data-field-id="${fieldIds[1]}"]`)?.classList.contains("is-hidden"), false, "showing a field removes its hidden color state");
    assert.equal(ui.saved()?.views[0].visibleFieldIds, undefined, "showing the last hidden field normalizes the view to show all fields");
    assert.deepEqual(ui.saved()?.views[1].visibleFieldIds, [fieldIds[1]], "another view keeps its visibility settings");
    assert.deepEqual([...ui.root.querySelectorAll<HTMLTableCellElement>(".tb-header-cell")].map((header) => header.dataset.fieldId), fieldIds);

    const currentRows = [...modal.querySelectorAll<HTMLElement>(".tb-display-field-row")];
    click(currentRows[0].querySelector(".tb-display-field-visibility")!);
    await settle();
    assert.equal(modal.querySelector<HTMLElement>(`.tb-display-field-row[data-field-id="${fieldIds[0]}"]`)?.classList.contains("is-hidden"), true, "hiding a field applies the subdued color state immediately");
    click(modal.querySelector<HTMLElement>(`.tb-display-field-row[data-field-id="${fieldIds[2]}"] .tb-display-field-visibility`)!);
    await settle();
    assert.deepEqual(ui.saved()?.views[0].visibleFieldIds, [fieldIds[1]]);
    const onlyVisibleToggle = modal.querySelector<HTMLButtonElement>(`.tb-display-field-row[data-field-id="${fieldIds[1]}"] .tb-display-field-visibility`)!;
    assert.equal(onlyVisibleToggle.disabled, true, "the final visible field cannot be hidden");
    assert.ok(modal.isConnected, "the dialog remains open after immediate saves");
    closeDisplayConfig();
  } finally { closeDisplayConfig(); ui.cleanup(); }
});
test("[views][layout] display configuration keeps toggles active when a save recreates the table renderer", async () => {
  const table = fixture();
  const fieldIds = table.fields.map((field) => field.id);
  table.views[0].visibleFieldIds = fieldIds.slice(0, 2);
  let source = JSON.stringify(table);
  let active: { root: HTMLElement; controller: ReturnType<typeof renderTable> } | null = null;
  const createRenderer = (body: string) => {
    const root = document.createElement("div"); document.body.append(root);
    const controller = renderTable({ app: {} } as any, body, {
      root,
      sourcePath: `${table.tableId}.md`,
      save: async (expectedBody, next) => {
        assert.equal(expectedBody, source, "each save uses the current table body");
        source = JSON.stringify(next);
        active?.controller.destroy(); active?.root.remove();
        active = createRenderer(source);
        return source;
      },
    });
    return { root, controller };
  };
  active = createRenderer(source);
  try {
    click(byLabel(active.root, "Display configuration"));
    const modal = document.querySelector<HTMLElement>(".tb-display-config-popover")!;
    const hiddenField = modal.querySelector<HTMLButtonElement>(`.tb-display-field-row[data-field-id="${fieldIds[2]}"] .tb-display-field-visibility`)!;
    assert.equal(hiddenField.getAttribute("aria-pressed"), "false");
    click(hiddenField);
    await settle();
    const shownField = modal.querySelector<HTMLButtonElement>(`.tb-display-field-row[data-field-id="${fieldIds[2]}"] .tb-display-field-visibility`)!;
    assert.equal(shownField.getAttribute("aria-pressed"), "true", "the first save updates the button after the renderer is replaced");
    assert.ok(modal.isConnected, "the modal remains open while the table renderer is replaced");

    click(shownField);
    await settle();
    const hiddenAgain = modal.querySelector<HTMLButtonElement>(`.tb-display-field-row[data-field-id="${fieldIds[2]}"] .tb-display-field-visibility`)!;
    assert.equal(hiddenAgain.getAttribute("aria-pressed"), "false", "the replacement renderer receives the next toggle");
    assert.deepEqual(readTable(source).views[0].visibleFieldIds, fieldIds.slice(0, 2));
  } finally {
    closeDisplayConfig();
    active?.controller.destroy(); active?.root.remove();
  }
});
test("[views][layout] display configuration opens beside its toolbar trigger and dismisses accessibly", () => {
  const ui = mount();
  const trigger = ui.root.querySelector<HTMLButtonElement>(".tb-display-config-trigger")!;
  const rect = (left: number, top: number, right: number, bottom: number) => ({
    left, top, right, bottom, width: right - left, height: bottom - top, x: left, y: top,
    toJSON: () => ({}),
  });
  Object.defineProperty(trigger, "getBoundingClientRect", { configurable: true, value: () => rect(920, 740, 1024, 760) });
  try {
    click(trigger);
    const panel = document.querySelector<HTMLElement>(".tb-display-config-popover")!;
    const panelBounds = rect(0, 0, 330, 180);
    Object.defineProperty(panel, "getBoundingClientRect", { configurable: true, value: () => panelBounds });
    assert.match(readFileSync("styles.css", "utf8"), /\.tb-display-config-popover\s*\{[^}]*width: min\(330px, calc\(100vw - 32px\)\)/);
    dom.window.dispatchEvent(new dom.window.Event("resize"));
    assert.equal(panel.getAttribute("role"), "dialog");
    assert.equal(document.getElementById(panel.getAttribute("aria-labelledby") ?? "")?.textContent, "Display configuration");
    assert.equal(panel.hasAttribute("aria-modal"), false, "the anchored panel does not block the rest of the note");
    assert.equal(panel.classList.contains("modal"), false, "the settings panel is not a centered Obsidian modal");
    assert.equal(byLabel(panel, "Close display configuration").classList.contains("tb-display-config-close"), true);
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    assert.equal(trigger.getAttribute("aria-controls"), panel.id);
    assert.equal(panel.style.left, "678px", "the 330px panel stays 16px inside the viewport edge");
    assert.equal(panel.style.top, "552px", "the panel flips above the trigger with an 8px gap");

    document.body.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
    assert.equal(document.querySelector(".tb-display-config-popover"), null, "an outside pointer dismisses the panel");
    assert.equal(trigger.getAttribute("aria-expanded"), "false");
    assert.equal(trigger.hasAttribute("aria-controls"), false);

    click(trigger);
    const reopened = document.querySelector<HTMLElement>(".tb-display-config-popover")!;
    const escape = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    reopened.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(document.querySelector(".tb-display-config-popover"), null, "Escape dismisses the panel");
    assert.equal(document.activeElement, trigger, "Escape returns keyboard focus to the toolbar trigger");
  } finally {
    closeDisplayConfig();
    ui.cleanup();
  }
});
test("[views][layout] display configuration reorders shared columns by dragging and keyboard", async () => {
  const table = fixture(); table.views.push({ id: "second-view", name: "Second view", filters: emptyFilters() });
  const ui = mount(table); const originalIds = table.fields.map((field) => field.id);
  try {
    click(byLabel(ui.root, "Display configuration"));
    const modal = document.querySelector<HTMLElement>(".tb-display-config-popover")!;
    const source = modal.querySelector<HTMLElement>(`.tb-display-field-row[data-field-id="${originalIds[2]}"]`)!;
    const target = modal.querySelector<HTMLElement>(`.tb-display-field-row[data-field-id="${originalIds[0]}"]`)!;
    Object.defineProperty(target, "getBoundingClientRect", { configurable: true, value: () => ({ top: 0, bottom: 20, left: 0, right: 300, width: 300, height: 20, x: 0, y: 0, toJSON: () => ({}) }) });
    const transfer = dragDataTransfer();
    dispatchDrag(source.querySelector(".tb-display-field-drag")!, "dragstart", transfer);
    dispatchDrag(target, "dragover", transfer, 5);
    dispatchDrag(target, "drop", transfer, 5);
    await settle();
    const draggedIds = [originalIds[2], originalIds[0], originalIds[1]];
    assert.deepEqual(ui.saved()?.fields.map((field) => field.id), draggedIds);
    assert.deepEqual([...ui.root.querySelectorAll<HTMLTableCellElement>(".tb-header-cell")].map((header) => header.dataset.fieldId), draggedIds);
    assert.deepEqual(readTable(JSON.stringify(ui.saved())).fields.map((field) => field.id), draggedIds, "the new shared order round-trips through table storage");

    const movedHandle = modal.querySelector<HTMLElement>(`.tb-display-field-row[data-field-id="${originalIds[2]}"] .tb-display-field-drag`)!;
    movedHandle.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true }));
    await settle();
    assert.deepEqual(ui.saved()?.fields.map((field) => field.id), [originalIds[0], originalIds[2], originalIds[1]]);
    assert.deepEqual(ui.saved()?.views[1].visibleFieldIds, undefined, "shared order does not create view-specific ordering state");
    closeDisplayConfig();
  } finally { closeDisplayConfig(); ui.cleanup(); }
});
test("[views][layout] display configuration supports touch pointer dragging", async () => {
  const ui = mount(); const originalIds = ui.table.fields.map((field) => field.id);
  const previousElementFromPoint = Object.getOwnPropertyDescriptor(document, "elementFromPoint");
  const dispatchPointer = (target: EventTarget, type: string, values: Record<string, unknown>) => {
    const event = new dom.window.Event(type, { bubbles: true, cancelable: true }) as Event & Record<string, unknown>;
    Object.entries(values).forEach(([key, value]) => Object.defineProperty(event, key, { configurable: true, value }));
    target.dispatchEvent(event);
  };
  try {
    click(byLabel(ui.root, "Display configuration"));
    const modal = document.querySelector<HTMLElement>(".tb-display-config-popover")!;
    const source = modal.querySelector<HTMLElement>(`.tb-display-field-row[data-field-id="${originalIds[1]}"]`)!;
    const target = modal.querySelector<HTMLElement>(`.tb-display-field-row[data-field-id="${originalIds[0]}"]`)!;
    Object.defineProperty(target, "getBoundingClientRect", { configurable: true, value: () => ({ top: 0, bottom: 20, left: 0, right: 300, width: 300, height: 20, x: 0, y: 0, toJSON: () => ({}) }) });
    Object.defineProperty(document, "elementFromPoint", { configurable: true, value: () => target.querySelector(".tb-display-field-name") });
    const handle = source.querySelector<HTMLElement>(".tb-display-field-drag")!;
    dispatchPointer(handle, "pointerdown", { pointerId: 7, pointerType: "touch", button: 0, clientX: 5, clientY: 35 });
    dispatchPointer(document, "pointermove", { pointerId: 7, pointerType: "touch", clientX: 5, clientY: 5 });
    dispatchPointer(document, "pointerup", { pointerId: 7, pointerType: "touch", clientX: 5, clientY: 5 });
    await settle();
    assert.deepEqual(ui.saved()?.fields.map((field) => field.id), [originalIds[1], originalIds[0], originalIds[2]]);
    closeDisplayConfig();
  } finally {
    closeDisplayConfig();
    if (previousElementFromPoint) Object.defineProperty(document, "elementFromPoint", previousElementFromPoint);
    else Reflect.deleteProperty(document, "elementFromPoint");
    ui.cleanup();
  }
});
test("[layout] outside pointerdown closes an Obsidian menu immediately", () => {
  const ui = mount();
  click(ui.root.querySelector(".tb-view-menu-button")!);
  const menu = shownMenus.at(-1)!;
  assert.equal(menu.hidden, false);
  document.body.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
  assert.equal(menu.hidden, true);
  ui.cleanup();
});
test("[fields] column names edit inline; option menus mark the selected choice", async () => {
  const ui = mount(); const name = ui.root.querySelector<HTMLTextAreaElement>(".tb-field-name")!;
  name.value = "工具名称"; name.dispatchEvent(new dom.window.Event("change")); await settle(); assert.equal(ui.saved()?.fields[0].name, "工具名称");
  const pill = ui.root.querySelector(".tb-cell .tb-pill")!; click(pill); click(pill.closest("td")!.querySelector(".tb-cell-action")!);
  const menu = shownMenus.at(-1)!; assert.equal(menu.items.find((item) => item.title === "PC")?.icon, "check");
  assert.ok(menu.items.every((item) => !item.titleFragment?.querySelector(".tb-config-menu-label")), "cell option menus retain their own layout");
  assert.deepEqual(menu.items.slice(0, 2).map((item) => [item.title, item.section]), [["PC", "super-table-choices"], ["MAC", "super-table-choices"]]);
  assert.deepEqual(menu.items.slice(2).map((item) => item.title), ["Clear", "New option…", "Edit options…"], "choice actions stay after the ordered options");
  assert.ok(menu.items.slice(2).every((item) => !item.section), "choice actions keep the host menu layout"); ui.cleanup();
});
function visibleChoiceChecks(menu: Menu): boolean[] {
  const preview = new JSDOM("<!doctype html><head></head><body><div class='menu'></div></body>");
  try {
    const doc = preview.window.document;
    const style = doc.createElement("style"); style.textContent = readFileSync("styles.css", "utf8"); doc.head.append(style);
    return menu.items.slice(0, 2).map((item) => {
      const row = doc.createElement("div"); row.className = "menu-item";
      if (item.section) row.dataset.section = item.section;
      const icon = doc.createElement("div"); icon.className = "menu-item-icon"; icon.textContent = item.icon;
      if (item.icon) icon.append(doc.createElementNS("http://www.w3.org/2000/svg", "svg"));
      const title = doc.createElement("div"); title.className = "menu-item-title";
      assert.ok(item.titleFragment, "choice titles must retain the renderer's DOM markup");
      title.append(doc.importNode(item.titleFragment, true)); row.append(icon, title); doc.querySelector(".menu")!.append(row);
      assert.equal(icon.querySelector("svg") !== null, item.icon === "check", "only selected options render a check SVG");
      return item.icon === "check" && preview.window.getComputedStyle(icon).visibility === "visible";
    });
  } finally { preview.window.close(); }
}

function openMultiChoicePanel(root: HTMLElement, fieldId: string): HTMLDivElement {
  const cell = root.querySelector<HTMLTableCellElement>(`td[data-field-id="${fieldId}"]`)!;
  pointerClick(cell); click(cell.querySelector(".tb-cell-action")!);
  const panel = document.querySelector<HTMLDivElement>(".tb-multiselect-picker"); assert.ok(panel);
  return panel;
}

test("[fields][layout] single-choice menus show the check only on the selected choice when switching or clearing", async () => {
  for (const type of ["select", "status"] as const) {
    const table = fixture(); const field = table.fields[1]; field.type = type;
    const ui = mount(table);
    const open = () => {
      const cell = ui.root.querySelector(`td[data-field-id="${field.id}"]`)!;
      click(cell); click(cell.querySelector(".tb-cell-action")!);
      const menu = shownMenus.at(-1)!;
      assert.equal(menu.useNativeMenu, false);
      assert.deepEqual(menu.items.slice(0, 2).map((item) => item.title), ["PC", "MAC"]);
      assert.deepEqual(menu.items.slice(0, 2).map((item) => item.section), ["super-table-choices", "super-table-choices"], "the public section is limited to choice options");
      assert.deepEqual(menu.items.slice(2).map((item) => item.title), ["Clear", "New option…", "Edit options…"], "clear and option management actions remain in their original order");
      assert.ok(menu.items.slice(2).every((item) => !item.section), "actions stay in the host menu layout");
      assert.ok(menu.items.slice(0, 2).every((item) => !item.titleFragment?.querySelector(".tb-choice-option-unselected")), "choice titles no longer need an unselected marker");
      return menu;
    };
    try {
      let menu = open(); assert.deepEqual(visibleChoiceChecks(menu), [true, false]);
      await menu.items[1].action!({});
      assert.equal(ui.saved()!.records[0].values[field.id], field.options![1].id);
      menu = open(); assert.deepEqual(visibleChoiceChecks(menu), [false, true]);
      await menu.items[1].action!({});
      assert.equal(ui.saved()!.records[0].values[field.id], field.options![1].id);
      await open().items.find((item) => item.title === "Clear")!.action!({});
      assert.equal(ui.saved()!.records[0].values[field.id], "");
      assert.deepEqual(visibleChoiceChecks(open()), [false, false]);
    } finally { ui.cleanup(); }
  }
});
test("[fields][layout] choice sections reserve an empty leading icon slot without adding an unselected SVG", () => {
  const preview = new JSDOM("<!doctype html><head></head><body></body>");
  try {
    const doc = preview.window.document;
    const style = doc.createElement("style"); style.textContent = readFileSync("styles.css", "utf8"); doc.head.append(style);
    const menu = doc.createElement("div"); menu.className = "menu"; doc.body.append(menu);
    const row = (titleText: string, iconName?: string) => {
      const item = doc.createElement("div"); item.className = "menu-item"; item.dataset.section = "super-table-choices";
      const icon = doc.createElement("div"); icon.className = "menu-item-icon";
      if (iconName) icon.append(doc.createElementNS("http://www.w3.org/2000/svg", "svg"));
      const title = doc.createElement("div"); title.className = "menu-item-title"; title.textContent = titleText;
      item.append(icon, title); menu.append(item); return { item, icon, title };
    };
    const selected = row("Selected choice", "check");
    const unselected = row("Unselected choice");
    assert.equal(selected.icon.querySelector("svg") !== null, true);
    assert.equal(unselected.icon.querySelector("svg"), null, "the unselected option has no check SVG");
    assert.equal(unselected.item.dataset.section, selected.item.dataset.section, "both option rows use the same public section");
    const selectedStyle = preview.window.getComputedStyle(selected.icon);
    const unselectedStyle = preview.window.getComputedStyle(unselected.icon);
    assert.notEqual(unselectedStyle.display, "none", "the empty leading icon element remains in layout");
    assert.notEqual(unselectedStyle.width, "", "the empty icon element keeps a reserved leading width");
    assert.equal(unselectedStyle.width, selectedStyle.width, "selected and unselected titles share the same leading slot");
    assert.equal(unselected.title.previousElementSibling, unselected.icon, "the title follows the leading slot in the host menu row");
    const unrelated = row("Unrelated action"); delete unrelated.item.dataset.section;
    const nestedIcon = doc.createElement("span"); nestedIcon.className = "menu-item-icon"; unselected.title.append(nestedIcon);
    assert.equal(preview.window.getComputedStyle(unrelated.icon).width, "", "unmarked menus keep the host icon layout");
    assert.equal(preview.window.getComputedStyle(nestedIcon).width, "", "icons inside a title do not become leading slots");
  } finally { preview.window.close(); }
});
test("[views][layout] configuration menu sections keep text, content icons and checks in their own columns", () => {
  const preview = new JSDOM("<!doctype html><head></head><body></body>");
  try {
    const doc = preview.window.document;
    const style = doc.createElement("style"); style.textContent = readFileSync("styles.css", "utf8"); doc.head.append(style);
    const row = (scoped: boolean, hasIcon: boolean, checked: boolean) => {
      const item = doc.createElement("div"); item.className = "menu-item";
      if (scoped) item.dataset.section = hasIcon ? "super-table-config-icon" : "super-table-config";
      const icon = doc.createElement("div"); icon.className = "menu-item-icon";
      if (hasIcon) icon.append(doc.createElement("svg"));
      const title = doc.createElement("div"); title.className = "menu-item-title";
      const label = doc.createElement("span"); label.className = "tb-config-menu-label"; label.textContent = "Option"; title.append(label);
      item.append(icon, title);
      const check = doc.createElement("div"); check.className = "menu-item-icon mod-checked";
      if (checked) check.append(doc.createElement("svg"));
      item.append(check);
      doc.body.append(item);
      return { item, icon, title, check };
    };
    for (const hasIcon of [false, true]) for (const checked of [false, true]) {
      const entry = row(true, hasIcon, checked);
      const computed = (element: Element) => preview.window.getComputedStyle(element);
      assert.equal(entry.item.dataset.section, hasIcon ? "super-table-config-icon" : "super-table-config");
      assert.equal(computed(entry.item).display, "grid");
      assert.equal(computed(entry.item).gridTemplateColumns, hasIcon ? "16px minmax(0, 1fr) 16px" : "minmax(0, 1fr) 16px");
      assert.equal(computed(entry.title).gridColumn, hasIcon ? "2" : "1");
      if (!hasIcon) assert.equal(computed(entry.icon).display, "none", "text-only options have no empty leading icon slot");
      assert.equal(computed(entry.check).gridColumn, "-2", "selected and unselected rows reserve the fixed trailing check column");
      assert.equal(entry.check.querySelector("svg") !== null, checked);
    }
    const ordinary = row(false, true, true);
    assert.notEqual(preview.window.getComputedStyle(ordinary.item).display, "grid", "a title marker alone no longer changes unrelated menu layout");
    doc.body.classList.add("is-mobile");
    assert.notEqual(preview.window.getComputedStyle(row(true, true, true).item).display, "grid", "desktop column rules do not override mobile menus");
  } finally { preview.window.close(); }
});
test("[fields][interaction][layout] multi-choice panels keep all options visible and toggle checked values without losing other choices", async () => {
  const ui = mount(); const field = ui.table.fields[2]; const [a, b] = field.options!;
  const style = document.createElement("style"); style.textContent = readFileSync("styles.css", "utf8"); document.head.append(style);
  try {
    const panel = openMultiChoicePanel(ui.root, field.id);
    const buttons = [...panel.querySelectorAll<HTMLButtonElement>("[role='menuitemcheckbox']")];
    const states = () => buttons.map((button) => ({
      checked: button.getAttribute("aria-checked"),
      visible: dom.window.getComputedStyle(button.querySelector(".tb-multiselect-option-check")!).visibility,
    }));
    const expectStates = (checked: boolean[]) => assert.deepEqual(states(), checked.map((value) => ({ checked: String(value), visible: value ? "visible" : "hidden" })));
    const toggle = async (index: number, values: string[], checked: boolean[]) => {
      click(buttons[index]);
      await waitForCondition(() => JSON.stringify(ui.saved()?.records[0].values[field.id]) === JSON.stringify(values)
        && buttons.every((button, i) => button.getAttribute("aria-checked") === String(checked[i])), "multi-choice save and selected state update");
      assert.equal(document.querySelector(".tb-multiselect-picker"), panel); assert.ok(panel.isConnected);
      expectStates(checked);
      const trigger = ui.root.querySelector<HTMLButtonElement>(`td[data-field-id="${field.id}"] [data-choice-trigger]`)!;
      assert.equal(trigger.getAttribute("aria-expanded"), "true"); assert.equal(trigger.getAttribute("aria-controls"), panel.id);
    };
    assert.equal(panel.getAttribute("role"), "menu");
    assert.deepEqual(buttons.map((button) => button.querySelector(".tb-multiselect-option-label")?.textContent), ["A", "B"]);
    assert.ok(buttons.every((button) => !button.disabled)); expectStates([true, true]);
    assert.equal(ui.saved(), null);
    await toggle(0, [b.id], [false, true]);
    await toggle(0, [b.id, a.id], [true, true]);
    click(buttons[0]); click(buttons[1]);
    await waitForCondition(() => Array.isArray(ui.saved()?.records[0].values[field.id])
      && (ui.saved()!.records[0].values[field.id] as string[]).length === 0 && buttons.every((button) => button.getAttribute("aria-checked") === "false"), "queued multi-choice toggles");
    expectStates([false, false]); assert.ok(panel.isConnected);
    await toggle(1, [b.id], [false, true]);
    buttons[1].dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    const reopened = openMultiChoicePanel(ui.root, field.id);
    assert.deepEqual([...reopened.querySelectorAll("[role='menuitemcheckbox']")].map((button) => button.getAttribute("aria-checked")), ["false", "true"]);
  } finally { ui.cleanup(); style.remove(); }
});
test("[fields][interaction] multi-choice keyboard navigation and dismissal retain values and restore focus", () => {
  for (const empty of [false, true]) {
    const table = fixture(); const field = table.fields[2];
    if (empty) { field.options = []; table.records.forEach((row) => { row.values[field.id] = []; }); }
    const ui = mount(table); const outside = document.createElement("button"); document.body.append(outside);
    const key = (value: string) => {
      const event = new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true });
      document.activeElement!.dispatchEvent(event); assert.equal(event.defaultPrevented, true);
    };
    const trigger = () => ui.root.querySelector<HTMLButtonElement>(`td[data-field-id="${field.id}"] [data-choice-trigger]`)!;
    try {
      let panel = openMultiChoicePanel(ui.root, field.id);
      const items = [...panel.querySelectorAll<HTMLButtonElement>("[role='menuitemcheckbox'], [role='menuitem']")];
      assert.equal(document.activeElement, items[0]);
      key("ArrowUp"); assert.equal(document.activeElement, items.at(-1));
      key("ArrowDown"); assert.equal(document.activeElement, items[0]);
      key("End"); assert.equal(document.activeElement, items.at(-1));
      key("Home"); assert.equal(document.activeElement, items[0]);
      key("ArrowDown"); assert.equal(document.activeElement, items[1]);
      const anchor = trigger();
      const focus = anchor.focus.bind(anchor);
      anchor.focus = (options) => {
        assert.equal(anchor.closest("td.tb-cell")?.classList.contains("is-cell-active"), true, "reveal the CSS-hidden cell action before restoring browser focus");
        focus(options);
      };
      key("Escape");
      assert.equal(panel.isConnected, false); assert.equal(document.activeElement, anchor);
      assert.equal(anchor.getAttribute("aria-expanded"), "false"); assert.equal(anchor.hasAttribute("aria-controls"), false);
      panel = openMultiChoicePanel(ui.root, field.id);
      const pointerAnchor = trigger();
      outside.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
      assert.equal(panel.isConnected, false); assert.equal(pointerAnchor.getAttribute("aria-expanded"), "false");
      panel = openMultiChoicePanel(ui.root, field.id); const focusAnchor = trigger(); outside.focus();
      assert.equal(panel.isConnected, false); assert.equal(focusAnchor.getAttribute("aria-expanded"), "false");
      assert.equal(ui.saved(), null, "navigation and dismissal must not write cell values");
    } finally { ui.cleanup(); outside.remove(); }
  }
});
test("[fields][interaction][layout] long multi-choice lists scroll keyboard targets inside the options region", () => {
  const table = fixture(); const field = table.fields[2];
  field.options = Array.from({ length: 40 }, (_, index) => ({ id: `option-${index}`, label: `Option ${index}`, color: "gray" }));
  const ui = mount(table);
  try {
    const panel = openMultiChoicePanel(ui.root, field.id);
    const list = panel.querySelector<HTMLElement>(".tb-multiselect-options")!;
    const buttons = [...list.querySelectorAll<HTMLButtonElement>("button")];
    Object.defineProperty(list, "getBoundingClientRect", { value: () => ({ top: 100, bottom: 300 }) });
    Object.defineProperty(buttons[39], "getBoundingClientRect", { value: () => ({ top: 1300, bottom: 1332 }) });
    Object.defineProperty(buttons[0], "getBoundingClientRect", { value: () => ({ top: -932, bottom: -900 }) });
    const key = (value: string) => document.activeElement!.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true }));
    key("End"); key("ArrowUp"); key("ArrowUp");
    assert.equal(document.activeElement, buttons[39]);
    assert.equal(list.scrollTop, 1032, "only the options region scrolls to reveal an offscreen choice");
    assert.equal(panel.scrollTop, 0, "the bottom actions stay fixed");
    key("Home");
    assert.equal(document.activeElement, buttons[0]); assert.equal(list.scrollTop, 0);
    assert.equal(panel.style.maxWidth, "320px", "viewport positioning retains the menu width cap");
    assert.equal(panel.style.maxHeight, "360px", "viewport positioning retains the menu height cap");
    assert.equal(ui.saved(), null, "keyboard navigation does not change choices");
  } finally { ui.cleanup(); }
});
test("[fields][interaction] failed multi-choice saves retain previous values and selected markers", async () => {
  const table = fixture(); delete table.views[0].sort; delete table.views[0].group;
  const field = table.fields[2]; const original = JSON.stringify(table); let attempts = 0;
  const root = document.createElement("div"); document.body.append(root);
  const controller = renderTable({ app: { workspace: { getActiveViewOfType: () => null } } } as any, original, {
    root, sourcePath: `${table.tableId}.md`, save: async () => { attempts++; throw new Error("choice conflict"); },
  });
  try {
    const panel = openMultiChoicePanel(root, field.id);
    click(panel.querySelector("[role='menuitemcheckbox']")!);
    await waitForCondition(() => attempts === 1 && notices.at(-1)?.includes("choice conflict") === true, "failed multi-choice save");
    assert.equal(JSON.stringify(table), original);
    assert.deepEqual([...root.querySelectorAll(`td[data-field-id="${field.id}"]`)[0].querySelectorAll(".tb-tag")].map((tag) => tag.textContent?.replace("×", "")), ["A", "B"]);
    const visiblePanel = document.querySelector(".tb-multiselect-picker") ?? openMultiChoicePanel(root, field.id);
    assert.deepEqual([...visiblePanel.querySelectorAll("[role='menuitemcheckbox']")].map((button) => button.getAttribute("aria-checked")), ["true", "true"]);
  } finally { controller.destroy(); root.remove(); }
});
test("[fields][interaction] destroying the table removes multi-choice panel listeners", () => {
  const ui = mount(); const field = ui.table.fields[2];
  const subscriptions: Array<{ target: EventTarget; type: string; listener: any; capture: boolean; active: boolean }> = [];
  const targets = [document, dom.window];
  const originals = targets.map((target) => ({ target, add: target.addEventListener, remove: target.removeEventListener }));
  const capture = (options: any) => typeof options === "boolean" ? options : !!options?.capture;
  originals.forEach(({ target, add, remove }) => {
    target.addEventListener = function(type: string, listener: any, options?: any) {
      subscriptions.push({ target, type, listener, capture: capture(options), active: true });
      return add.call(this, type, listener, options);
    } as any;
    target.removeEventListener = function(type: string, listener: any, options?: any) {
      subscriptions.filter((entry) => entry.target === target && entry.type === type && entry.listener === listener && entry.capture === capture(options)).forEach((entry) => { entry.active = false; });
      return remove.call(this, type, listener, options);
    } as any;
  });
  try {
    const panel = openMultiChoicePanel(ui.root, field.id);
    assert.ok(subscriptions.some((entry) => entry.type === "keydown"));
    assert.ok(subscriptions.some((entry) => entry.type === "resize"));
    ui.controller.destroy();
    assert.equal(panel.isConnected, false);
    assert.deepEqual(subscriptions.filter((entry) => entry.active).map((entry) => entry.type), []);
    const event = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    document.body.dispatchEvent(event); assert.equal(event.defaultPrevented, false);
  } finally {
    originals.forEach(({ target, add, remove }) => { target.addEventListener = add; target.removeEventListener = remove; });
    ui.cleanup();
  }
});
test("[views] filter settings are a popover; closing keeps saved conditions", async () => {
  const ui = mount();
  try {
    const grid = ui.root.querySelector(".tb-grid");
    const input = addFilterDraft(ui.root);
    assert.equal(ui.root.querySelectorAll(".tb-filter-row").length, 0);
    assert.equal(document.querySelector(".tb-filter-popover")?.parentElement, document.body);
    assert.equal(ui.root.querySelector(".tb-grid"), grid, "opening and adding a draft must not redraw the table");
    assert.equal(ui.saved(), null);
    const operator = document.querySelector<HTMLButtonElement>(".tb-filter-operator")!;
    selectFilterChoice(operator, t("Contains"));
    const value = document.querySelector<HTMLInputElement>(".tb-filter-value")!;
    value.value = "Win"; value.dispatchEvent(new dom.window.Event("change")); await settle();
    assert.equal(ui.root.querySelectorAll(".tb-data-row").length, 1);
    assert.ok(document.querySelector(".tb-filter-popover"));
    click(ui.root.querySelector(".tb-filter-toggle")!);
    assert.equal(document.querySelector(".tb-filter-popover"), null);
    assert.equal(ui.saved()?.views[0].filters.conditions[0].value, "Win");
  } finally { ui.cleanup(); }
});
test("[views] filter counts and header markers follow conditions, hidden fields, views and clearing", async () => {
  const table = fixture(); delete table.views[0].sort; delete table.views[0].group;
  const [name, platform, tags] = table.fields;
  table.views[0].filters = { mode: "and", conditions: [
    { id: "one", fieldId: name.id, operator: "contains", value: "Win" },
    { id: "two", fieldId: name.id, operator: "notContains", value: "missing" },
    { id: "three", fieldId: platform.id, operator: "eq", value: [platform.options![0].id] },
  ] };
  table.views[0].visibleFieldIds = [name.id];
  const tagsView = { id: "tags-filter-view", name: "Tags", filters: filtersFor(tags.id, [tags.options![0].id], "contains") };
  table.views.push(tagsView);
  const ui = mount(table);
  const toggle = () => ui.root.querySelector<HTMLButtonElement>(".tb-filter-toggle")!;
  const headers = () => [...ui.root.querySelectorAll<HTMLElement>(".tb-header-cell.has-filter")].map((header) => header.dataset.fieldId);
  try {
    assert.equal(toggle().textContent?.trim(), t("Filter · {count} conditions", { count: 3 }));
    assert.deepEqual(headers(), [name.id]);
    click(toggle());
    assert.equal(document.querySelectorAll(".tb-filter-condition").length, 3);
    click(ui.root.querySelector(".tb-view-menu-button")!);
    await shownMenus.at(-1)!.items.find((item) => item.title === tagsView.name)!.action!({});
    assert.equal(document.querySelector(".tb-filter-popover"), null);
    assert.equal(toggle().textContent?.trim(), t("Filter · {count} conditions", { count: 1 }));
    assert.deepEqual(headers(), [tags.id]);
    click(toggle()); click(document.querySelector(".tb-filter-clear")!); await settle();
    assert.equal(toggle().textContent?.trim(), t("Filter")); assert.deepEqual(headers(), []);
  } finally { ui.cleanup(); }
});
test("[views] deleting a filtered column immediately removes its count and header marker", async () => {
  const table = fixture(); delete table.views[0].sort; delete table.views[0].group;
  const field = table.fields[0]; table.views[0].filters = filtersFor(field.id, "Win");
  const ui = mount(table);
  try {
    assert.equal(ui.root.querySelector(".tb-filter-toggle")?.textContent?.trim(), t("Filter · {count} conditions", { count: 1 }));
    assert.ok(ui.root.querySelector(`.tb-header-cell[data-field-id="${field.id}"].has-filter .tb-filter-indicator`));
    click(ui.root.querySelectorAll(".tb-header-menu")[0]);
    const deletion = shownMenus.at(-1)!.items.find((item) => item.title === t("Delete column"))!;
    const pendingDeletion = deletion.action!({});
    click([...document.querySelectorAll<HTMLButtonElement>(".tb-dialog-actions button")].at(-1)!);
    await pendingDeletion; await settle();
    assert.equal(ui.root.querySelector(".tb-filter-toggle")?.textContent?.trim(), t("Filter"));
    assert.equal(ui.root.querySelector(`.tb-header-cell[data-field-id="${field.id}"]`), null);
    assert.deepEqual(ui.saved()?.views[0].filters, emptyFilters());
  } finally { ui.cleanup(); }
});
test("[records][interaction] row right-click opens actions; selected rows highlight and support internal keyboard paste", async () => {
  const ui = mount(); const row = ui.root.querySelector(".tb-data-row")!;
  row.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true }));
  const rowMenu = shownMenus.at(-1)!;
  assert.ok(rowMenu.items.some((item) => item.title === "Insert row above"));
  assert.equal(rowMenu.items.find((item) => item.title === t("Paste row"))?.disabled, true, "Paste row should remain visible but disabled without a copied row");
  rowMenu.hide();
  click(byLabel(ui.root, "Select")); const check = byLabel(ui.root, "Select row") as HTMLInputElement;
  check.checked = true; check.dispatchEvent(new dom.window.Event("change")); assert.equal(ui.root.querySelectorAll(".is-selected").length, 1);
  ui.root.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true }));
  assert.ok(ui.root.textContent?.includes("Paste 1 row"));
  click(byLabel(ui.root, "Done"));
  const text = ui.table.fields.map((field) => cellLabel(field, ui.table.records[0].values[field.id])).join("\t");
  pasteClipboardText(ui.root, text); await settle();
  assert.equal(ui.saved()?.records.length, 3); assert.ok(!ui.root.textContent?.includes("Paste 1 row")); ui.cleanup();
});
test("[records][interaction] multi-row clipboard is not pasted into a selected cell", async () => {
  const clipboard = navigator.clipboard;
  const originalWriteText = clipboard.writeText;
  let copiedText = "";
  clipboard.writeText = async (text: string) => { copiedText = text; };
  const ui = mount();
  try {
    click(byLabel(ui.root, "Select"));
    const rowIds = ui.table.records.map((row) => row.id);
    for (const rowId of rowIds) {
      const checkbox = ui.root.querySelector<HTMLInputElement>(`tr[data-row-id="${rowId}"] input[aria-label="Select row"]`)!;
      checkbox.checked = true; checkbox.dispatchEvent(new dom.window.Event("change"));
    }
    click(byLabel(ui.root, "Copy"));
    await settle();
    assert.equal(copiedText.split("\n").length, 2);
    const targetCell = ui.root.querySelector<HTMLTableCellElement>(`tr[data-row-id="${rowIds[0]}"] td.tb-cell`)!;
    pointerClick(targetCell);
    const noticeCount = notices.length;
    const paste = pasteClipboardText(targetCell, copiedText);
    assert.equal(paste.defaultPrevented, true, "a recognized multi-row clipboard should not fall through into a cell value");
    await settle();
    assert.equal(ui.saved(), null, "multi-row clipboard paste into a cell should not modify the table");
    assert.equal(notices.length, noticeCount + 1);
    assert.equal(notices.at(-1), t("Use Paste {count} rows in the toolbar to paste these rows.", { count: 2 }));
  } finally {
    ui.cleanup();
    clipboard.writeText = originalWriteText;
  }
});
test("[records][interaction] row context menu replaces the target row with the copied row", async () => {
  const clipboard = navigator.clipboard;
  const originalWriteText = clipboard.writeText;
  let copiedText = "";
  clipboard.writeText = async (text: string) => { copiedText = text; };
  const ui = mount();
  try {
    const source = ui.table.records[0]; const target = ui.table.records[1];
    const sourceValues = JSON.parse(JSON.stringify(source.values)); const targetId = target.id;
    const sourceElement = ui.root.querySelector<HTMLTableRowElement>(`tr[data-row-id="${source.id}"]`)!;
    sourceElement.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
    const sourceMenu = shownMenus.at(-1)!;
    await sourceMenu.items.find((item) => item.title === t("Copy row"))!.action!({});
    await settle();
    assert.ok(copiedText.includes("\t"), "copying a row should write its tabular text to the system clipboard");

    const targetElement = ui.root.querySelector<HTMLTableRowElement>(`tr[data-row-id="${targetId}"]`)!;
    targetElement.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
    const targetMenu = shownMenus.at(-1)!;
    const pasteRow = targetMenu.items.find((item) => item.title === t("Paste row"));
    assert.ok(pasteRow, "the target row menu should always expose the paste action");
    assert.equal(pasteRow?.disabled, false, "Paste row should be enabled after copying one row");
    await pasteRow!.action!({});
    await waitForCondition(() => JSON.stringify(ui.saved()?.records.find((row) => row.id === targetId)?.values) === JSON.stringify(sourceValues), "target row replacement");
    assert.equal(ui.saved()?.records.length, 2, "replacing a row must not create another row");
    assert.equal(ui.saved()?.records[1].id, targetId, "replacement should preserve the target row identity and position");
    assert.deepEqual(ui.saved()?.records[1].values, sourceValues);
    assert.equal(document.querySelector(".modal"), null, "the explicit context menu action should not ask for confirmation");
  } finally {
    ui.cleanup();
    clipboard.writeText = originalWriteText;
  }
});
test("[records][interaction] pasting a copied row into a selected cell asks before replacing the row", async () => {
  const clipboard = navigator.clipboard;
  const originalWriteText = clipboard.writeText;
  let copiedText = "";
  clipboard.writeText = async (text: string) => { copiedText = text; };
  const ui = mount();
  try {
    const source = ui.table.records[0]; const target = ui.table.records[1];
    const sourceValues = JSON.parse(JSON.stringify(source.values)); const targetId = target.id;
    const sourceElement = ui.root.querySelector<HTMLTableRowElement>(`tr[data-row-id="${source.id}"]`)!;
    sourceElement.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2 }));
    await shownMenus.at(-1)!.items.find((item) => item.title === t("Copy row"))!.action!({});
    shownMenus.at(-1)!.hide();
    await settle();

    const targetCell = ui.root.querySelector<HTMLTableCellElement>(`tr[data-row-id="${targetId}"] td.tb-cell`)!;
    pointerClick(targetCell);
    const requestPaste = () => {
      targetCell.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "v", metaKey: true, bubbles: true, cancelable: true }));
      return pasteClipboardText(targetCell, copiedText);
    };
    const cancelledPaste = requestPaste();
    assert.equal(cancelledPaste.defaultPrevented, true, "the recognized row clipboard should be consumed by the selected cell");
    await waitForCondition(() => document.querySelector(".modal-title")?.textContent === t("Replace this row?"), "row replacement confirmation");
    assert.ok(document.querySelector(".tb-dialog-message")?.textContent?.includes("target row"));
    click(document.querySelector<HTMLElement>(".tb-dialog-actions button")!);
    await settle();
    assert.equal(ui.saved(), null, "cancelling the confirmation should not save or change the row");
    assert.notDeepEqual(target.values, sourceValues);

    pointerClick(ui.root.querySelector<HTMLTableCellElement>(`tr[data-row-id="${targetId}"] td.tb-cell`)!);
    const confirmedPaste = requestPaste();
    assert.equal(confirmedPaste.defaultPrevented, true);
    await waitForCondition(() => !!document.querySelector(".modal-title"), "second row replacement confirmation");
    click([...document.querySelectorAll<HTMLElement>(".tb-dialog-actions button")].at(-1)!);
    await waitForCondition(() => JSON.stringify(ui.saved()?.records.find((row) => row.id === targetId)?.values) === JSON.stringify(sourceValues), "confirmed target row replacement");
    assert.equal(ui.saved()?.records.length, 2, "confirmed replacement must not create a row");
    assert.equal(ui.saved()?.records[1].id, targetId);
    assert.deepEqual(ui.saved()?.records[1].values, sourceValues);
  } finally {
    document.querySelectorAll(".modal").forEach((modal) => modal.remove());
    ui.cleanup();
    clipboard.writeText = originalWriteText;
  }
});
test("[layout] right-click menus use pointer coordinates with zero detail; keyboard clicks keep anchor positioning", () => {
  const ui = mount();
  try {
    const row = ui.root.querySelector(".tb-data-row")!;
    for (const [target, x, y] of [
      [row.querySelector(".tb-markdown-content")!, 120, 180],
      [row.querySelector(".tb-pill")!, 720, 260],
      [row, 0, 0],
    ] as const) {
      const event = new dom.window.MouseEvent("contextmenu", { bubbles: true, cancelable: true, button: 2, clientX: x, clientY: y });
      target.dispatchEvent(event);
      const menu = shownMenus.at(-1)!;
      assert.equal(event.detail, 0);
      assert.ok(event.defaultPrevented);
      assert.equal(menu.mouseEvent, event);
      assert.equal(menu.mouseEvent.clientX, x); assert.equal(menu.mouseEvent.clientY, y);
      assert.equal(menu.position, undefined);
      assert.ok(menu.items.some(item => item.title === "Insert row above"));
    }
    const grip = row.querySelector<HTMLElement>(".tb-row-grip")!;
    grip.getBoundingClientRect = () => ({ left: 40, bottom: 200 } as DOMRect);
    click(grip);
    const keyboardMenu = shownMenus.at(-1)!;
    assert.equal(keyboardMenu.mouseEvent, undefined);
    assert.deepEqual(keyboardMenu.position, { x: 40, y: 200 });
    assert.equal(keyboardMenu.ownerDocument, grip.ownerDocument);
    assert.equal(ui.saved(), null);
  } finally { ui.cleanup(); }
});
test("[interaction] local cell edits retain the table element and horizontal scroll", async () => {
  const ui = mount(); const grid = ui.root.querySelector(".tb-grid"); const wrap = ui.root.querySelector<HTMLElement>(".tb-table-scroll")!; wrap.scrollLeft = 120;
  await editTextCell(ui.root, "edited");
  assert.equal(ui.root.querySelector(".tb-grid"), grid); assert.equal(wrap.scrollLeft, 120); assert.equal(ui.saved()?.records[0].values[ui.table.fields[0].id], "edited"); ui.cleanup();
});
test("[views] view projection dependencies include sort, group and filtered fields", () => {
  const table = fixture(); const [name, platform, tags] = table.fields; const view = table.views[0];
  view.sort = { fieldId: name.id, direction: "asc" };
  view.group = { fieldId: tags.id, direction: "asc" };
  view.filters = filtersFor(platform.id, [platform.options![0].id], "eq");
  assert.equal(viewUsesFieldForProjection(view, name.id), true);
  assert.equal(viewUsesFieldForProjection(view, tags.id), true);
  assert.equal(viewUsesFieldForProjection(view, platform.id), true);
  assert.equal(viewUsesFieldForProjection(view, "unrelated-field"), false);
});
test("[views] editing a field outside active sort, group and filter rules updates only that cell", async () => {
  const table = fixture(); const [name, platform, tags] = table.fields;
  const note: Field = { id: "note", name: "备注", type: "text" };
  table.fields.push(note);
  table.records.forEach((row, index) => { row.values[note.id] = `Note ${index + 1}`; });
  const view = table.views[0];
  view.sort = { fieldId: name.id, direction: "asc" };
  view.group = { fieldId: tags.id, direction: "asc" };
  view.filters = filtersFor(platform.id, [platform.options![0].id], "eq");
  const ui = mount(table, true);
  try {
    const grid = ui.root.querySelector(".tb-grid");
    assert.equal(ui.root.querySelectorAll(".tb-data-row").length, 1);
    const noteCell = ui.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${note.id}"]`)!;
    const nameCell = ui.root.querySelector(`td[data-field-id="${name.id}"]`);
    const input = openMarkdownEditor(noteCell);
    input.value = "Updated note"; input.blur(); await settle();
    assert.equal(ui.root.querySelector(".tb-grid"), grid);
    assert.notEqual(ui.root.querySelector(`td[data-field-id="${note.id}"]`), noteCell, "the edited cell should refresh");
    assert.equal(ui.root.querySelector(`td[data-field-id="${name.id}"]`), nameCell, "unrelated cells should retain their DOM nodes");
    assert.equal(ui.root.querySelectorAll(".tb-data-row").length, 1);
    assert.equal(ui.saved()?.records[0].values[note.id], "Updated note");

    const platformCell = ui.root.querySelector<HTMLElement>(`td[data-field-id="${platform.id}"]`)!;
    click(platformCell);
    click(platformCell.querySelector(".tb-cell-action")!);
    const menu = shownMenus.at(-1)!;
    await menu.items.find((item) => item.title === "MAC")!.action!({});
    await settle();
    assert.notEqual(ui.root.querySelector(".tb-grid"), grid, "editing a filtered field must rebuild the view");
    assert.equal(ui.root.querySelectorAll(".tb-data-row").length, 0, "the updated row should no longer match the filter");
  } finally { ui.cleanup(); }
});
test("[layout] floating horizontal scrollbar appears while a wide table extends below the viewport and stays synchronized", async () => {
  const style = document.createElement("style"); style.textContent = readFileSync("styles.css", "utf8"); document.head.append(style);
  const ui = mount(); const wrap = ui.root.querySelector<HTMLElement>(".tb-table-scroll")!;
  const proxy = document.body.querySelector<HTMLElement>(".tb-floating-scrollbar")!;
  const oldClientHeight = Object.getOwnPropertyDescriptor(document.documentElement, "clientHeight");
  Object.defineProperty(document.documentElement, "clientHeight", { configurable: true, value: 700 });
  Object.defineProperties(wrap, { clientWidth: { configurable: true, value: 600 }, scrollWidth: { configurable: true, value: 1100 } });
  let bottom = 850;
  wrap.getBoundingClientRect = () => ({ left: 20, right: 620, top: 50, bottom, width: 600, height: bottom - 50, x: 20, y: 50, toJSON: () => ({}) } as DOMRect);
  try {
    assert.equal(proxy.hidden, true);
    assert.equal(dom.window.getComputedStyle(proxy).display, "none");
    dom.window.dispatchEvent(new dom.window.Event("scroll")); await settle();
    assert.equal(proxy.hidden, false); assert.equal(proxy.style.left, "20px");
    assert.notEqual(dom.window.getComputedStyle(proxy).display, "none", "the scrollbar becomes visible when the table needs it");
    assert.equal(proxy.getAttribute("aria-valuemax"), "500");
    proxy.scrollLeft = 120; proxy.dispatchEvent(new dom.window.Event("scroll"));
    assert.equal(wrap.scrollLeft, 120);
    wrap.scrollLeft = 250; wrap.dispatchEvent(new dom.window.Event("scroll", { bubbles: false }));
    assert.equal(proxy.scrollLeft, 250);
    bottom = 650; dom.window.dispatchEvent(new dom.window.Event("resize")); await settle();
    assert.equal(proxy.hidden, true);
    assert.equal(dom.window.getComputedStyle(proxy).display, "none", "the scrollbar leaves the layout when the table bottom is visible");
  } finally {
    ui.cleanup(); style.remove();
    assert.equal(proxy.isConnected, false, "destroying the table removes its floating scrollbar");
    if (oldClientHeight) Object.defineProperty(document.documentElement, "clientHeight", oldClientHeight);
    else delete (document.documentElement as unknown as { clientHeight?: number }).clientHeight;
  }
});
test("[interaction] cell selection does not open a menu, save or rebuild; focus loss clears selection after dropdown edits", async () => {
  const ui = mount(); const grid = ui.root.querySelector(".tb-grid"); const menusBefore = shownMenus.length;
  const pill = ui.root.querySelector(".tb-choice .tb-pill")!; const cell = pill.closest("td")!;
  click(pill);
  assert.equal(shownMenus.length, menusBefore); assert.equal(ui.saved(), null);
  assert.equal(ui.root.querySelector(".tb-grid"), grid); assert.ok(cell.classList.contains("is-cell-active"));
  click(ui.root.querySelector(".tb-tags")!); assert.ok(!cell.classList.contains("is-cell-active"));
  assert.equal(ui.root.querySelectorAll(".is-cell-active").length, 1);
  click(cell); click(cell.querySelector(".tb-cell-action")!);
  const elsewhere = document.createElement("button"); document.body.append(elsewhere); elsewhere.focus();
  await settle();
  assert.equal(cell.classList.contains("is-cell-active"), false); elsewhere.remove();
  shownMenus.at(-1)!.items.find(item => item.title === "MAC")!.action!({}); await settle();
  const updated = ui.root.querySelector(`td[data-field-id="${ui.table.fields[1].id}"]`)!;
  assert.equal(updated.classList.contains("is-cell-active"), false);
  assert.equal(updated.querySelector(".tb-choice-label")!.textContent, "MAC");
  assert.equal(ui.root.querySelector(".tb-grid"), grid);
  pointerClick(updated as HTMLElement);
  click(byLabel(updated, "Clear 平台")); await settle();
  assert.equal(ui.saved()?.records[0].values[ui.table.fields[1].id], "");
  assert.equal(ui.root.querySelector(".is-cell-active .tb-choice-label"), null); ui.cleanup();
});
test("[interaction] filtering away the active record clears cell selection", async () => {
  const ui = mount(); click(ui.root.querySelector(".tb-choice")!);
  addFilterDraft(ui.root);
  const operator = document.querySelector<HTMLButtonElement>(".tb-filter-operator")!; selectFilterChoice(operator, t("Contains"));
  const input = document.querySelector<HTMLInputElement>(".tb-filter-value")!;
  input.value = "IINA"; input.dispatchEvent(new dom.window.Event("change")); await settle();
  assert.equal(ui.root.querySelectorAll(".tb-data-row").length, 1);
  assert.equal(ui.root.querySelectorAll(".is-cell-active").length, 0); ui.cleanup();
});
test("[interaction] reading-view remount clears the active cell after its focus is lost", () => {
  const ui = mount(); click(ui.root.querySelector(".tb-choice")!); const table = ui.table; ui.cleanup();
  const menusBefore = shownMenus.length; const remounted = mount(table);
  assert.equal(remounted.root.querySelectorAll(".is-cell-active").length, 0);
  assert.equal(shownMenus.length, menusBefore); remounted.cleanup();
});
test("[interaction] dates and links use explicit edit buttons, Markdown text uses repeated clicks, and checkboxes stay direct", async () => {
  const table = fixture(); table.fields.push({ id: "date", name: "日期", type: "date" }, { id: "url", name: "网址", type: "link" }, { id: "check", name: "完成", type: "checkbox" });
  table.fields.find((field) => field.id === "date")!.dateFormat = "slash-date";
  table.records[0].values.date = "2026-10-06"; table.records[0].values.url = "example.com";
  const ui = mount(table); const dateCell = ui.root.querySelector('td[data-field-id="date"]')!;
  assert.equal(dateCell.querySelector(".tb-date-label")?.textContent, "2026/10/06");
  click(dateCell); assert.equal(dateCell.querySelector("input"), null); click(byLabel(dateCell, "Edit 日期"));
  const date = dateCell.querySelector<HTMLInputElement>(".tb-date-input")!; assert.equal(date.type, "text"); assert.equal(date.value, "2026/10/06");
  assert.equal(dateCell.querySelector<HTMLInputElement>(".tb-date-native-picker")?.type, "date");
  date.value = "2026/10/07"; date.dispatchEvent(new dom.window.Event("change")); await settle();
  assert.equal(ui.saved()?.records[0].values.date, "2026-10-07");
  assert.equal(ui.root.querySelector('td[data-field-id="date"] .tb-date-label')?.textContent, "2026/10/07");
  const updatedDateCell = ui.root.querySelector('td[data-field-id="date"]')!;
  click(updatedDateCell); click(byLabel(updatedDateCell, "Edit 日期"));
  const nativeDatePicker = updatedDateCell.querySelector<HTMLInputElement>(".tb-date-native-picker")!;
  nativeDatePicker.value = "2026-10-08"; nativeDatePicker.dispatchEvent(new dom.window.Event("change")); await settle();
  assert.equal(ui.saved()?.records[0].values.date, "2026-10-08");
  assert.equal(ui.root.querySelector('td[data-field-id="date"] .tb-date-label')?.textContent, "2026/10/08");
  const label = ui.root.querySelector(".tb-link-label")!; click(label.closest("td")!);
  assert.equal(document.querySelectorAll(".tb-link-editor-popover").length, 0);
  click(byLabel(label.closest("td")!, "Edit link"));
  let linkEditor = document.querySelector<HTMLElement>(".tb-link-editor-popover")!;
  const linkText = linkEditor.querySelector<HTMLInputElement>(".tb-link-editor-text")!;
  const url = linkEditor.querySelector<HTMLInputElement>(".tb-link-editor-url")!;
  assert.equal(linkText.value, "example.com"); assert.equal(url.value, "example.com");
  linkText.value = "Project site"; url.value = "example.org";
  click(byEditorName(linkEditor, "Confirm")); await settle();
  assert.equal(ui.saved()?.records[0].values.url, "[Project site](example.org)");
  assert.equal(ui.root.querySelector('td[data-field-id="url"] .tb-link-text')?.textContent, "Project site");
  const check = byLabel(ui.root, "完成") as HTMLInputElement; click(check); assert.equal(check.checked, true); await settle();
  assert.equal(ui.saved()?.records[0].values.check, true);
  const textCell = ui.root.querySelector(`td[data-field-id="${table.fields[0].id}"]`)!;
  assert.equal(textCell.querySelector("textarea"), null);
  const text = openMarkdownEditor(textCell);
  text.focus(); assert.ok(text.closest("td")!.classList.contains("is-cell-active")); assert.equal(text.readOnly, false); ui.cleanup();
});
test("[fields][layout][interaction] date editors keep native input sizing and usable text fallback across picker types", async () => {
  const table = fixture();
  table.fields = [
    { id: "date", name: "Date", type: "date", dateFormat: "iso-date" },
    { id: "datetime", name: "Datetime", type: "date", dateFormat: "iso-datetime" },
    { id: "time", name: "Time", type: "date", dateFormat: "time" },
  ];
  table.records = [
    { id: "existing", values: { date: "2026-10-06T08:09:10", datetime: "2026-10-06T09:15:37", time: "2026-10-06T08:09:10" } },
    { id: "empty", values: { date: "", datetime: "", time: "" } },
  ];
  const style = document.createElement("style"); style.textContent = readFileSync("styles.css", "utf8");
  const hostStyle = document.createElement("style");
  hostStyle.textContent = `
    input { position: relative; width: 18px; height: 18px; min-width: 11px; min-height: 12px; padding: 4px; border: 2px solid rgb(1, 2, 3); }
    .theme-date-host input[type]:focus {
      position: fixed; width: 18px; height: 18px; min-width: 11px; min-height: 12px;
      padding: 4px 9px; border: 3px solid rgb(4, 5, 6);
    }
  `;
  // JSDOM lets a later, less-specific rule win; keep the representative host rule first and cover specificity in a real browser.
  document.head.append(hostStyle, style);

  type PickerBehavior = "success" | "fallback" | "both-throw";
  let behavior: PickerBehavior = "success";
  let showPickerCalls = 0;
  let fallbackClicks = 0;
  const inputPrototype = dom.window.HTMLInputElement.prototype;
  const previousShowPicker = Object.getOwnPropertyDescriptor(inputPrototype, "showPicker");
  const previousClick = Object.getOwnPropertyDescriptor(inputPrototype, "click");
  const originalClick = inputPrototype.click;
  let cleanup: (() => void) | undefined;
  try {
    Object.defineProperty(inputPrototype, "showPicker", {
      configurable: true,
      value(this: HTMLInputElement) {
        if (!this.classList.contains("tb-date-native-picker")) return;
        showPickerCalls++;
        if (behavior !== "success") throw new Error("picker API unavailable in this test");
      },
    });
    Object.defineProperty(inputPrototype, "click", {
      configurable: true,
      value(this: HTMLInputElement) {
        if (!this.classList.contains("tb-date-native-picker")) return originalClick.call(this);
        fallbackClicks++;
        if (behavior === "both-throw") throw new Error("native click unavailable in this test");
      },
    });

    const ui = mount(table); ui.root.classList.add("theme-date-host");
    cleanup = ui.cleanup;
    const cellFor = (fieldId: string, rowId: string) => ui.root.querySelector<HTMLTableCellElement>(`tr[data-row-id="${rowId}"] td[data-field-id="${fieldId}"]`)!;
    const cases: Array<{ fieldId: string; rowId: string; pickerType: string; pickerValue: string; inputValue: string; behavior: PickerBehavior }> = [
      { fieldId: "date", rowId: "existing", pickerType: "date", pickerValue: "2026-10-06", inputValue: "2026-10-06", behavior: "success" },
      { fieldId: "datetime", rowId: "existing", pickerType: "datetime-local", pickerValue: "2026-10-06T09:15", inputValue: "2026-10-06 09:15", behavior: "fallback" },
      { fieldId: "time", rowId: "existing", pickerType: "time", pickerValue: "08:09", inputValue: "08:09", behavior: "both-throw" },
      { fieldId: "date", rowId: "empty", pickerType: "date", pickerValue: "", inputValue: "", behavior: "fallback" },
      { fieldId: "datetime", rowId: "empty", pickerType: "datetime-local", pickerValue: "", inputValue: "", behavior: "both-throw" },
      { fieldId: "time", rowId: "empty", pickerType: "time", pickerValue: "", inputValue: "", behavior: "success" },
    ];
    let previousEditor: HTMLInputElement | undefined;
    for (const item of cases) {
      const cell = cellFor(item.fieldId, item.rowId);
      click(cell);
      if (previousEditor) {
        assert.equal(previousEditor.isConnected, false, "selecting another cell closes the prior editor");
        assert.equal(ui.saved(), null, "Escape cancellation must not save a draft");
      }
      const showBefore = showPickerCalls;
      const clickBefore = fallbackClicks;
      behavior = item.behavior;
      click(cell.querySelector(".tb-cell-action")!);
      const input = cell.querySelector<HTMLInputElement>(".tb-date-input")!;
      const picker = cell.querySelector<HTMLInputElement>(".tb-date-native-picker")!;
      assert.ok(input, "the formatted text editor stays available");
      assert.equal(input.value, item.inputValue);
      assert.equal(picker.type, item.pickerType);
      assert.equal(picker.value, item.pickerValue);
      assert.equal(picker.matches(".tablebase-root .tb-cell .tb-date.is-editing > input.tb-date-native-picker"), true, "the native input is tested in its rendered editing structure");
      assert.equal(showPickerCalls, showBefore + 1, "opening the editor attempts showPicker once");
      assert.equal(fallbackClicks, clickBefore + (item.behavior === "success" ? 0 : 1), "a failed showPicker uses the click fallback");

      picker.focus();
      const computed = dom.window.getComputedStyle(picker);
      assert.equal(computed.position, "absolute");
      assert.equal(computed.borderTopWidth, "0px");
      assert.equal(computed.borderRightWidth, "0px");
      assert.equal(computed.borderBottomWidth, "0px");
      assert.equal(computed.borderLeftWidth, "0px");
      assert.equal(computed.width, "1px");
      assert.equal(computed.height, "1px");
      assert.equal(computed.minWidth, "1px");
      assert.equal(computed.minHeight, "1px");
      assert.equal(computed.paddingTop, "0px");
      assert.equal(computed.paddingRight, "0px");
      assert.equal(computed.paddingBottom, "0px");
      assert.equal(computed.paddingLeft, "0px");
      assert.equal(computed.opacity, "0");
      input.focus();
      input.value = "temporary invalid draft";
      input.dispatchEvent(new dom.window.Event("input"));
      input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
      assert.equal(input.value, item.inputValue, "Escape restores the formatted value");
      previousEditor = input;
    }
    click(cellFor("date", "existing"));
    assert.equal(previousEditor?.isConnected, false);
    assert.equal(ui.saved(), null, "closing a cancelled editor does not save");

    behavior = "success";
    const dateCell = cellFor("date", "existing"); click(dateCell); click(dateCell.querySelector(".tb-cell-action")!);
    const datePicker = dateCell.querySelector<HTMLInputElement>(".tb-date-native-picker")!;
    datePicker.value = "2026-10-09"; datePicker.dispatchEvent(new dom.window.Event("change"));
    await waitForCondition(() => ui.saved()?.records.find((row) => row.id === "existing")?.values.date === "2026-10-09T08:09:10", "date picker selection preserves hidden time and seconds");

    const datetimeCell = cellFor("datetime", "existing"); click(datetimeCell); click(datetimeCell.querySelector(".tb-cell-action")!);
    const datetimePicker = datetimeCell.querySelector<HTMLInputElement>(".tb-date-native-picker")!;
    datetimePicker.value = "2026-10-09T14:30"; datetimePicker.dispatchEvent(new dom.window.Event("change"));
    await waitForCondition(() => ui.saved()?.records.find((row) => row.id === "existing")?.values.datetime === "2026-10-09T14:30:37", "datetime picker selection preserves seconds");

    const timeCell = cellFor("time", "existing"); click(timeCell); click(timeCell.querySelector(".tb-cell-action")!);
    const timePicker = timeCell.querySelector<HTMLInputElement>(".tb-date-native-picker")!;
    timePicker.value = "15:40"; timePicker.dispatchEvent(new dom.window.Event("change"));
    await waitForCondition(() => ui.saved()?.records.find((row) => row.id === "existing")?.values.time === "2026-10-06T15:40:10", "time picker selection preserves the date and seconds");

    behavior = "both-throw";
    const emptyDatetimeCell = cellFor("datetime", "empty"); click(emptyDatetimeCell); click(emptyDatetimeCell.querySelector(".tb-cell-action")!);
    const fallbackText = emptyDatetimeCell.querySelector<HTMLInputElement>(".tb-date-input")!;
    assert.ok(fallbackText.isConnected, "the text editor remains usable when both picker APIs throw");
    fallbackText.value = "2026-10-10 16:45"; fallbackText.dispatchEvent(new dom.window.Event("change"));
    await waitForCondition(() => ui.saved()?.records.find((row) => row.id === "empty")?.values.datetime === "2026-10-10T16:45", "text input saves when both picker APIs throw");

    const cancelCell = cellFor("datetime", "empty"); click(cancelCell); click(cancelCell.querySelector(".tb-cell-action")!);
    const cancelInput = cancelCell.querySelector<HTMLInputElement>(".tb-date-input")!;
    const lastSaved = ui.saved();
    cancelInput.value = "2026-10-11 09:00"; cancelInput.dispatchEvent(new dom.window.Event("input"));
    cancelInput.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    click(cellFor("time", "empty"));
    assert.equal(ui.saved(), lastSaved, "Escape cancellation leaves the last saved table untouched");
    assert.equal(ui.saved()?.records.find((row) => row.id === "empty")?.values.datetime, "2026-10-10T16:45");

    const clearCell = cellFor("date", "existing"); click(clearCell); click(clearCell.querySelector(".tb-cell-action")!);
    const clearPicker = clearCell.querySelector<HTMLInputElement>(".tb-date-native-picker")!;
    clearPicker.value = ""; clearPicker.dispatchEvent(new dom.window.Event("change"));
    await waitForCondition(() => ui.saved()?.records.find((row) => row.id === "existing")?.values.date === "", "clearing a date picker value saves an empty cell");
  } finally {
    try { cleanup?.(); }
    finally {
      style.remove(); hostStyle.remove();
      if (previousShowPicker) Object.defineProperty(inputPrototype, "showPicker", previousShowPicker);
      else delete (inputPrototype as HTMLInputElement & { showPicker?: () => void }).showPicker;
      if (previousClick) Object.defineProperty(inputPrototype, "click", previousClick);
      else delete (inputPrototype as HTMLInputElement & { click?: () => void }).click;
    }
  }
});
test("[layout][interaction][markdown] resizing covers the table controls and restores its cursor after completion or cancellation", async () => {
  const style = document.createElement("style"); style.textContent = readFileSync("styles.css", "utf8"); document.head.append(style);
  const previousMarkdownRender = MarkdownRenderer.render;
  const table = fixture();
  table.fields = [
    { id: "note", name: "Note", type: "text" },
    { id: "unmapped", name: "Ambiguous task", type: "text" },
    { id: "pending", name: "Pending task", type: "text" },
    { id: "url", name: "URL", type: "link" },
  ];
  table.records = [{ id: "row", values: {
    note: "Editable note", unmapped: "- [ ] first\n- [ ] second", pending: "- [ ] pending", url: "https://example.org",
  } }];
  MarkdownRenderer.render = async (_app, markdown, element) => {
    if (!markdown.includes("[ ]")) { element.textContent = markdown; return; }
    const list = document.createElement("ul");
    const item = document.createElement("li"); item.classList.add("task-list-item");
    const checkbox = document.createElement("input"); checkbox.type = "checkbox"; checkbox.classList.add("task-list-item-checkbox");
    item.append(checkbox, document.createTextNode(" task")); list.append(item); element.replaceChildren(list);
  };

  const root = document.createElement("div"); document.body.append(root);
  let releaseSave!: () => void;
  const saveGate = new Promise<void>((resolve) => { releaseSave = resolve; });
  let holdFirstSave = true;
  let destroy: (() => void) | undefined;
  try {
    const controller = renderTable({ app: {} } as any, JSON.stringify(table), {
      root, sourcePath: "resize-cursor.md",
      save: async (_, next) => {
        if (holdFirstSave) { holdFirstSave = false; await saveGate; }
        return JSON.stringify(next);
      },
    });
    destroy = () => controller.destroy();
    await waitForCondition(() => !!root.querySelector("input.task-list-item-checkbox[disabled]")
      && !!root.querySelector("button.tb-markdown-task-toggle"), "mapped and unmapped task controls render");
    const editableText = root.querySelector<HTMLElement>('td[data-field-id="note"] .tb-markdown-content')!;
    assert.equal(editableText.textContent, "Editable note", "the Markdown text remains an editable cell preview");
    const disabledMarkdownCheckbox = root.querySelector<HTMLInputElement>("input.task-list-item-checkbox[disabled]")!;
    const taskButton = root.querySelector<HTMLButtonElement>("button.tb-markdown-task-toggle")!;
    click(taskButton);
    await waitForCondition(() => taskButton.disabled, "Markdown task button disables during its queued write");
    const link = root.querySelector<HTMLAnchorElement>('td[data-field-id="url"] a.tb-link-text')!;
    const targets = [disabledMarkdownCheckbox, taskButton, editableText, link];
    for (const target of targets) {
      const cell = target.closest("td.tb-cell"); assert.ok(cell, `${target.tagName}.${target.className} is nested in a real table cell`);
      assert.ok(cell!.closest("tr.tb-data-row"), "the cell belongs to a rendered data row");
      assert.ok(cell!.closest("table.tb-grid"), "the row belongs to the rendered grid");
      assert.ok(cell!.closest(".tb-table-scroll"), "the grid belongs to the real scroll wrapper");
      assert.ok(cell!.closest(".tb-shell"), "the scroll wrapper belongs to the table shell");
    }
    const shell = root.querySelector<HTMLElement>(".tb-shell")!;
    const scroll = root.querySelector<HTMLElement>(".tb-table-scroll")!;
    assert.ok(targets.every((target) => scroll.contains(target)), "disabled controls, editable text and links are inside the active resize selector scope");
    // JSDOM gives later low-specificity control rules priority, so only the uncontested shell cursor is computed here.
    const pointerEvent = (type: string, pointerId: number) => {
      const event = new dom.window.MouseEvent(type, { bubbles: true, cancelable: true, clientX: 20 });
      Object.defineProperty(event, "pointerId", { value: pointerId });
      return event;
    };
    const drag = (endType: "pointerup" | "pointercancel", pointerId: number) => {
      const handle = root.querySelector<HTMLElement>(".tb-resize-handle")!;
      const captures = new Set<number>();
      Object.defineProperties(handle, {
        setPointerCapture: { configurable: true, value: (id: number) => { captures.add(id); } },
        hasPointerCapture: { configurable: true, value: (id: number) => captures.has(id) },
        releasePointerCapture: { configurable: true, value: (id: number) => { captures.delete(id); } },
      });
      const start = handle.onpointerdown;
      assert.ok(start, "the real table resize start handler is installed");
      start.call(handle, pointerEvent("pointerdown", pointerId) as unknown as PointerEvent);
      assert.equal(root.classList.contains("tb-resizing"), true, "the actual table resize handler enters its drag state");
      assert.equal(dom.window.getComputedStyle(shell).cursor, "col-resize", "the active table shell uses the resize cursor");
      handle.dispatchEvent(pointerEvent("pointermove", pointerId));
      assert.equal(dom.window.getComputedStyle(shell).cursor, "col-resize");
      handle.dispatchEvent(pointerEvent(endType, pointerId));
      assert.equal(root.classList.contains("tb-resizing"), false, `${endType} leaves the drag state`);
      assert.notEqual(dom.window.getComputedStyle(shell).cursor, "col-resize", "the table shell cursor is restored");
      assert.ok(targets.every((target) => scroll.contains(target)), "all relevant controls remain under the table scroll wrapper after the drag");
    };

    drag("pointerup", 1);
    drag("pointercancel", 2);
    releaseSave();
  } finally {
    releaseSave(); await settle();
    destroy?.(); root.remove(); MarkdownRenderer.render = previousMarkdownRender; style.remove();
  }
});
test("[interaction] link editor cancels without saving and uses the URL as display text when the label is blank", async () => {
  const table = fixture(); table.fields.push({ id: "url", name: "网址", type: "link" }); table.records[0].values.url = "example.com";
  const ui = mount(table);
  const openEditor = () => {
    const cell = ui.root.querySelector<HTMLTableCellElement>('td[data-field-id="url"]')!;
    if (!cell.classList.contains("is-cell-active")) click(cell);
    click(byLabel(cell, "Edit link"));
    return document.querySelector<HTMLElement>(".tb-link-editor-popover")!;
  };
  try {
    let editor = openEditor();
    editor.querySelector<HTMLInputElement>(".tb-link-editor-text")!.value = "discarded";
    click(byEditorName(editor, "Cancel")); await settle();
    assert.equal(ui.saved(), null);

    editor = openEditor();
    editor.querySelector<HTMLInputElement>(".tb-link-editor-text")!.value = "Project site";
    editor.querySelector<HTMLInputElement>(".tb-link-editor-url")!.value = "https://example.org";
    click(byEditorName(editor, "Confirm")); await settle();
    assert.equal(ui.saved()?.records[0].values.url, "[Project site](https://example.org)");

    editor = openEditor();
    editor.querySelector<HTMLInputElement>(".tb-link-editor-text")!.value = "";
    editor.querySelector<HTMLInputElement>(".tb-link-editor-url")!.value = "https://example.net";
    click(byEditorName(editor, "Confirm")); await settle();
    assert.equal(ui.saved()?.records[0].values.url, "https://example.net");
    const display = ui.root.querySelector<HTMLAnchorElement>('td[data-field-id="url"] .tb-link-text');
    assert.equal(display?.textContent, "https://example.net");
    assert.equal(display?.href, "https://example.net/");
  } finally { ui.cleanup(); }
});
test("[interaction] Markdown text cells select on the first pointer click and edit on the next without an edit button", () => {
  const ui = mount();
  try {
    const cell = ui.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${ui.table.fields[0].id}"]`)!;
    pointerClick(cell); // Focusin runs before click in Obsidian Live Preview.
    assert.ok(cell.classList.contains("is-cell-active"));
    assert.equal(cell.querySelector(".tb-markdown-edit"), null);
    assert.equal(cell.querySelector("textarea.tb-markdown-editor"), null);

    pointerClick(cell);
    const input = cell.querySelector<HTMLTextAreaElement>("textarea.tb-markdown-editor");
    assert.ok(input, "a second click on the active cell should enter source editing");
    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(cell.querySelector("textarea.tb-markdown-editor"), null);
    assert.equal(ui.saved(), null, "cancelling the test edit must not save");
  } finally { ui.cleanup(); }
});
test("[interaction] rapid text and number clicks suppress native selection across the whole cell", () => {
  const table = fixture();
  table.fields.push({ id: "review", name: "Review", type: "text" }, { id: "quantity", name: "Quantity", type: "number" });
  table.records[0].values.review = ""; table.records[0].values.quantity = "";
  const ui = mount(table);
  const mouseDown = (target: Element, detail: number, button = 0) => {
    const event = new dom.window.MouseEvent("mousedown", { bubbles: true, cancelable: true, detail, button });
    target.dispatchEvent(event); return event;
  };
  try {
    for (const fieldId of [table.fields[0].id, "review", "quantity"]) {
      const cell = ui.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${fieldId}"]`)!;
      const preview = cell.querySelector<HTMLElement>(".tb-markdown-content, .tb-number-preview")!;
      pointerClick(cell);
      for (const target of [cell, preview.parentElement!, preview]) {
        assert.equal(mouseDown(target, 1).defaultPrevented, false, "single clicks retain normal focus behavior");
        assert.equal(mouseDown(target, 2, 2).defaultPrevented, false, "context-menu presses are unchanged");
        for (const detail of [2, 3]) {
          assert.equal(mouseDown(target, detail).defaultPrevented, true, "multi-click selection must not move focus to a preceding editable cell");
          assert.equal(document.activeElement, cell);
        }
      }
      pointerClick(cell);
      const input = cell.querySelector<HTMLInputElement | HTMLTextAreaElement>(".tb-cell-input")!;
      assert.ok(input, "the next click still opens the editor");
      assert.equal(document.activeElement, input);
      assert.equal(mouseDown(input, 2).defaultPrevented, false, "native word selection inside the editor remains available");
      input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    }
    const cell = ui.root.querySelector<HTMLTableCellElement>("td.tb-cell")!;
    const grip = cell.querySelector(".tb-row-grip")!;
    const task = document.createElement("button"); cell.querySelector(".tb-markdown-content")!.append(task);
    for (const target of [grip, task]) {
      assert.equal(mouseDown(target, 2).defaultPrevented, false, "cell controls retain their own behavior");
    }
    assert.equal(ui.saved(), null);
  } finally { ui.cleanup(); }
});
test("[interaction][markdown] text selection released on the cell edge keeps the editor and selection", async () => {
  for (const endpoint of ["cell", "wrapper", "editor", "outside"] as const) for (const direction of ["backward", "forward"] as const) {
    const ui = mount();
    try {
      const cell = ui.root.querySelector<HTMLTableCellElement>("td.tb-cell")!;
      const input = openMarkdownEditor(cell);
      input.value = "Select this draft text";
      input.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
      input.setSelectionRange(0, 11, direction);
      const releaseTarget = endpoint === "cell" ? cell : endpoint === "wrapper" ? input.parentElement! : endpoint === "outside" ? ui.root : input;
      releaseTarget.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true }));
      const releasedClick = new dom.window.MouseEvent("click", { bubbles: true, cancelable: true });
      releaseTarget.dispatchEvent(releasedClick);
      await settle();
      assert.equal(document.activeElement, input, `${endpoint}/${direction}: selection must not focus the outer cell`);
      assert.equal(input.isConnected, true);
      assert.equal(cell.classList.contains("is-cell-editing"), true);
      assert.deepEqual([input.selectionStart, input.selectionEnd, input.selectionDirection], [0, 11, direction]);
      assert.equal(ui.saved(), null, "selecting draft text must not save it");
      if (endpoint === "editor") assert.equal(releasedClick.defaultPrevented, false, "normal input clicks keep their native behavior");

      pointerClick(cell);
      await settle();
      assert.equal(input.isConnected, false, "a new press on the cell edge still leaves editing");
      assert.equal(ui.saved()?.records[0].values[ui.table.fields[0].id], "Select this draft text");
    } finally { ui.cleanup(); }
  }
});
test("[interaction] number cells select on the first click and enter edit on the second", async () => {
  const table = fixture(); const field: Field = { id: "quantity", name: "数量", type: "number" };
  table.fields.push(field); table.records[0].values[field.id] = 4;
  const ui = mount(table);
  try {
    let cell = ui.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${field.id}"]`)!;
    assert.equal(cell.querySelector("input"), null);
    assert.equal(cell.querySelector(".tb-number-preview")?.textContent, "4");

    pointerClick(cell);
    assert.ok(cell.classList.contains("is-cell-active"));
    assert.equal(cell.querySelector("input"), null, "the first click should only select the number cell");

    pointerClick(cell);
    let input = cell.querySelector<HTMLInputElement>("input.tb-number-editor");
    assert.ok(input, "the second click should open the number editor");
    assert.equal(input.type, "text"); assert.equal(input.inputMode, "decimal");
    input.value = "12.5";
    const enter = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    input.dispatchEvent(enter);
    assert.equal(enter.defaultPrevented, true);
    await waitForCondition(() => ui.saved()?.records[0].values[field.id] === 12.5, "number edit save");

    cell = ui.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${field.id}"]`)!;
    const escape = new dom.window.MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 });
    cell.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true);
    input = cell.querySelector<HTMLInputElement>("input.tb-number-editor")!;
    input.value = "99";
    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    await settle();
    assert.equal(ui.saved()?.records[0].values[field.id], 12.5, "Escape should cancel the number edit");
  } finally { ui.cleanup(); }
});
test("[interaction][markdown] typing replaces selected text or numbers in a cancellable draft", async () => {
  for (const type of ["text", "number"] as const) {
    const table = fixture(); const field = table.fields[0]; field.type = type;
    table.records.forEach((row) => { row.values[field.id] = type === "text" ? "Original" : 42; });
    const ui = mount(table);
    const cell = () => ui.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${field.id}"]`)!;
    const editor = () => cell().querySelector<HTMLInputElement | HTMLTextAreaElement>(".tb-cell-input")!;
    const key = (target: Element, value: string, options: KeyboardEventInit = {}) => {
      const event = new dom.window.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...options });
      target.dispatchEvent(event); return event;
    };
    try {
      pointerClick(cell());
      const first = key(cell(), type === "text" ? "A" : "-");
      assert.equal(first.defaultPrevented, true);
      assert.equal(editor().value, type === "text" ? "A" : "-", "the first character replaces the old value exactly once");
      assert.equal(document.activeElement, editor());
      assert.equal(ui.saved(), null, "typing does not commit the draft");
      key(editor(), "Escape");
      assert.equal(ui.saved(), null, "Escape retains the original value");
      for (const entry of ["Enter", " ", "dblclick"]) {
        cell().focus();
        if (entry === "dblclick") cell().dispatchEvent(new dom.window.MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 }));
        else key(cell(), entry);
        assert.equal(editor().value, type === "text" ? "Original" : "42", `${entry} preserves the old value`);
        if (entry !== "dblclick") {
          editor().dispatchEvent(new dom.window.KeyboardEvent("keyup", { key: entry, bubbles: true, cancelable: true }));
          assert.ok(editor(), "releasing the opening key must leave the editor open");
        }
        key(editor(), "Escape");
      }
      pointerClick(cell()); key(cell(), type === "text" ? "😀" : ".");
      assert.equal(editor().value, type === "text" ? "😀" : ".");
      editor().value = type === "text" ? "😀 replacement" : "-.5";
      key(editor(), "Enter"); await settle();
      assert.equal(ui.saved()?.records[0].values[field.id], type === "text" ? "😀 replacement" : -0.5);
    } finally { ui.cleanup(); }
  }
});
test("[interaction] invalid numeric replacement drafts never clear or change the old number", async () => {
  for (const draft of ["-", ".", "+", "1e", "not a number", " ", "0x20", "Infinity", "1e999"]) {
    const table = fixture(); const field = table.fields[0]; field.type = "number";
    table.records.forEach((row) => { row.values[field.id] = 42; });
    const ui = mount(table);
    try {
      const cell = ui.root.querySelector<HTMLTableCellElement>("td.tb-cell")!; pointerClick(cell);
      cell.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: draft[0], bubbles: true, cancelable: true }));
      // Space opens an editor with the existing value; ordinary characters replace it.
      const input = cell.querySelector<HTMLInputElement>(".tb-number-editor")!;
      input.value = draft; input.blur(); await settle();
      assert.equal(ui.saved(), null, `${draft}: invalid or incomplete input must preserve 42`);
      assert.equal(cell.querySelector(".tb-number-preview")?.textContent, "42");
    } finally { ui.cleanup(); }
  }
});
test("[interaction] desktop cell focus starts native IME while preview mutations stay blocked", () => {
  for (const mobile of [false, true]) {
    Platform.isMobile = mobile;
    const ui = mount();
    try {
      const cell = ui.root.querySelector<HTMLTableCellElement>("td.tb-cell")!;
      assert.equal(cell.getAttribute("contenteditable"), mobile ? null : "plaintext-only");
      const preview = cell.querySelector<HTMLElement>(".tb-markdown-content")!;
      assert.equal(preview.getAttribute("contenteditable"), "false");
      if (!mobile) {
        pointerClick(preview);
        assert.equal(document.activeElement, cell, "clicking the read-only preview must leave the cell ready for native IME input");
        for (const inputType of ["insertText", "insertFromDrop", "deleteContentBackward", "insertParagraph"]) {
          const event = new dom.window.InputEvent("beforeinput", { inputType, data: "unowned input", bubbles: true, cancelable: true });
          cell.dispatchEvent(event);
          assert.equal(event.defaultPrevented, true, inputType);
        }
        assert.equal(ui.saved(), null, "unowned native edits must never mutate stored values");
      }
    } finally { ui.cleanup(); Platform.isMobile = false; }
  }
});
test("[interaction][layout] selected cells hide their caret and native IME drafts share the normal editor inset", () => {
  const style = document.createElement("style"); style.textContent = readFileSync("styles.css", "utf8"); document.head.append(style);
  try {
    for (const types of [["text", "number"], ["number", "text"]] as const) {
      const table = fixture();
      table.fields = types.map((type, index) => ({ id: `value-${index}`, name: type, type, align: index ? "right" : "left" }));
      table.records.forEach((row) => { row.values = { "value-0": types[0] === "text" ? "Original" : 42, "value-1": types[1] === "text" ? "Original" : 42 }; });
      const ui = mount(table);
      try {
        for (const field of table.fields) {
          const cell = ui.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${field.id}"]`)!;
          cell.focus();
          assert.match(dom.window.getComputedStyle(cell).caretColor, /transparent|rgba\(0, 0, 0, 0\)/);
          cell.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
          const editor = cell.querySelector<HTMLElement>(".tb-cell-input")!;
          const editorStyle = dom.window.getComputedStyle(editor);
          const wrapStyle = dom.window.getComputedStyle(editor.parentElement!);
          const editorLayout = [editorStyle.paddingLeft, editorStyle.paddingRight, editorStyle.fontSize, editorStyle.lineHeight];
          const wrapLayout = [wrapStyle.paddingLeft, wrapStyle.paddingRight, wrapStyle.paddingTop, wrapStyle.paddingBottom];
          assert.doesNotMatch(editorStyle.caretColor, /transparent|rgba\(0, 0, 0, 0\)/);
          editor.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
          cell.focus();
          cell.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Process", keyCode: 229, bubbles: true, cancelable: true }));
          const draft = cell.querySelector<HTMLElement>(".tb-cell-composition")!;
          assert.ok(draft, "composition needs an editor surface inside the original focus target");
          assert.equal(document.activeElement, cell);
          assert.equal(document.getSelection()?.anchorNode, draft);
          assert.equal(draft.style.textAlign, field.align);
          const draftStyle = dom.window.getComputedStyle(draft);
          const draftWrapStyle = dom.window.getComputedStyle(draft.parentElement!);
          assert.deepEqual([draftStyle.paddingLeft, draftStyle.paddingRight, draftStyle.fontSize, draftStyle.lineHeight], editorLayout);
          assert.deepEqual([draftWrapStyle.paddingLeft, draftWrapStyle.paddingRight, draftWrapStyle.paddingTop, draftWrapStyle.paddingBottom], wrapLayout);
          assert.doesNotMatch(draftStyle.caretColor, /transparent|rgba\(0, 0, 0, 0\)/);
          cell.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
          assert.equal(cell.querySelector(".tb-cell-composition"), null);
          assert.match(dom.window.getComputedStyle(cell).caretColor, /transparent|rgba\(0, 0, 0, 0\)/);
          assert.equal(ui.saved(), null);
        }
      } finally { ui.cleanup(); }
    }
  } finally { style.remove(); }
});
test("[interaction][markdown] IME startup keeps native focus through the first syllable before opening the editor", async () => {
  for (const type of ["text", "number"] as const) for (const startup of [
    { key: "Process", keyCode: 229 }, { key: "Unidentified", keyCode: 229 },
    { key: "n", isComposing: true }, { key: "Dead" },
  ]) {
    const table = fixture(); const field = table.fields[0]; field.type = type;
    table.records.forEach((row) => { row.values[field.id] = type === "text" ? "Original" : 42; });
    const ui = mount(table);
    try {
      const cell = ui.root.querySelector<HTMLTableCellElement>("td.tb-cell")!; pointerClick(cell);
      const start = new dom.window.KeyboardEvent("keydown", { ...startup, bubbles: true, cancelable: true });
      cell.dispatchEvent(start);
      assert.equal(cell.querySelector("input.tb-cell-input, textarea.tb-cell-input"), null);
      assert.equal(cell.textContent, ""); assert.equal(document.activeElement, cell);
      assert.equal(start.defaultPrevented, false, "the IME must receive its native first keystroke");
      cell.dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true }));
      // jsdom has no native IME: model the text on its original focus target.
      cell.querySelector<HTMLElement>(".tb-cell-composition")!.textContent = type === "text" ? "中文" : "12.5";
      const nativeInput = new dom.window.InputEvent("beforeinput", { bubbles: true, cancelable: true, inputType: "insertCompositionText", isComposing: true });
      cell.dispatchEvent(nativeInput); assert.equal(nativeInput.defaultPrevented, false);
      cell.dispatchEvent(new dom.window.InputEvent("input", { bubbles: true, inputType: "insertCompositionText", isComposing: true }));
      const candidate = new dom.window.KeyboardEvent("keydown", { key: "Enter", isComposing: true, bubbles: true, cancelable: true });
      cell.dispatchEvent(candidate);
      assert.equal(candidate.defaultPrevented, false);
      cell.dispatchEvent(new dom.window.CompositionEvent("compositionend", { bubbles: true, data: cell.textContent }));
      await settle();
      const input = cell.querySelector<HTMLInputElement | HTMLTextAreaElement>(".tb-cell-input")!;
      assert.ok(input); assert.equal(input.value, type === "text" ? "中文" : "12.5");
      input.dispatchEvent(new dom.window.KeyboardEvent("keyup", { key: "Enter", bubbles: true, cancelable: true }));
      assert.equal(input.isConnected, true, "candidate-confirmation keyup must not save the cell");
      assert.equal(ui.saved(), null);
      input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
      await settle();
      assert.equal(ui.saved()?.records[0].values[field.id], type === "text" ? "中文" : 12.5);
    } finally { ui.cleanup(); }
  }
});
test("[interaction] interrupted native composition restores the original preview without saving", async () => {
  for (const end of ["escape", "blur", "destroy", "cancel"]) {
    const ui = mount();
    try {
      const cell = ui.root.querySelector<HTMLTableCellElement>("td.tb-cell")!;
      const original = cell.textContent;
      pointerClick(cell);
      cell.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Process", keyCode: 229, bubbles: true }));
      cell.dispatchEvent(new dom.window.CompositionEvent("compositionstart", { bubbles: true }));
      if (end === "escape") cell.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      else if (end === "blur") ui.root.querySelector<HTMLButtonElement>("button")!.focus();
      else if (end === "destroy") ui.controller.destroy();
      else cell.dispatchEvent(new dom.window.CompositionEvent("compositionend", { bubbles: true, data: "" }));
      await settle();
      assert.equal(cell.textContent, original, end);
      assert.equal(ui.saved(), null, end);
      assert.equal(cell.querySelector(".tb-cell-input"), null, end);
    } finally { ui.cleanup(); }
  }
});
test("[interaction] direct typing respects shortcuts, actual focus, controls, and field types", () => {
  const ui = mount();
  const other = mount();
  try {
    const cell = ui.root.querySelector<HTMLTableCellElement>("td.tb-cell")!;
    pointerClick(cell);
    for (const init of [
      { key: "a", metaKey: true }, { key: "a", ctrlKey: true }, { key: "e", altKey: true },
      { key: "ArrowDown" }, { key: "Tab" }, { key: "Shift" }, { key: "Escape" },
    ]) {
      cell.dispatchEvent(new dom.window.KeyboardEvent("keydown", { ...init, bubbles: true, cancelable: true }));
      assert.equal(cell.querySelector(".tb-cell-input"), null);
    }
    const button = ui.root.querySelector<HTMLButtonElement>("button")!;
    button.focus(); button.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "a", bubbles: true }));
    assert.equal(cell.querySelector(".tb-cell-input"), null);
    // A stale selected appearance is insufficient without actual cell focus.
    cell.classList.add("is-cell-active");
    cell.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "a", bubbles: true }));
    assert.equal(cell.querySelector(".tb-cell-input"), null);
    const choice = ui.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${ui.table.fields[1].id}"]`)!;
    pointerClick(choice); choice.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "a", bubbles: true }));
    assert.equal(choice.querySelector(".tb-cell-input"), null);
    const otherCell = other.root.querySelector<HTMLTableCellElement>("td.tb-cell")!;
    pointerClick(otherCell);
    otherCell.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "X", shiftKey: true, bubbles: true, cancelable: true }));
    assert.equal(otherCell.querySelector<HTMLTextAreaElement>(".tb-cell-input")?.value, "X");
    assert.equal(cell.querySelector(".tb-cell-input"), null, "typing belongs to only the focused table");
    const input = otherCell.querySelector<HTMLTextAreaElement>(".tb-cell-input")!;
    const next = new dom.window.KeyboardEvent("keydown", { key: "y", bubbles: true, cancelable: true });
    input.dispatchEvent(next);
    assert.equal(next.defaultPrevented, false, "subsequent input stays with the native editor");
    assert.equal(input.value, "X", "jsdom does not insert the native second character");
  } finally { ui.cleanup(); other.cleanup(); }
});
test("[interaction] Cmd/Ctrl+V pastes into selected text and number cells", async () => {
  const clipboardSource = mount();
  click(byLabel(clipboardSource.root, "Select"));
  const rowCheck = byLabel(clipboardSource.root, "Select row") as HTMLInputElement;
  rowCheck.checked = true; rowCheck.dispatchEvent(new dom.window.Event("change"));
  clipboardSource.root.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true }));
  clipboardSource.cleanup();

  const table = fixture(); const field: Field = { id: "quantity", name: "数量", type: "number" };
  table.fields.push(field); table.records[0].values[field.id] = 4;
  const ui = mount(table);
  try {
    const textField = table.fields[0];
    let cell = ui.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${textField.id}"]`)!;
    pointerClick(cell);
    cell.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "v", ctrlKey: true, bubbles: true, cancelable: true }));
    const textPaste = pasteClipboardText(cell, "pasted\n**Markdown**");
    assert.equal(textPaste.defaultPrevented, true);
    await waitForCondition(() => ui.saved()?.records[0].values[textField.id] === "pasted\n**Markdown**", "text cell paste");
    assert.ok(ui.root.textContent?.includes("Paste 1 row"), "a direct cell paste should leave the internal row clipboard available");

    cell = ui.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${field.id}"]`)!;
    pointerClick(cell);
    cell.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "v", metaKey: true, bubbles: true, cancelable: true }));
    const numberPaste = pasteClipboardText(cell, " 12.5 \n");
    assert.equal(numberPaste.defaultPrevented, true);
    await waitForCondition(() => ui.saved()?.records[0].values[field.id] === 12.5, "number cell paste");

    cell = ui.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${field.id}"]`)!;
    const invalidPaste = pasteClipboardText(cell, "not a number");
    assert.equal(invalidPaste.defaultPrevented, true, "invalid numeric text should not fall through into the note");
    await settle();
    assert.equal(ui.saved()?.records[0].values[field.id], 12.5, "invalid numeric paste should leave the value unchanged");
  } finally { ui.cleanup(); }
});
test("[interaction] cell clipboard pastes every matching cell type without creating rows", async () => {
  const table = fixture();
  table.views.forEach((view) => { view.group = undefined; view.sort = undefined; });
  const source = table.records[0]; const target = table.records[1];
  const select = table.fields[1]; const multiselect = table.fields[2];
  const number: Field = { id: "clipboard-number", name: "Number", type: "number" };
  const link: Field = { id: "clipboard-link", name: "Link", type: "link" };
  const date: Field = { id: "clipboard-date", name: "Date", type: "date", dateFormat: "slash-date" };
  const checkbox: Field = { id: "clipboard-checkbox", name: "Checkbox", type: "checkbox" };
  const attachment: Field = { id: "clipboard-attachment", name: "Attachment", type: "attachment" };
  const status: Field = { id: "clipboard-status", name: "Legacy status", type: "status", options: [
    { id: "status-todo", label: "Todo", color: "gray" }, { id: "status-done", label: "Done", color: "green" },
  ] };
  table.fields.push(number, link, date, checkbox, attachment, status);
  source.values[number.id] = 12.5; target.values[number.id] = 2;
  source.values[link.id] = "[Project](https://example.com)"; target.values[link.id] = "https://other.example";
  source.values[date.id] = "2026-10-11"; target.values[date.id] = "2026-10-10";
  source.values[checkbox.id] = true; target.values[checkbox.id] = false;
  source.values[attachment.id] = ["folder/a.png", "folder/b.pdf"]; target.values[attachment.id] = ["old.png"];
  source.values[status.id] = "status-done"; target.values[status.id] = "status-todo";
  const firstOption = select.options![0].id; const secondOption = select.options![1].id;
  source.values[select.id] = firstOption; target.values[select.id] = secondOption;
  source.values[multiselect.id] = multiselect.options!.map((option) => option.id);
  target.values[multiselect.id] = [multiselect.options![0].id];
  source.values[table.fields[0].id] = "**Copied source**"; target.values[table.fields[0].id] = "Original target";

  const clipboard = navigator.clipboard;
  const originalWriteText = clipboard.writeText;
  const written: string[] = [];
  clipboard.writeText = async (value: string) => { written.push(value); };
  const ui = mount(table);
  try {
    // Leave a row clipboard available to ensure selected-cell paste takes precedence.
    click(byLabel(ui.root, "Select"));
    const rowCheck = byLabel(ui.root, "Select row") as HTMLInputElement;
    rowCheck.checked = true; rowCheck.dispatchEvent(new dom.window.Event("change"));
    ui.root.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true }));

    const fieldIds = [table.fields[0].id, select.id, multiselect.id, number.id, link.id, date.id, checkbox.id, attachment.id, status.id];
    for (const fieldId of fieldIds) {
      const sourceCell = ui.root.querySelector<HTMLTableCellElement>(`tr[data-row-id="${source.id}"] td[data-field-id="${fieldId}"]`)!;
      pointerClick(sourceCell);
      const copy = new dom.window.KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true });
      sourceCell.dispatchEvent(copy);
      assert.equal(copy.defaultPrevented, true, `${fieldId} should copy as a cell`);
      await settle();

      const targetCell = ui.root.querySelector<HTMLTableCellElement>(`tr[data-row-id="${target.id}"] td[data-field-id="${fieldId}"]`)!;
      pointerClick(targetCell);
      const pasteKey = new dom.window.KeyboardEvent("keydown", { key: "v", metaKey: true, bubbles: true, cancelable: true });
      targetCell.dispatchEvent(pasteKey);
      const paste = pasteClipboardText(targetCell, written.at(-1)!);
      assert.equal(paste.defaultPrevented, true, `${fieldId} should be handled by the selected cell`);
      await waitForCondition(() => {
        const savedRow = ui.saved()?.records.find((row) => row.id === target.id);
        return JSON.stringify(savedRow?.values[fieldId]) === JSON.stringify(source.values[fieldId]);
      }, `${fieldId} same-type cell paste`);
      assert.equal(ui.saved()?.records.length, 2, `${fieldId} paste must not create a row`);
    }

    const selectCell = ui.root.querySelector<HTMLTableCellElement>(`tr[data-row-id="${source.id}"] td[data-field-id="${select.id}"]`)!;
    pointerClick(selectCell);
    selectCell.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true }));
    await settle();
    const textTarget = ui.root.querySelector<HTMLTableCellElement>(`tr[data-row-id="${target.id}"] td[data-field-id="${table.fields[0].id}"]`)!;
    pointerClick(textTarget);
    const mismatch = pasteClipboardText(textTarget, written.at(-1)!);
    assert.equal(mismatch.defaultPrevented, true, "a copied select value should be consumed instead of falling through to row paste");
    await settle();
    assert.equal(ui.saved()?.records.length, 2, "a mismatched cell paste must not add a row");
    assert.equal(ui.saved()?.records.find((row) => row.id === target.id)?.values[table.fields[0].id], "**Copied source**", "a mismatched cell paste should leave the target unchanged");

    pointerClick(selectCell);
    selectCell.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true }));
    await settle();
    const otherTable = fixture();
    const otherSelect = otherTable.fields[1];
    otherSelect.options = otherSelect.options!.map((option, index) => ({ ...option, id: `other-option-${index}` }));
    otherTable.records.forEach((row) => { row.values[otherSelect.id] = otherSelect.options![1].id; });
    const otherUi = mount(otherTable);
    try {
      const otherTarget = otherUi.root.querySelector<HTMLTableCellElement>(`tr[data-row-id="${otherTable.records[1].id}"] td[data-field-id="${otherSelect.id}"]`)!;
      pointerClick(otherTarget);
      const crossTablePaste = pasteClipboardText(otherTarget, written.at(-1)!);
      assert.equal(crossTablePaste.defaultPrevented, true);
      await waitForCondition(() => otherUi.saved()?.records[1].values[otherSelect.id] === "other-option-0", "matching cell paste in another table");
      assert.equal(otherUi.saved()?.records.length, 2, "cross-table cell paste must not create a row");
    } finally { otherUi.cleanup(); }
  } finally {
    ui.cleanup();
    clipboard.writeText = originalWriteText;
  }
});
test("[interaction] Live Preview editor-surface paste replaces the selected text cell", async () => {
  const ui = mount();
  const host = document.createElement("div");
  host.setAttribute("contenteditable", "true"); host.tabIndex = 0;
  document.body.append(host); host.append(ui.root);
  try {
    const field = ui.table.fields[0];
    const cell = ui.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${field.id}"]`)!;
    pointerClick(cell);
    host.focus();
    document.getSelection()!.selectAllChildren(cell);
    let reachedEditorSurface = false;
    host.addEventListener("paste", () => { reachedEditorSurface = true; });
    const pasted = pasteClipboardText(host, "replacement from editor surface");
    assert.equal(pasted.defaultPrevented, true);
    assert.equal(reachedEditorSurface, false, "the outer editor must not process a paste owned by the selected cell");
    await waitForCondition(() => ui.saved()?.records[0].values[field.id] === "replacement from editor surface", "editor-surface text cell paste");
  } finally { ui.cleanup(); host.remove(); }
});
test("[interaction][storage] note caret owns copy paste and history even before stale cell selection clears", async () => {
  const ui = mountWithHistory();
  const host = document.createElement("div"); host.className = "cm-editor";
  const content = document.createElement("div"); content.setAttribute("contenteditable", "true"); content.tabIndex = 0;
  const paragraph = document.createElement("p"); paragraph.textContent = "Ordinary note text";
  document.body.append(host); host.append(content); content.append(ui.root, paragraph);
  const clipboard = navigator.clipboard; const original = clipboard.writeText;
  const written: string[] = []; clipboard.writeText = async (text: string) => { written.push(text); };
  try {
    // No active cell: the old fallback imported an extra row into every table.
    content.focus(); document.getSelection()!.selectAllChildren(paragraph);
    assert.equal(pasteClipboardText(content, "ordinary paste").defaultPrevented, false);
    pointerClick(ui.root.querySelector<HTMLTableCellElement>("td.tb-cell")!);
    // Test synchronously, before focusout's queued cleanup can hide the bug.
    content.focus(); document.getSelection()!.selectAllChildren(paragraph);
    const copy = new dom.window.KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true });
    content.dispatchEvent(copy);
    assert.equal(copy.defaultPrevented, false); assert.deepEqual(written, []);
    assert.equal(pasteClipboardText(content, "ordinary paste").defaultPrevented, false);
    for (const shiftKey of [false, true]) {
      const history = new dom.window.KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey, bubbles: true, cancelable: true });
      content.dispatchEvent(history); assert.equal(history.defaultPrevented, false);
    }
    assert.deepEqual(ui.calls, { undo: 0, redo: 0 });
    await settle(); assert.equal(ui.root.querySelectorAll(".tb-data-row").length, ui.table.records.length);
  } finally { clipboard.writeText = original; ui.cleanup(); host.remove(); }
});
test("[interaction] a paste belongs only to the focused table and stays native in its input and popup", async () => {
  const host = document.createElement("div"); host.className = "cm-editor";
  host.setAttribute("contenteditable", "true"); document.body.append(host);
  const first = mount(fixture(), false, host); const second = mount(fixture(), false, host);
  try {
    const target = second.root.querySelector<HTMLTableCellElement>("td.tb-cell")!; pointerClick(target);
    assert.equal(pasteClipboardText(target, "only second table").defaultPrevented, true);
    await settle(); assert.equal(first.saved(), null);
    assert.equal(second.saved()?.records[0].values[second.table.fields[0].id], "only second table");
    const input = openMarkdownEditor(second.root.querySelector<HTMLTableCellElement>("td.tb-cell")!);
    assert.equal(pasteClipboardText(input, "native input paste").defaultPrevented, false);
    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    pointerClick(second.root.querySelector<HTMLTableCellElement>("td.tb-cell")!);
    click(byLabel(second.root, "Filter"));
    assert.equal(pasteClipboardText(second.root, "popup must block table paste").defaultPrevented, false);
    assert.equal(second.saved()?.records.length, 2);
  } finally { first.cleanup(); second.cleanup(); host.remove(); }
});
test("[interaction][records] external paste does not reuse stale internal rows while matching internal paste still works", async () => {
  const clipboard = navigator.clipboard; const original = clipboard.writeText; let copied = "";
  clipboard.writeText = async (text: string) => { copied = text; };
  const ui = mount();
  try {
    click(byLabel(ui.root, "Select")); const check = byLabel(ui.root, "Select row") as HTMLInputElement;
    check.checked = true; check.dispatchEvent(new dom.window.Event("change"));
    ui.root.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true }));
    await settle(); assert.ok(copied);
    click(byLabel(ui.root, "Done")); ui.root.focus();
    const key = new dom.window.KeyboardEvent("keydown", { key: "v", metaKey: true, bubbles: true, cancelable: true });
    ui.root.dispatchEvent(key); assert.equal(key.defaultPrevented, false);
    pasteClipboardText(ui.root, "New external value"); await settle();
    assert.equal(ui.saved(), null);
    assert.ok(ui.root.textContent?.includes("Paste 1 row"));
    pasteClipboardText(ui.root, copied); await settle();
    assert.equal(ui.saved()?.records.length, 3);
    assert.equal(ui.saved()?.records.at(-1)?.values[ui.table.fields[0].id], ui.table.records[0].values[ui.table.fields[0].id]);
  } finally { ui.cleanup(); clipboard.writeText = original; }
});
test("[interaction][records] suspended external row paste neither appends nor overwrites selected records", async () => {
  for (const selectRows of [false, true]) {
    const ui = mount();
    try {
      if (selectRows) {
        click(byLabel(ui.root, "Select"));
        const check = byLabel(ui.root, "Select row") as HTMLInputElement;
        check.checked = true; check.dispatchEvent(new dom.window.Event("change"));
      }
      ui.root.focus();
      let bubbled = false;
      ui.root.addEventListener("paste", () => { bubbled = true; });
      const event = pasteClipboardText(ui.root, "External A\tNew option\nExternal B\tOther option");
      await settle();
      assert.equal(event.defaultPrevented, true);
      assert.equal(bubbled, false, "table-owned external data must not fall through into the note editor");
      assert.equal(ui.saved(), null, "no rows, values or options are written");
      assert.equal(document.querySelector(".tb-dialog"), null, "no external data input form is opened");
    } finally { ui.cleanup(); }
  }
});
test("[interaction][records] multiline paste into a link cell never creates or replaces rows", async () => {
  const table = fixture(); const field: Field = { id: "link-paste", name: "Link", type: "link" };
  table.fields.push(field); table.records.forEach((row) => { row.values[field.id] = "https://example.com"; });
  const ui = mount(table);
  try {
    const cell = ui.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${field.id}"]`)!;
    pointerClick(cell); pasteClipboardText(cell, "unrecognized\tmultiline\nrow data"); await settle();
    assert.equal(ui.saved(), null); assert.equal(ui.root.querySelectorAll(".tb-data-row").length, 2);
  } finally { ui.cleanup(); }
});
test("[interaction][storage] failed cross-table choice paste does not leak new options into later saves", async () => {
  const clipboard = navigator.clipboard; const original = clipboard.writeText; let copied = "";
  clipboard.writeText = async (text: string) => { copied = text; };
  const source = mount();
  const table = fixture(); delete table.views[0].sort; delete table.views[0].group;
  table.fields[1].options = [{ id: "existing", label: "Existing", color: "gray" }];
  table.records.forEach((row) => { row.values[table.fields[1].id] = "existing"; });
  const root = document.createElement("div"); document.body.append(root); let fail = true; let saved: TableDocument | undefined;
  const controller = renderTable({ app: {} } as any, JSON.stringify(table), { root, sourcePath: "choice-failure.md", save: async (_, next) => {
    if (fail) throw new Error("choice paste conflict"); saved = next; return JSON.stringify(next);
  } });
  try {
    const cell = source.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${source.table.fields[1].id}"]`)!;
    pointerClick(cell); cell.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true })); await settle();
    const target = root.querySelector<HTMLTableCellElement>(`td[data-field-id="${table.fields[1].id}"]`)!;
    pointerClick(target); pasteClipboardText(target, copied); await settle();
    assert.ok(notices.at(-1)?.includes("choice paste conflict")); fail = false;
    await editTextCell(root, "unrelated successful edit");
    assert.deepEqual(saved?.fields[1].options, table.fields[1].options);
    pointerClick(root.querySelector<HTMLTableCellElement>(`td[data-field-id="${table.fields[1].id}"]`)!);
    pasteClipboardText(document.activeElement!, copied); await settle();
    assert.equal(saved?.fields[1].options?.length, 2);
    assert.equal(saved?.records[0].values[table.fields[1].id], saved?.fields[1].options?.[1].id);
  } finally { source.cleanup(); controller.destroy(); root.remove(); clipboard.writeText = original; }
});
test("[interaction] Live Preview CodeMirror host routes copy and paste between selected cells", async () => {
  const table = fixture();
  const record = table.records[0];
  const sourceText: Field = { id: "live-preview-source-text", name: "Source text", type: "text" };
  const targetText: Field = { id: "live-preview-target-text", name: "Target text", type: "text" };
  const sourceLink: Field = { id: "live-preview-source", name: "Source link", type: "link" };
  const targetLink: Field = { id: "live-preview-target", name: "Target link", type: "link" };
  table.fields.push(sourceText, targetText, sourceLink, targetLink);
  record.values[sourceText.id] = "Copied text cell";
  record.values[targetText.id] = "Original text target";
  record.values[sourceLink.id] = "[Project](https://example.com)";
  record.values[targetLink.id] = "[Other](https://other.example)";

  const clipboard = navigator.clipboard;
  const originalWriteText = clipboard.writeText;
  const written: string[] = [];
  clipboard.writeText = async (value: string) => { written.push(value); };
  const cmEditor = document.createElement("div"); cmEditor.className = "cm-editor";
  const content = document.createElement("div"); content.className = "cm-content"; content.setAttribute("contenteditable", "true");
  const focusedLine = document.createElement("div"); focusedLine.className = "cm-line"; focusedLine.tabIndex = 0;
  const widget = document.createElement("div"); widget.className = "cm-embed-block";
  document.body.append(cmEditor); cmEditor.append(content); content.append(focusedLine, widget);
  const editorShortcut = (event: KeyboardEvent) => {
    if (event.key.toLowerCase() === "c" && event.metaKey) event.preventDefault();
  };
  const editorPaste = (event: ClipboardEvent) => event.preventDefault();
  dom.window.addEventListener("keydown", editorShortcut, true);
  dom.window.addEventListener("paste", editorPaste, true);
  const ui = mount(table, false, widget);
  try {
    focusedLine.focus();
    const selectCell = (field: Field) => {
      const cell = ui.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${field.id}"]`)!;
      const target = field.type === "link" ? cell.querySelector<HTMLAnchorElement>("a.tb-link-text")! : cell;
      if (target instanceof dom.window.HTMLAnchorElement) {
        target.onclick = null;
        target.addEventListener("click", (event) => event.preventDefault(), { once: true });
      }
      target.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
      target.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
      // Model Live Preview retaining the editor's contenteditable focus after the
      // table widget has recorded which cell was selected.
      focusedLine.focus();
      return cell;
    };

    const sourceTextCell = selectCell(sourceText);
    assert.ok(sourceTextCell.classList.contains("is-cell-active"), "the source text cell should be selected while CodeMirror keeps focus outside the widget");
    sourceTextCell.focus();
    const textCopy = new dom.window.KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true });
    sourceTextCell.dispatchEvent(textCopy);
    assert.equal(textCopy.defaultPrevented, true);
    await settle();
    assert.equal(written.at(-1), "Copied text cell", "text cell copy should work when its target also has CodeMirror's contenteditable ancestor");

    const targetTextCell = selectCell(targetText);
    targetTextCell.focus();
    const textPaste = pasteClipboardText(targetTextCell, written.at(-1)!);
    assert.equal(textPaste.defaultPrevented, true);
    await waitForCondition(() => ui.saved()?.records[0].values[targetText.id] === record.values[sourceText.id], "CodeMirror-ancestor text cell paste");

    const sourceLinkCell = selectCell(sourceLink);
    assert.ok(sourceLinkCell.classList.contains("is-cell-active"), "the source link cell should be selected while CodeMirror keeps focus outside the widget");
    sourceLinkCell.focus();

    const copy = new dom.window.KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true });
    sourceLinkCell.dispatchEvent(copy);
    assert.equal(copy.defaultPrevented, true);
    await settle();
    assert.equal(written.at(-1), "[Project](https://example.com)", "link cell copy should retain the field's Markdown source format when its target has CodeMirror's contenteditable ancestor");

    const targetLinkCell = selectCell(targetLink);
    targetLinkCell.focus();
    let reachedEditorPaste = false;
    cmEditor.addEventListener("paste", () => { reachedEditorPaste = true; }, { once: true });
    const pasted = pasteClipboardText(targetLinkCell, written.at(-1)!);
    assert.equal(pasted.defaultPrevented, true);
    assert.equal(reachedEditorPaste, false, "the outer editor must not process a paste owned by the selected link cell");
    await waitForCondition(() => ui.saved()?.records[0].values[targetLink.id] === record.values[sourceLink.id], "CodeMirror-surface link cell paste");
  } finally {
    ui.cleanup(); cmEditor.remove();
    dom.window.removeEventListener("keydown", editorShortcut, true); dom.window.removeEventListener("paste", editorPaste, true);
    clipboard.writeText = originalWriteText;
  }
});
test("[interaction] Cmd/Ctrl+C copies the focused cell using row clipboard text for every field type", async () => {
  const table = fixture();
  table.views.forEach((view) => { view.group = undefined; view.sort = undefined; });
  const record = table.records[0];
  const [text, select, multiselect] = table.fields;
  record.values[text.id] = "**Markdown source**";
  const selectedOption = select.options!.find((option) => option.id === String(record.values[select.id]))!;
  record.values[multiselect.id] = multiselect.options!.map((option) => option.id);

  const number: Field = { id: "copy-number", name: "Number", type: "number" };
  const link: Field = { id: "copy-link", name: "Link", type: "link" };
  const date: Field = { id: "copy-date", name: "Date", type: "date", dateFormat: "slash-date" };
  const checkbox: Field = { id: "copy-checkbox", name: "Checkbox", type: "checkbox" };
  const attachment: Field = { id: "copy-attachment", name: "Attachment", type: "attachment" };
  table.fields.push(number, link, date, checkbox, attachment);
  record.values[number.id] = 12.5;
  record.values[link.id] = "[Project](https://example.com)";
  record.values[date.id] = "2026-10-11";
  record.values[checkbox.id] = true;
  record.values[attachment.id] = ["folder/file.png"];

  const copies = [
    { fieldId: text.id, expected: "**Markdown source**" },
    { fieldId: select.id, expected: selectedOption.label },
    { fieldId: multiselect.id, expected: multiselect.options!.map((option) => option.label).join(", ") },
    { fieldId: number.id, expected: "12.5" },
    { fieldId: link.id, expected: "[Project](https://example.com)" },
    { fieldId: date.id, expected: "2026/10/11" },
    { fieldId: checkbox.id, expected: "TRUE" },
    { fieldId: attachment.id, expected: '["folder/file.png"]' },
  ];
  const clipboard = navigator.clipboard;
  const originalWriteText = clipboard.writeText;
  const written: string[] = [];
  clipboard.writeText = async (value: string) => { written.push(value); };
  const ui = mount(table);
  try {
    for (const [index, copy] of copies.entries()) {
      const cell = ui.root.querySelector<HTMLTableCellElement>(`tr[data-row-id="${record.id}"] td[data-field-id="${copy.fieldId}"]`)!;
      pointerClick(cell);
      const event = new dom.window.KeyboardEvent("keydown", {
        key: "c", metaKey: index % 2 === 0, ctrlKey: index % 2 === 1, bubbles: true, cancelable: true,
      });
      cell.dispatchEvent(event);
      assert.equal(event.defaultPrevented, true, `${copy.fieldId} should prevent the browser's default copy`);
      await settle();
      assert.equal(written.at(-1), copy.expected, `${copy.fieldId} should use the existing field copy format`);
    }
  } finally {
    ui.cleanup();
    clipboard.writeText = originalWriteText;
  }
});
test("[interaction] selected-cell copy falls back when the async clipboard write is rejected", async () => {
  const clipboard = navigator.clipboard;
  const originalWriteText = clipboard.writeText;
  const execDescriptor = Object.getOwnPropertyDescriptor(document, "execCommand");
  const copied: string[] = [];
  clipboard.writeText = async () => { throw new Error("clipboard write denied"); };
  Object.defineProperty(document, "execCommand", {
    configurable: true,
    value: (command: string) => {
      assert.equal(command, "copy");
      copied.push(document.querySelector<HTMLTextAreaElement>("textarea.tb-clipboard-helper")?.value ?? "");
      return true;
    },
  });
  const ui = mount();
  try {
    const cell = ui.root.querySelector<HTMLTableCellElement>("td.tb-cell")!;
    pointerClick(cell);
    const event = new dom.window.KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true });
    cell.dispatchEvent(event);
    assert.equal(event.defaultPrevented, true);
    await settle();
    assert.equal(copied.at(-1), String(ui.table.records[0].values[ui.table.fields[0].id]));
  } finally {
    ui.cleanup();
    clipboard.writeText = originalWriteText;
    if (execDescriptor) Object.defineProperty(document, "execCommand", execDescriptor);
    else delete (document as Document & { execCommand?: (command: string) => boolean }).execCommand;
  }
});
test("[interaction] focused-cell copy takes priority over row copy without replacing the internal row clipboard", async () => {
  const clipboard = navigator.clipboard;
  const originalWriteText = clipboard.writeText;
  const written: string[] = [];
  clipboard.writeText = async (value: string) => { written.push(value); };
  const ui = mount();
  try {
    click(byLabel(ui.root, "Select"));
    const rowCheck = byLabel(ui.root, "Select row") as HTMLInputElement;
    rowCheck.checked = true;
    rowCheck.dispatchEvent(new dom.window.Event("change"));

    const rowCopy = new dom.window.KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true });
    ui.root.dispatchEvent(rowCopy);
    assert.equal(rowCopy.defaultPrevented, true);
    await settle();
    assert.ok(written.at(-1)?.includes("\t"), "with row selection and no focused cell, Cmd+C should copy rows as TSV");
    assert.ok(ui.root.textContent?.includes("Paste 1 row"));

    const selectedRow = ui.root.querySelector<HTMLTableRowElement>(".tb-data-row.is-selected")!;
    const cell = selectedRow.querySelector<HTMLTableCellElement>("td.tb-cell")!;
    const rowId = selectedRow.dataset.rowId!;
    const fieldId = cell.dataset.fieldId!;
    const record = ui.table.records.find((item) => item.id === rowId)!;
    const field = ui.table.fields.find((item) => item.id === fieldId)!;
    pointerClick(cell);
    const cellCopy = new dom.window.KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true });
    cell.dispatchEvent(cellCopy);
    assert.equal(cellCopy.defaultPrevented, true);
    await settle();
    assert.equal(written.at(-1), String(record.values[field.id]), "a focused cell should win even while rows are selected");
    assert.ok(ui.root.textContent?.includes("Paste 1 row"), "cell copy should leave the internal row clipboard available");
  } finally {
    ui.cleanup();
    clipboard.writeText = originalWriteText;
  }
});
test("[interaction] cell copy is not intercepted in an editor, with a popup, or after focus leaves the cell", () => {
  const clipboard = navigator.clipboard;
  const originalWriteText = clipboard.writeText;
  const written: string[] = [];
  clipboard.writeText = async (value: string) => { written.push(value); };
  const ui = mount();
  let outside: HTMLButtonElement | null = null;
  let popup: HTMLDivElement | null = null;
  try {
    const cell = ui.root.querySelector<HTMLTableCellElement>("td.tb-cell")!;
    const input = openMarkdownEditor(cell);
    const inputCopy = new dom.window.KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(inputCopy);
    assert.equal(inputCopy.defaultPrevented, false, "input copy should remain available to the editor");
    assert.equal(written.length, 0);

    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    const focusedCell = ui.root.querySelector<HTMLTableCellElement>("td.tb-cell")!;
    pointerClick(focusedCell);
    popup = document.createElement("div"); popup.className = "tb-dialog"; document.body.append(popup);
    const popupCopy = new dom.window.KeyboardEvent("keydown", { key: "c", ctrlKey: true, bubbles: true, cancelable: true });
    focusedCell.dispatchEvent(popupCopy);
    assert.equal(popupCopy.defaultPrevented, false, "an open popup should suppress cell copy");
    assert.equal(written.length, 0);
    popup.remove(); popup = null;

    outside = document.createElement("button"); document.body.append(outside); outside.focus();
    const outsideCopy = new dom.window.KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true, cancelable: true });
    ui.root.dispatchEvent(outsideCopy);
    assert.equal(outsideCopy.defaultPrevented, false, "focus outside the active cell should not trigger cell copy");
    assert.equal(written.length, 0);
  } finally {
    popup?.remove();
    outside?.remove();
    ui.cleanup();
    clipboard.writeText = originalWriteText;
  }
});
test("[markdown][interaction] rendered Markdown links open on the first click and enter source editing on the next", () => {
  const ui = mount();
  try {
    const cell = ui.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${ui.table.fields[0].id}"]`)!;
    const preview = cell.querySelector<HTMLElement>(".tb-markdown-content")!;
    const anchor = document.createElement("a"); anchor.href = "https://example.com"; anchor.textContent = anchor.href;
    preview.replaceChildren(anchor);
    let opened = 0;
    anchor.addEventListener("click", (event) => { event.preventDefault(); opened++; });
    const clickAnchor = (detail: number) => {
      anchor.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
      anchor.focus();
      anchor.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true, detail }));
    };

    clickAnchor(1);
    assert.equal(opened, 1, "the first click should retain normal link activation");
    assert.ok(cell.classList.contains("is-cell-active"));
    assert.equal(cell.querySelector("textarea.tb-markdown-editor"), null);

    clickAnchor(2);
    assert.equal(opened, 1, "the editing click should not activate the link again");
    assert.ok(cell.querySelector("textarea.tb-markdown-editor"), "a repeated click on rendered Markdown link text should enter editing");
    const input = cell.querySelector<HTMLTextAreaElement>("textarea.tb-markdown-editor")!;
    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(ui.saved(), null, "cancelling the test edit must not save");
  } finally { ui.cleanup(); }
});
test("[markdown][interaction] double-clicking rendered Markdown text enters source editing", () => {
  const ui = mount();
  try {
    const cell = ui.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${ui.table.fields[0].id}"]`)!;
    const preview = cell.querySelector<HTMLElement>(".tb-markdown-content")!;
    const anchor = document.createElement("a"); anchor.href = "https://example.com"; anchor.textContent = anchor.href;
    preview.replaceChildren(anchor);

    const doubleClick = new dom.window.MouseEvent("dblclick", { bubbles: true, cancelable: true, detail: 2 });
    anchor.dispatchEvent(doubleClick);
    assert.equal(doubleClick.defaultPrevented, true, "double-click should be consumed by text-cell editing");
    assert.ok(cell.querySelector("textarea.tb-markdown-editor"), "double-clicking rendered link text should enter editing even without a preceding cell click");
    const input = cell.querySelector<HTMLTextAreaElement>("textarea.tb-markdown-editor")!;
    input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true }));
    assert.equal(ui.saved(), null, "cancelling the test edit must not save");
  } finally { ui.cleanup(); }
});
test("[markdown][interaction] Markdown source editor confirms with Enter, keeps Shift+Enter multiline input, and cancels with Escape", async () => {
  const table = fixture(); const ui = mount(table); const fieldId = table.fields[0].id; const rowId = table.records[0].id;
  const openEditor = () => {
    const cell = ui.root.querySelector<HTMLTableCellElement>(`.tb-data-row[data-row-id="${rowId}"] td[data-field-id="${fieldId}"]`)!;
    return { cell, input: openMarkdownEditor(cell) };
  };
  try {
    const first = openEditor(); first.input.value = "Saved with Enter";
    const enter = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    first.input.dispatchEvent(enter);
    assert.equal(enter.defaultPrevented, true);
    await waitForCondition(() => !first.cell.isConnected && ui.saved()?.records[0].values[fieldId] === "Saved with Enter", "Enter Markdown save");

    const second = openEditor(); second.input.value = "First line";
    const shiftEnter = new dom.window.KeyboardEvent("keydown", { key: "Enter", shiftKey: true, bubbles: true, cancelable: true });
    second.input.dispatchEvent(shiftEnter);
    assert.equal(shiftEnter.defaultPrevented, false, "Shift+Enter should be left to the textarea so it can insert a line break");
    assert.equal(second.input.isConnected, true, "Shift+Enter should keep the editor open");
    // jsdom does not perform the browser's default textarea insertion for KeyboardEvent.
    second.input.value = "First line\nSecond line";
    const enterAfterLineBreak = new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true });
    second.input.dispatchEvent(enterAfterLineBreak);
    assert.equal(enterAfterLineBreak.defaultPrevented, true);
    await waitForCondition(() => !second.cell.isConnected && ui.saved()?.records[0].values[fieldId] === "First line\nSecond line", "Enter Markdown save after a line break");

    const third = openEditor(); third.input.value = "Discarded with Escape";
    const composingEnter = new dom.window.KeyboardEvent("keydown", { key: "Enter", metaKey: true, isComposing: true, bubbles: true, cancelable: true });
    third.input.dispatchEvent(composingEnter);
    assert.equal(composingEnter.defaultPrevented, false); assert.equal(third.input.isConnected, true);
    const imeEscape = new dom.window.KeyboardEvent("keydown", { key: "Escape", keyCode: 229, bubbles: true, cancelable: true });
    third.input.dispatchEvent(imeEscape);
    assert.equal(imeEscape.defaultPrevented, false); assert.equal(third.input.isConnected, true);
    const escape = new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
    third.input.dispatchEvent(escape);
    assert.equal(escape.defaultPrevented, true);
    assert.equal(third.input.isConnected, false);
    assert.equal(ui.saved()?.records[0].values[fieldId], "First line\nSecond line");

    for (const [modifier, label] of [[{ metaKey: true }, "Cmd+Enter"], [{ ctrlKey: true }, "Ctrl+Enter"]] as const) {
      const compatible = openEditor(); compatible.input.value = `Saved with ${label}`;
      const modifiedEnter = new dom.window.KeyboardEvent("keydown", { key: "Enter", ...modifier, bubbles: true, cancelable: true });
      compatible.input.dispatchEvent(modifiedEnter);
      assert.equal(modifiedEnter.defaultPrevented, true);
      await waitForCondition(() => !compatible.cell.isConnected && ui.saved()?.records[0].values[fieldId] === `Saved with ${label}`, label);
    }
  } finally { ui.cleanup(); }
});
test("[markdown][interaction] Markdown editor listeners are disposed by redraw and destroy without saving drafts", () => {
  const target = dom.window as any;
  const originalAdd = target.addEventListener;
  const originalRemove = target.removeEventListener;
  const activeListeners = new Map<string, Set<EventListenerOrEventListenerObject>>();
  const listenerCount = () => [...activeListeners.values()].reduce((count, listeners) => count + listeners.size, 0);
  target.addEventListener = function(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | AddEventListenerOptions) {
    if ((type === "keydown" || type === "keyup") && options === true) {
      const listeners = activeListeners.get(type) ?? new Set<EventListenerOrEventListenerObject>();
      listeners.add(listener); activeListeners.set(type, listeners);
    }
    return originalAdd.call(this, type, listener, options);
  };
  target.removeEventListener = function(type: string, listener: EventListenerOrEventListenerObject, options?: boolean | EventListenerOptions) {
    if ((type === "keydown" || type === "keyup") && options === true) activeListeners.get(type)?.delete(listener);
    return originalRemove.call(this, type, listener, options);
  };
  const baseline = listenerCount(); const table = fixture(); const ui = mount(table); const mountedBaseline = listenerCount(); const rowId = table.records[0].id; const fieldId = table.fields[0].id;
  const openEditor = () => {
    const cell = ui.root.querySelector<HTMLTableCellElement>(`.tb-data-row[data-row-id="${rowId}"] td[data-field-id="${fieldId}"]`)!;
    return openMarkdownEditor(cell);
  };
  try {
    const redrawnEditor = openEditor(); redrawnEditor.value = "Discard on redraw";
    assert.equal(listenerCount(), mountedBaseline + 2);
    const selectButton = [...ui.root.querySelectorAll<HTMLButtonElement>(".tb-toolbar button")].find((button) => button.textContent?.trim() === t("Select"))!;
    click(selectButton);
    assert.equal(redrawnEditor.isConnected, false);
    assert.equal(listenerCount(), mountedBaseline);
    assert.equal(ui.saved(), null);

    const destroyedEditor = openEditor(); destroyedEditor.value = "Discard on destroy";
    assert.equal(listenerCount(), mountedBaseline + 2);
    ui.controller.destroy();
    assert.equal(destroyedEditor.isConnected, false);
    assert.equal(listenerCount(), baseline);
    const shortcut = new dom.window.KeyboardEvent("keydown", { key: "Enter", metaKey: true, bubbles: true, cancelable: true });
    dom.window.dispatchEvent(shortcut);
    assert.equal(shortcut.defaultPrevented, false);
    assert.equal(ui.saved(), null);
  } finally {
    ui.controller.destroy(); ui.root.remove();
    target.addEventListener = originalAdd; target.removeEventListener = originalRemove;
  }
});
test("[interaction] link text opens valid URLs directly; blank space and editing do not navigate", async () => {
  const originalOpen = window.open; const opened: string[] = [];
  window.open = (url) => { opened.push(String(url)); return null; };
  try {
    for (const value of ['[网站](https://example.com "说明")', "example.org/path", "javascript:alert(1)", ""]) {
      const table = fixture(); table.fields.push({ id: "url", name: "网址", type: "link" }); table.records[0].values.url = value;
      const ui = mount(table); const cell = ui.root.querySelector('td[data-field-id="url"]')!;
      const before = opened.length; click(cell); assert.equal(opened.length, before);
      const anchor = cell.querySelector<HTMLAnchorElement>("a.tb-link-text"); const parsed = parseWebLink(value);
      assert.equal(!!anchor, !!parsed.href); assert.equal(cell.querySelectorAll('[aria-label="Open link"]').length, 0);
      if (anchor) {
        assert.equal(anchor.href, parsed.href); assert.equal(anchor.textContent, parsed.markdown ? parsed.label : value);
        anchor.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, cancelable: true }));
        await new Promise((resolve) => window.setTimeout(resolve, 360));
        assert.equal(opened.at(-1), parsed.href); assert.ok(cell.classList.contains("is-cell-active"));
      }
      const afterLink = opened.length; click(byLabel(cell, "Edit link")); assert.equal(opened.length, afterLink);
      const editor = document.querySelector<HTMLElement>(".tb-link-editor-popover")!;
      const fields = linkEditorFields(value);
      assert.equal(editor.querySelector<HTMLInputElement>(".tb-link-editor-text")!.value, fields.text);
      assert.equal(editor.querySelector<HTMLInputElement>(".tb-link-editor-url")!.value, fields.url);
      click(byEditorName(editor, "Cancel"));
      assert.equal(cell.querySelectorAll('[aria-label="Open link"]').length, 0); ui.cleanup();
    }
    assert.deepEqual(opened, ["https://example.com/", "https://example.org/path"]);
  } finally { window.open = originalOpen; }
});
test("[fields] option editor uses compact color controls and preserves stable IDs across rename", async () => {
  const ui = mount(); const pill = ui.root.querySelector(".tb-cell .tb-pill")!; click(pill); click(pill.closest("td")!.querySelector(".tb-cell-action")!);
  shownMenus.at(-1)!.items.find((item) => item.title === "Edit options…")!.action!({});
  assert.equal(document.querySelectorAll(".tb-option-color-trigger").length, 2);
  assert.equal(document.querySelectorAll(".tb-swatch").length, 0);
  const input = document.querySelector<HTMLInputElement>(".tb-option-name")!; input.value = "Desktop"; input.dispatchEvent(new dom.window.Event("input"));
  click(byEditorName(document.body, "Save")); await settle();
  assert.equal(ui.saved()?.fields[1].options![0].label, "Desktop"); assert.equal(ui.saved()?.records[0].values[ui.table.fields[1].id], ui.table.fields[1].options![0].id); ui.cleanup();
});
test("[fields] column editor reorders select and multi-select options by desktop dragging", async () => {
  const verifyHandle = (editor: HTMLElement, optionId: string, optionLabel: string) => {
    const handle = editor.querySelector<HTMLButtonElement>(`.tb-option-drag-handle[data-option-id="${optionId}"]`)!;
    assert.equal(handle.draggable, true);
    assert.equal(handle.getAttribute("aria-label"), null); assert.equal(handle.getAttribute("title"), null);
    const labelId = handle.getAttribute("aria-labelledby")!;
    assert.equal(document.getElementById(labelId)?.textContent, t("Drag {name} to reorder", { name: optionLabel }));
    assert.equal(handle.closest(".tb-option-row")?.lastElementChild, handle);
    assert.equal(handle.closest(".tb-option-row")?.querySelector(".tb-icon-button:not(.tb-option-drag-handle)")?.nextElementSibling, handle);
    return handle;
  };
  const reorder = (editor: HTMLElement, sourceId: string, targetId: string, after: boolean) => {
    const handle = editor.querySelector<HTMLButtonElement>(`.tb-option-drag-handle[data-option-id="${sourceId}"]`)!;
    const target = [...editor.querySelectorAll<HTMLElement>(".tb-option-row")].find((row) => row.querySelector(`.tb-option-color-trigger[data-option-id="${targetId}"]`))!;
    Object.defineProperty(target, "getBoundingClientRect", { configurable: true, value: () => ({ top: 0, bottom: 20, left: 0, right: 100, width: 100, height: 20, x: 0, y: 0, toJSON: () => ({}) }) });
    const transfer = dragDataTransfer();
    dispatchDrag(handle, "dragstart", transfer);
    const dragOver = dispatchDrag(target, "dragover", transfer, after ? 15 : 5);
    assert.equal(dragOver.defaultPrevented, true);
    assert.ok(target.classList.contains(after ? "tb-drop-after" : "tb-drop-before"));
    const drop = dispatchDrag(target, "drop", transfer, after ? 15 : 5);
    assert.equal(drop.defaultPrevented, true);
    dispatchDrag(handle, "dragend", transfer);
  };

  const table = fixture(); const select = table.fields[1];
  select.options!.push({ id: "mobile", label: "Mobile", color: "red" }, { id: "other", label: "Other", color: "purple" });
  const ui = mount(table);
  const selectIds = select.options!.map((option) => option.id);
  const selectRecords = ui.table.records.map((row) => row.values[select.id]);
  click(ui.root.querySelectorAll(".tb-header-menu")[1]);
  shownMenus.at(-1)!.items.find((item) => item.title === "Edit column")!.action!({});
  let editor = document.querySelector<HTMLElement>(".tb-column-editor")!;
  verifyHandle(editor, selectIds[0], select.options![0].label);
  reorder(editor, selectIds[3], selectIds[0], false);
  editor = document.querySelector<HTMLElement>(".tb-column-editor")!;
  assert.deepEqual([...editor.querySelectorAll<HTMLButtonElement>(".tb-option-drag-handle")].map((handle) => handle.dataset.optionId), [selectIds[3], selectIds[0], selectIds[1], selectIds[2]]);
  reorder(editor, selectIds[3], selectIds[2], true);
  editor = document.querySelector<HTMLElement>(".tb-column-editor")!;
  assert.deepEqual([...editor.querySelectorAll<HTMLButtonElement>(".tb-option-drag-handle")].map((handle) => handle.dataset.optionId), selectIds);
  reorder(editor, selectIds[1], selectIds[2], true);
  click(byEditorName(document.body, "Save")); await settle();
  const savedSelect = ui.saved()!;
  assert.deepEqual(savedSelect.fields[1].options!.map((option) => option.id), [selectIds[0], selectIds[2], selectIds[1], selectIds[3]]);
  assert.deepEqual(savedSelect.fields[1].options!.slice().sort((a, b) => a.id.localeCompare(b.id)), select.options!.slice().sort((a, b) => a.id.localeCompare(b.id)));
  assert.deepEqual(savedSelect.records.map((row) => row.values[select.id]), selectRecords);

  const multi = ui.table.fields[2];
  const multiIds = multi.options!.map((option) => option.id);
  const multiSelections = ui.table.records.map((row) => [...row.values[multi.id] as string[]].sort());
  click(ui.root.querySelectorAll(".tb-header-menu")[2]);
  shownMenus.at(-1)!.items.find((item) => item.title === "Edit column")!.action!({});
  editor = document.querySelector<HTMLElement>(".tb-column-editor")!;
  verifyHandle(editor, multiIds[0], multi.options![0].label);
  reorder(editor, multiIds[0], multiIds[1], true);
  click(byEditorName(document.body, "Save")); await settle();
  const savedMulti = ui.saved()!;
  assert.deepEqual(savedMulti.fields[2].options!.map((option) => option.id), [multiIds[1], multiIds[0]]);
  assert.deepEqual(savedMulti.records.map((row) => [...row.values[multi.id] as string[]].sort()), multiSelections);
  assert.ok(savedMulti.records.every((row) => JSON.stringify(row.values[multi.id]) === JSON.stringify(multiIds.slice().reverse())));
  ui.cleanup();
});
test("[fields] canceling option reorder discards the draft order", async () => {
  const ui = mount(); const originalIds = ui.table.fields[1].options!.map((option) => option.id);
  click(ui.root.querySelectorAll(".tb-header-menu")[1]);
  shownMenus.at(-1)!.items.find((item) => item.title === "Edit column")!.action!({});
  const editor = document.querySelector<HTMLElement>(".tb-column-editor")!;
  const handle = editor.querySelector<HTMLButtonElement>(".tb-option-drag-handle")!;
  const target = editor.querySelectorAll<HTMLElement>(".tb-option-row")[1];
  Object.defineProperty(target, "getBoundingClientRect", { configurable: true, value: () => ({ top: 0, bottom: 20 }) });
  const transfer = dragDataTransfer(); dispatchDrag(handle, "dragstart", transfer); dispatchDrag(target, "dragover", transfer, 15); dispatchDrag(target, "drop", transfer, 15);
  assert.equal(ui.saved(), null);
  assert.deepEqual(ui.table.fields[1].options!.map((option) => option.id), originalIds);
  click(byEditorName(document.body, "Cancel")); await settle();
  assert.equal(ui.saved(), null); ui.cleanup();
});
test("[fields] column type picker opens on hover and returns to the edit form after selection", async () => {
  const ui = mount(); click(ui.root.querySelectorAll(".tb-header-menu")[1]);
  shownMenus.at(-1)!.items.find((item) => item.title === "Edit column")!.action!({});
  const trigger = document.querySelector<HTMLElement>(".tb-field-type-selector")!;
  const editor = trigger.closest<HTMLElement>(".tb-column-editor")!;
  assert.ok(editor.closest(".modal.tb-column-editor-modal"));
  assert.equal(editor.querySelector("[aria-label], [title]"), null);
  const optionInput = editor.querySelector<HTMLInputElement>(".tb-option-name")!;
  const optionInputLabel = optionInput.getAttribute("aria-labelledby");
  assert.ok(optionInputLabel && document.getElementById(optionInputLabel)?.textContent === t("Option name"));
  trigger.dispatchEvent(new dom.window.Event("pointerenter"));
  await new Promise((resolve) => setTimeout(resolve, 150));
  const picker = document.querySelector<HTMLElement>(".tb-column-type-picker")!;
  assert.equal(picker.querySelectorAll(".tb-field-type-option").length, FIELD_TYPES.length);
  assert.deepEqual([...picker.querySelectorAll<HTMLElement>(".tb-field-type-option")].map((item) => item.querySelector(".tb-type-icon + span")?.textContent), ["Text", "Number", "Select", "Multi-select", "Date", "Checkbox", "URL", "Attachments"]);
  assert.equal(trigger.hasAttribute("aria-label"), false);
  assert.equal(picker.querySelector("[aria-label], [title]"), null);
  assert.equal(picker.getAttribute("aria-labelledby"), trigger.id);
  trigger.dispatchEvent(new dom.window.Event("pointerleave"));
  picker.dispatchEvent(new dom.window.Event("pointerenter"));
  await new Promise((resolve) => setTimeout(resolve, 230));
  assert.ok(document.querySelector(".tb-column-type-picker"));
  const multi = [...picker.querySelectorAll<HTMLElement>(".tb-field-type-option")].find((item) => item.textContent?.includes(t("Multi-select")))!;
  click(multi);
  assert.equal(document.querySelector(".tb-column-type-picker"), null);
  assert.ok(document.querySelector(".tb-field-type-selector")!.textContent?.includes(t("Multi-select")));
  assert.ok(document.querySelector(".tb-column-options-heading")); assert.equal(ui.saved(), null);
  click(byEditorName(document.body, "Cancel")); ui.cleanup();
});
test("[fields] column option colors open in a compact picker and save the selected color", async () => {
  const ui = mount();
  click(ui.root.querySelectorAll(".tb-header-menu")[1]);
  shownMenus.at(-1)!.items.find((item) => item.title === "Edit column")!.action!({});
  const field = ui.table.fields[1]; const option = field.options![0];
  const findTrigger = () => [...document.querySelectorAll<HTMLButtonElement>(".tb-option-color-trigger")].find((button) => button.dataset.optionId === option.id);
  const trigger = findTrigger()!;
  assert.equal(document.querySelector(".tb-option-color-picker"), null);
  assert.equal(document.querySelectorAll(".tb-column-editor .tb-swatch").length, 0);
  assert.equal(trigger.getAttribute("aria-label"), null);
  click(trigger);
  const picker = document.querySelector<HTMLElement>(".tb-option-color-picker")!;
  assert.equal(picker.querySelectorAll(".tb-option-color-choice").length, OPTION_COLORS.length);
  assert.equal(picker.querySelector("[aria-label], [title]"), null);
  picker.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  assert.equal(document.querySelector(".tb-option-color-picker"), null);
  assert.equal(trigger.getAttribute("aria-expanded"), "false");
  click(trigger);
  const reopenedPicker = document.querySelector<HTMLElement>(".tb-option-color-picker")!;
  click(reopenedPicker.querySelector<HTMLButtonElement>('[data-color="purple"]')!);
  assert.equal(document.querySelector(".tb-option-color-picker"), null);
  const updatedTrigger = findTrigger()!;
  assert.ok(updatedTrigger.classList.contains("tb-color-purple"));
  assert.equal(updatedTrigger.querySelector(".tb-option-color-preview, .svg-icon"), null);
  click(byEditorName(document.body, "Save")); await settle();
  const saved = ui.saved()!;
  assert.equal(saved.fields[1].options!.find((item) => item.id === option.id)!.color, "purple");
  assert.equal(saved.fields[1].options!.find((item) => item.id === option.id)!.label, option.label);
  ui.cleanup();
});
test("[fields] column editor adds blank options on demand and ignores untouched pending rows", async () => {
  const ui = mount();
  click(ui.root.querySelectorAll(".tb-header-menu")[1]);
  shownMenus.at(-1)!.items.find((item) => item.title === "Edit column")!.action!({});
  const editor = document.querySelector<HTMLElement>(".tb-column-editor")!;
  assert.ok(editor.closest(".modal.tb-column-editor-modal"));
  assert.equal(editor.querySelector(".tb-option-add"), null);
  const originalLabels = ui.table.fields[1].options!.map((option) => option.label);
  click(byEditorName(editor, "Add option"));
  let pendingInputs = [...editor.querySelectorAll<HTMLInputElement>(".tb-option-name")];
  assert.equal(document.activeElement, pendingInputs.at(-1));
  assert.equal(pendingInputs.at(-1)!.value, "");
  click(byEditorName(editor, "Add option"));
  pendingInputs = [...editor.querySelectorAll<HTMLInputElement>(".tb-option-name")];
  const newInput = pendingInputs.at(-1)!;
  assert.equal(document.activeElement, newInput);
  newInput.value = "New label";
  newInput.dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  click(byEditorName(editor, "Save"));
  await settle();
  const savedOptions = ui.saved()!.fields[1].options!;
  assert.deepEqual(savedOptions.map((option) => option.label), [...originalLabels, "New label"]);
  ui.cleanup();
});
test("[fields] added multi-select options cycle through the color palette in order", () => {
  const table = fixture(); table.fields[2].options = [];
  const ui = mount(table);
  click(ui.root.querySelectorAll(".tb-header-menu")[2]);
  shownMenus.at(-1)!.items.find((item) => item.title === "Edit column")!.action!({});
  const editor = document.querySelector<HTMLElement>(".tb-column-editor")!;
  const addedCount = OPTION_COLORS.length + 2;
  for (let index = 0; index < addedCount; index++) click(byEditorName(editor, "Add option"));
  const colors = [...editor.querySelectorAll<HTMLButtonElement>(".tb-option-color-trigger")]
    .map((trigger) => OPTION_COLORS.find((color) => trigger.classList.contains(`tb-color-${color}`)));
  assert.deepEqual(colors, Array.from({ length: addedCount }, (_, index) => OPTION_COLORS[index % OPTION_COLORS.length]));
  click(byEditorName(editor, "Cancel"));
  ui.cleanup();
});
test("[fields] multi-select column editor saves distinct option names from the visible inputs", async () => {
  const ui = mount();
  click(ui.root.querySelectorAll(".tb-header-menu")[2]);
  shownMenus.at(-1)!.items.find((item) => item.title === "Edit column")!.action!({});
  const editor = document.querySelector<HTMLElement>(".tb-column-editor")!;
  click(byEditorName(editor, "Add option"));
  click(byEditorName(editor, "Add option"));
  const inputs = [...editor.querySelectorAll<HTMLInputElement>(".tb-option-name")];
  inputs.at(-2)!.value = "1";
  inputs.at(-1)!.value = "2";
  const noticeCount = notices.length;
  click(byEditorName(editor, "Save"));
  await settle();
  assert.equal(notices.length, noticeCount);
  assert.deepEqual(ui.saved()!.fields[2].options!.map((option) => option.label), ["A", "B", "1", "2"]);
  ui.cleanup();
});
test("[fields] column editor reports empty and duplicate option names separately", () => {
  const ui = mount();
  click(ui.root.querySelectorAll(".tb-header-menu")[1]);
  shownMenus.at(-1)!.items.find((item) => item.title === "Edit column")!.action!({});
  const editor = document.querySelector<HTMLElement>(".tb-column-editor")!;
  const inputs = [...editor.querySelectorAll<HTMLInputElement>(".tb-option-name")];
  inputs[0].value = " ";
  inputs[0].dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  click(byEditorName(editor, "Save"));
  assert.equal(notices.at(-1), "Option names must not be empty.");
  assert.equal(ui.saved(), null);
  inputs[0].value = "PC";
  inputs[0].dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  inputs[1].value = "PC";
  inputs[1].dispatchEvent(new dom.window.Event("input", { bubbles: true }));
  click(byEditorName(editor, "Save"));
  assert.equal(notices.at(-1), "An option with this name already exists.");
  assert.equal(ui.saved(), null);
  click(byEditorName(editor, "Cancel"));
  ui.cleanup();
});
test("[fields] column editor stages changes and warns before converting multi-select values to single-select", async () => {
  const ui = mount(); const field = ui.table.fields[2];
  click(ui.root.querySelectorAll(".tb-header-menu")[2]);
  shownMenus.at(-1)!.items.find((item) => item.title === "Edit column")!.action!({});
  const selector = document.querySelector<HTMLElement>(".tb-field-type-selector")!; click(selector);
  [...document.querySelectorAll<HTMLElement>(".tb-field-type-option")].find((item) => item.textContent?.includes(t("Single select")))!.click();
  click(byEditorName(document.body, "Save"));
  const warning = document.querySelector<HTMLElement>(".tb-column-impact")!;
  assert.equal(warning.hidden, false); assert.ok(warning.textContent?.includes("2 cell value(s)")); assert.equal(ui.saved(), null);
  const name = byEditorName(document.body, "Column name") as HTMLInputElement; name.value = "Tags"; name.dispatchEvent(new dom.window.Event("input"));
  assert.equal(warning.hidden, true); click(byEditorName(document.body, "Save")); assert.equal(warning.hidden, false);
  click(byEditorName(document.body, "Apply changes")); await settle();
  const saved = ui.saved()!; assert.equal(saved.fields[2].type, "select"); assert.equal(saved.fields[2].name, "Tags");
  assert.deepEqual(saved.records.map((row) => row.values[field.id]), [field.options![0].id, field.options![0].id]);
  ui.cleanup();
});
test("[fields] changing a non-attachment column to attachments clears old values after confirmation", async () => {
  const ui = mount(); const field = ui.table.fields[0];
  ui.table.records[0].values[field.id] = "2026-10-07";
  ui.table.records[1].values[field.id] = "2026-10-08";
  click(ui.root.querySelectorAll(".tb-header-menu")[0]);
  shownMenus.at(-1)!.items.find((item) => item.title === "Edit column")!.action!({});
  click(document.querySelector<HTMLElement>(".tb-field-type-selector")!);
  [...document.querySelectorAll<HTMLElement>(".tb-field-type-option")].find((item) => item.textContent?.includes(t("Attachments")))!.click();
  click(byEditorName(document.body, "Save"));
  const warning = document.querySelector<HTMLElement>(".tb-column-impact")!;
  assert.equal(warning.hidden, false);
  assert.equal(warning.textContent, "Switching to attachments will clear 2 cell value(s) and 0 filter condition(s) in 0 view(s). Save again to confirm.");
  assert.equal(ui.saved(), null, "the first save only asks for confirmation");
  click(byEditorName(document.body, "Apply changes")); await settle();
  const saved = ui.saved()!;
  assert.equal(saved.fields[0].type, "attachment");
  assert.deepEqual(saved.records.map((row) => row.values[field.id]), [[], []]);
  ui.cleanup();
});
test("[fields] column editor warns before removing an option used by cells and view filters", async () => {
  const table = fixture(); const field = table.fields[1]; const removed = field.options![0].id;
  table.views[0].filters = filtersFor(field.id, [removed], "eq");
  const ui = mount(table);
  click(ui.root.querySelectorAll(".tb-header-menu")[1]);
  shownMenus.at(-1)!.items.find((item) => item.title === "Edit column")!.action!({});
  click(byEditorName(document.body, "Delete PC")); click(byEditorName(document.body, "Save"));
  const warning = document.querySelector<HTMLElement>(".tb-column-impact")!;
  assert.equal(warning.hidden, false); assert.ok(warning.textContent?.includes("1 cell value(s)")); assert.ok(warning.textContent?.includes("1 filter condition(s) in 1 view(s)"));
  assert.equal(ui.saved(), null); click(byEditorName(document.body, "Apply changes")); await settle();
  const saved = ui.saved()!;
  assert.ok(!saved.fields[1].options!.some((option) => option.id === removed));
  assert.equal(saved.records[0].values[field.id], ""); assert.equal(saved.views[0].filters.conditions.length, 0);
  ui.cleanup();
});
test("[fields] date display format edits preserve the stored date-time value", async () => {
  const table = createDefaultTable(); const field = table.fields[2];
  field.dateFormat = "iso-datetime"; table.records[0].values[field.id] = "2026-10-07T21:53";
  const ui = mount(table);
  click(ui.root.querySelectorAll(".tb-header-menu")[2]);
  shownMenus.at(-1)!.items.find((item) => item.title === "Edit column")!.action!({});
  const format = byEditorName(document.body, "Date format") as HTMLSelectElement;
  format.value = "time"; format.dispatchEvent(new dom.window.Event("change"));
  click(byEditorName(document.body, "Save")); await settle();
  assert.equal(ui.saved()!.fields[2].dateFormat, "time");
  assert.equal(ui.saved()!.records[0].values[field.id], "2026-10-07T21:53");
  assert.equal(ui.root.querySelector('td[data-field-id="' + field.id + '"] .tb-date-label')?.textContent, "21:53");
  ui.cleanup();
});
test("[fields][localization] adding a multi-choice option through the panel supports cancellation and stores a flat option ID list", async () => {
  try {
    for (const language of ["en", "zh-CN"]) {
      setLanguage(language); const ui = mount(); const originalField = ui.table.fields[2];
      const add = () => {
        const panel = openMultiChoicePanel(ui.root, originalField.id);
        [...panel.querySelectorAll<HTMLButtonElement>(".tb-multiselect-action")].find((button) => button.textContent === t("New option…"))!.click();
        assert.equal(panel.isConnected, false);
        const modal = document.querySelector<HTMLElement>(".tb-option-name-modal")!;
        assert.ok(modal, "new options use the compact name form");
        assert.equal(modal.querySelector("label"), null, "the single field has no redundant visible label");
        const input = byLabel(modal, t("Option name")) as HTMLInputElement;
        assert.equal(document.activeElement, input);
        [input, byLabel(modal, t("Cancel")), byLabel(modal, t("Add"))].forEach((element) => {
          assert.equal(element.hasAttribute("aria-label"), false);
          assert.equal(element.hasAttribute("title"), false);
          assert.ok(element.getAttribute("aria-labelledby"), "input and actions remain accessible without tooltip attributes");
        });
        return input;
      };
      try {
        const cancelled = add(); assert.ok(cancelled); cancelled.value = "Not added";
        click(byLabel(document.body, t("Cancel"))); await settle();
        assert.equal(ui.saved(), null); assert.equal(originalField.options!.length, 2);
        const input = add(); input.value = "C"; click(byLabel(document.body, t("Add")));
        await waitForCondition(() => ui.saved()?.fields[2].options?.length === 3, "new multi-choice option save");
        const field = ui.saved()!.fields[2]; const values = ui.saved()!.records[0].values[field.id] as string[];
        assert.deepEqual(values, field.options!.map((option) => option.id)); assert.ok(values.every((value) => typeof value === "string"));
        assert.equal(field.options!.at(-1)!.label, "C"); assert.equal(field.options!.at(-1)!.color, OPTION_COLORS[2]);
        const panel = openMultiChoicePanel(ui.root, field.id);
        assert.deepEqual([...panel.querySelectorAll(".tb-multiselect-option-label")].map((label) => label.textContent), ["A", "B", "C"]);
        assert.deepEqual([...panel.querySelectorAll("[role='menuitemcheckbox']")].map((button) => button.getAttribute("aria-checked")), ["true", "true", "true"]);
      } finally {
        document.querySelector(".tb-dialog")?.closest(".modal")?.querySelector<HTMLButtonElement>(".modal-close-button")?.click();
        ui.cleanup();
      }
    }
  } finally { setLanguage("en"); }
});
test("[fields][localization] the single-choice new-option form cancels and submits a trimmed name", async () => {
  try {
    for (const language of ["en", "zh-CN"]) {
      setLanguage(language); const ui = mount(); const field = ui.table.fields[1];
      const open = () => {
        const cell = ui.root.querySelector<HTMLTableCellElement>(`td[data-field-id="${field.id}"]`)!;
        click(cell); click(cell.querySelector(".tb-cell-action")!);
        shownMenus.at(-1)!.items.find((item) => item.title === t("New option…"))!.action!({});
        const modal = document.querySelector<HTMLElement>(".tb-option-name-modal")!;
        assert.ok(modal);
        return modal;
      };
      try {
        let modal = open(); click(byLabel(modal, t("Cancel"))); await settle();
        assert.equal(ui.saved(), null);
        modal = open(); (byLabel(modal, t("Option name")) as HTMLInputElement).value = "  New choice  ";
        modal.querySelector("form")!.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
        await waitForCondition(() => ui.saved()?.fields[1].options?.length === 3, "single-choice new option submission");
        const added = ui.saved()!.fields[1].options!.at(-1)!;
        assert.equal(added.label, "New choice");
        assert.equal(ui.saved()!.records[0].values[field.id], added.id);
        assert.equal(document.querySelector(".tb-option-name-modal"), null);
      } finally { ui.cleanup(); }
    }
  } finally { setLanguage("en"); }
});
test("[interaction][records] row paste preserves unknown values and a newer copy made during its save", async () => {
  const source = mount(); const table = fixture();
  table.records[0].values.unlisted = "Preserve unknown field";
  const root = document.createElement("div"); document.body.append(root);
  let release: (() => void) | undefined; let saved: TableDocument | undefined;
  const controller = renderTable({ app: {} } as any, JSON.stringify(table), {
    root, sourcePath: "pending-paste.md", save: async (_, next) => {
      await new Promise<void>((resolve) => { release = resolve; }); saved = next; return JSON.stringify(next);
    },
  });
  const copyRow = async (index: number) => {
    source.root.querySelectorAll(".tb-data-row")[index].dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true }));
    const menu = shownMenus.at(-1)!;
    await menu.items.find((item) => item.title === t("Copy row"))!.action!({}); menu.hide();
  };
  try {
    await copyRow(0);
    root.querySelector(".tb-data-row")!.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true }));
    const menu = shownMenus.at(-1)!; menu.items.find((item) => item.title === t("Paste row"))!.action!({}); menu.hide();
    await waitForCondition(() => !!release, "pending row save"); release!(); await settle();
    assert.equal(saved?.records[0].values.unlisted, "Preserve unknown field");
    await copyRow(0); click(byLabel(root, "Select")); click(byLabel(root, "Done"));
    click(byLabel(root, "Paste 1 row"));
    await settle(); await copyRow(1); release!(); await settle();
    assert.ok(root.textContent?.includes("Paste 1 row"), "finishing a paste must keep the newer copied row available");
  } finally { controller.destroy(); root.remove(); source.cleanup(); }
});
test("[interaction][records] failed paste leaves the internal clipboard available for retry", async () => {
  const ui = mount(); click(byLabel(ui.root, "Select")); const check = byLabel(ui.root, "Select row") as HTMLInputElement; check.checked = true; check.dispatchEvent(new dom.window.Event("change"));
  ui.root.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "c", metaKey: true, bubbles: true })); ui.cleanup();
  const table = fixture(); const root = document.createElement("div"); document.body.append(root);
  const controller = renderTable({ app: { workspace: { getActiveViewOfType: () => undefined } } } as any, JSON.stringify(table), { root, sourcePath: "fail.md", save: async () => { throw new Error("conflict"); } });
  click(byLabel(root, "Paste 1 row")); await settle(); assert.ok(root.textContent?.includes("Paste 1 row")); assert.ok(notices.at(-1)?.includes("conflict")); controller.destroy(); root.remove();
});
test("[views][records] inserting beside a grouped record keeps the new record in that group", async () => {
  const ui = mount(); click(ui.root.querySelectorAll(".tb-header-menu")[2]);
  shownMenus.at(-1)!.items.find(item => item.title === "Group by this column")!.action!({}); await settle();
  ui.root.querySelector(".tb-data-row")!.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true }));
  shownMenus.at(-1)!.items.find(item => item.title === "Insert row below")!.action!({}); await settle();
  const records = ui.saved()!.records; const field = ui.table.fields[2];
  assert.deepEqual(records[1].values[field.id], records[0].values[field.id]); assert.equal(ui.root.querySelectorAll(".tb-group-row").length, 1); ui.cleanup();
});
test("[views][records] adding a row to a date group keeps its canonical date value", async () => {
  const table = createDefaultTable(); const field = table.fields[2]; field.dateFormat = "iso-date";
  table.records[0].values[field.id] = "2026-10-07T09:30"; table.records[1].values[field.id] = "2026-10-07T14:00";
  table.views[0].group = { fieldId: field.id, direction: "asc" };
  const root = document.createElement("div"); document.body.append(root); let saved: TableDocument | null = null;
  const controller = renderTable({ app: { workspace: { getActiveViewOfType: () => null } } } as any, JSON.stringify(table), { root, sourcePath: `${table.tableId}.md`, save: async (_, next) => { saved = next; return JSON.stringify(next); } });
  assert.equal(root.querySelectorAll(".tb-group-row").length, 1);
  click(root.querySelector(".tb-group-add")!); await settle();
  assert.equal(saved!.records.at(-1)!.values[field.id], "2026-10-07T09:30");
  controller.destroy(); root.remove();
});
test("[views][records] group settings remain open after a reading-view save recreates the renderer", async () => {
  const ui = mount(); click(byLabel(ui.root, "Group"));
  const select = document.body.querySelector<HTMLButtonElement>(".tb-group-select")!;
  assert.ok(select.querySelector(".tb-group-select-icon"));
  click(select);
  const menu = shownMenus.at(-1)!;
  assert.equal(menu.useNativeMenu, false);
  assert.deepEqual(menu.items.map((item) => [item.title, item.icon]), [
    ["名称", "text"], ["平台", "chevron-down-circle"], ["标签", "tags"],
  ]);
  assert.ok(menu.items.every((item) => item.title !== "Group by…"));
  assert.ok(menu.items.every((item) => item.titleFragment?.querySelector(".tb-config-menu-label")), "group field menus share the fixed check column");
  assert.ok(menu.items.every((item) => item.section === "super-table-config-icon"), "the whole icon field menu stays in one section without extra separators");
  menu.hide();
  const previousMobile = Platform.isMobile;
  Platform.isMobile = true;
  let mobileUi: ReturnType<typeof mount> | undefined;
  try {
    const mobileTable = fixture(); mobileTable.tableId = `${ui.table.tableId}-mobile`;
    mobileUi = mount(mobileTable);
    click(byLabel(mobileUi.root, "Group"));
    const mobileSelect = [...document.querySelectorAll<HTMLButtonElement>(".tb-group-select")].at(-1)!;
    click(mobileSelect);
    const mobileMenu = shownMenus.at(-1)!;
    assert.ok(mobileMenu.items.every((item) => item.section === "super-table-config-icon"), "mobile group menus retain one icon-backed section");
    mobileMenu.hide();
  } finally { mobileUi?.cleanup(); Platform.isMobile = previousMobile; }
  menu.items.find((item) => item.title === ui.table.fields[1].name)!.action!({});
  await settle(); const saved = ui.saved()!; ui.cleanup();
  const root = document.createElement("div"); document.body.append(root);
  const controller = renderTable({ app: {} } as any, JSON.stringify(saved), { root, sourcePath: `${saved.tableId}.md`, save: async (_, next) => JSON.stringify(next) });
  assert.ok(document.body.querySelector(".tb-group-panel")); assert.ok(document.body.querySelector(".tb-group-select-label")!.textContent === saved.fields[1].name);
  assert.equal(document.body.querySelector<HTMLButtonElement>(".tb-group-panel .tb-group-clear")?.disabled, false);
  click(document.body.querySelector<HTMLButtonElement>(".tb-group-select")!);
  const selectedMenu = shownMenus.at(-1)!;
  assert.deepEqual(selectedMenu.items.map((item) => item.title), saved.fields.map((field) => field.name));
  assert.equal(selectedMenu.items.find((item) => item.title === saved.fields[1].name)!.checked, true);
  click(byLabel(root, "Group")); controller.destroy(); root.remove();
});

test("[views][grouping] the toolbar button stays highlighted only while grouping is active", async () => {
  const table = fixture();
  delete table.views[0].group;
  table.views[0].filters = filtersFor(table.fields[0].id, "Win");
  const clippedHost = document.createElement("div");
  clippedHost.style.cssText = "overflow: hidden; transform: translateX(40px)";
  document.body.append(clippedHost);
  const ui = mount(table, true, clippedHost);
  try {
    click(byLabel(ui.root, t("Filter · {count} conditions", { count: 1 })));
    let groupButton = byLabel(ui.root, "Group") as HTMLButtonElement;
    click(groupButton);
    const panel = document.body.querySelector<HTMLElement>(".tb-group-panel");
    assert.ok(panel, "group settings open while a filter is active");
    assert.equal(panel.parentElement, document.body, "the popover escapes clipped and transformed table ancestors");
    assert.equal(clippedHost.contains(panel), false);
    assert.equal(groupButton.classList.contains("is-active"), true, "opening the settings highlights the toolbar button");
    click(byLabel(document.body, "Close grouping settings"));
    assert.equal(document.body.querySelector(".tb-group-panel"), null);
    assert.equal(groupButton.classList.contains("is-active"), false, "closing without a configured group removes the highlight");

    click(groupButton);
    click(document.body.querySelector(".tb-group-select")!);
    const menu = shownMenus.at(-1)!;
    menu.items.find((item) => item.title === ui.table.fields[1].name)!.action!({});
    await settle();
    groupButton = byLabel(ui.root, "Group") as HTMLButtonElement;
    assert.equal(groupButton.classList.contains("is-active"), true, "a saved group keeps the toolbar button highlighted");
    click(groupButton);
    assert.equal(document.body.querySelector(".tb-group-panel"), null);
    assert.equal(groupButton.classList.contains("is-active"), true, "closing the popup does not clear the grouping highlight");

    click(groupButton);
    click(byLabel(document.body, "Clear this grouping condition"));
    await settle();
    groupButton = byLabel(ui.root, "Group") as HTMLButtonElement;
    assert.ok(document.body.querySelector(".tb-group-panel"), "clearing a condition keeps its popup open");
    assert.equal(document.body.querySelector<HTMLButtonElement>(".tb-group-clear")?.disabled, true);
    assert.equal(groupButton.classList.contains("is-active"), true, "the open popup keeps the toolbar highlighted");
    assert.equal(ui.saved()!.views[0].group, undefined);
    click(byLabel(document.body, "Close grouping settings"));
    assert.equal(document.body.querySelector(".tb-group-panel"), null);
    assert.equal(groupButton.classList.contains("is-active"), false, "closing after clearing removes the toolbar highlight");
  } finally { ui.cleanup(); clippedHost.remove(); }
});

test("[localization] both language catalogs cover the same messages and preserve interpolation parameters", () => {
  assert.deepEqual(Object.keys(zhCN).sort(), Object.keys(en).sort());
  const placeholders = (message: string) => [...message.matchAll(/\{(\w+)\}/g)].map((match) => match[1]).sort();
  for (const key of Object.keys(en) as Array<keyof typeof en>) {
    assert.ok(zhCN[key].trim(), key);
    assert.deepEqual(placeholders(zhCN[key]), placeholders(en[key]), key);
  }
  for (const [code, expected] of [["en", "en"], ["en-GB", "en"], ["zh", "zh-CN"], ["zh_CN", "zh-CN"], ["ZH-cn", "zh-CN"], ["zh-Hans-CN", "zh-CN"], ["zh-SG", "zh-CN"], ["zh-TW", "en"], ["fr", "en"]]) {
    assert.equal(resolveLocale(code), expected);
  }
});

test("[localization] language switching translates generated labels but preserves existing table content", () => {
  const existing = fixture(); const before = JSON.stringify(existing);
  try {
    setLanguage("zh"); assert.equal(getLocale(), "zh-CN");
    assert.equal(fieldTypeLabel("select"), "单选"); assert.equal(fieldTypeLabel("multiselect"), "多选");
    const created = createDefaultTable();
    assert.deepEqual(created.fields.map((field) => field.name), ["名称", "状态", "截止日期"]);
    assert.deepEqual(created.fields[1].options!.map((option) => option.label), ["待办", "进行中", "完成"]);
    assert.equal(created.views[0].name, "全部");
    const grouped = normalizeTable(existing); grouped.views[0].group = { fieldId: grouped.fields[1].id, direction: "asc" };
    grouped.records[0].values[grouped.fields[1].id] = "";
    assert.ok(groupRows(grouped, grouped.views[0], grouped.records).some((group) => group.label === "未分类"));
    assert.equal(JSON.stringify(existing), before);
    assert.deepEqual(normalizeTable(existing).fields.map((field) => field.name), existing.fields.map((field) => field.name));
    assert.equal(t("Delete {name}", { name: "A {count} <B>" }), "删除 A {count} <B>");
    assert.equal(errorMessage(new SyntaxError("Unexpected token")), "表格 JSON 格式无效，请检查原始表格数据。");
    setLanguage("en"); assert.equal(fieldTypeLabel("select"), "Select"); assert.equal(createDefaultTable().views[0].name, "All");
  } finally { setLanguage("en"); }
});

test("[localization] Chinese renderer translates toolbar, menus, option colors and dialogs without changing option IDs", async () => {
  setLanguage("zh-CN"); const ui = mount();
  try {
    const labels = [...ui.root.querySelectorAll(".tb-toolbar button:not(.tb-view-menu-button) span:not(:has(svg))")].map((element) => element.textContent || "");
    assert.deepEqual(labels.filter((label) => !/^粘贴 \d+ 行$/.test(label)), ["显示配置", "新增行", "新增列", "筛选", "分组", "搜索", "选择", "表格操作"]);
    assert.equal(ui.root.querySelector<HTMLTextAreaElement>(".tb-field-name")!.value, "名称");
    assert.equal(ui.root.querySelector(".tb-choice-label")!.textContent, "PC");
    click(byLabel(ui.root, "表格操作"));
    const exportMenu = shownMenus.at(-1)!;
    assert.deepEqual(exportMenu.items.map((item) => item.title), ["复制表格", "导出 CSV", "导出 Markdown"]);
    assert.deepEqual(exportMenu.items[1].child!.items.map((item) => item.title), ["当前视图", "全部字段和记录"]);
    assert.deepEqual(exportMenu.items[2].child!.items.map((item) => item.title), [
      "当前视图", "全部字段和记录", "复制当前视图", "复制全部字段和记录",
    ]);
    exportMenu.hide();
    click(byLabel(ui.root, "显示配置"));
    const displayConfig = document.querySelector<HTMLElement>(".tb-display-config-popover")!;
    const dialogLabel = displayConfig.getAttribute("aria-labelledby");
    assert.equal(dialogLabel ? document.getElementById(dialogLabel)?.textContent : null, "显示配置");
    assert.equal(displayConfig.querySelector(".tb-display-field-name")?.textContent, "名称");
    assert.ok([...displayConfig.querySelectorAll<HTMLElement>(".tb-display-field-visibility")].some((button) => {
      const labelId = button.getAttribute("aria-labelledby");
      return !!labelId && document.getElementById(labelId)?.textContent === "隐藏名称";
    }));
    closeDisplayConfig();
    click(ui.root.querySelectorAll(".tb-header-menu")[1]);
    const columnMenu = shownMenus.at(-1)!;
    assert.ok(columnMenu.items.some((item) => item.title === "编辑列"));
    assert.ok(!columnMenu.items.some((item) => item.title === "单选" || item.title === "多选"));
    assert.deepEqual(columnMenu.items.find((item) => item.title === "文本对齐")!.child!.items.map((item) => item.title), ["左对齐", "居中", "右对齐"]);
    assert.ok(columnMenu.items.find((item) => item.title === "文本对齐")!.child!.items.every((item) => item.section === "super-table-config-icon"));
    assert.ok(columnMenu.items.every((item) => item.section !== "super-table-config" && item.section !== "super-table-config-icon"), "ordinary column actions keep their host layout");
    assert.ok(!columnMenu.items.some((item) => item.title === "移动列"));
    columnMenu.items.find((item) => item.title === "编辑列")!.action!({});
    assert.ok([...document.querySelectorAll<HTMLElement>(".tb-option-color-trigger")].some((element) => {
      const labelId = element.getAttribute("aria-labelledby");
      return !!labelId && document.getElementById(labelId)?.textContent?.includes("绿色");
    }));
    assert.equal(colorLabel("purple"), "紫色");
    const input = document.querySelector<HTMLInputElement>(".tb-option-name")!; input.value = "桌面"; input.dispatchEvent(new dom.window.Event("input"));
    click(byEditorName(document.body, "保存")); await settle();
    assert.equal(ui.saved()!.fields[1].options![0].id, ui.table.fields[1].options![0].id);
    assert.equal(ui.saved()!.records[0].values[ui.table.fields[1].id], ui.table.fields[1].options![0].id);
    ui.root.querySelector(".tb-data-row")!.dispatchEvent(new dom.window.MouseEvent("contextmenu", { bubbles: true }));
    assert.ok(shownMenus.at(-1)!.items.some((item) => item.title === "在下方插入行"));
    click(byLabel(ui.root, "选择")); const checkbox = byLabel(ui.root, "选择行") as HTMLInputElement;
    checkbox.checked = true; checkbox.dispatchEvent(new dom.window.Event("change"));
    assert.ok(ui.root.querySelector(".tb-selection-count")!.textContent!.includes("已选择 1 行"));
    click(byLabel(ui.root, "删除"));
    assert.ok(document.querySelector(".tb-dialog-message")!.textContent!.includes("删除 1 行及其数据"));
    click(byEditorName(document.body, "取消")); await settle();
    assert.equal(ui.saved()!.records.length, 2);
  } finally { closeDisplayConfig(); ui.cleanup(); setLanguage("en"); }
});

test("[localization] empty choices and links stay blank in both languages; link editor labels remain localized and accessible", () => {
  for (const language of ["en", "zh-CN"]) {
    setLanguage(language); const table = fixture();
    table.fields.push({ id: "url", name: "网址", type: "link" });
    table.records.forEach((row) => { row.values.url = ""; row.values[table.fields[1].id] = ""; row.values[table.fields[2].id] = []; });
    const ui = mount(table);
    try {
      assert.equal(ui.root.querySelectorAll(".tb-choice .tb-pill, .tb-tags .tb-pill, .tb-link-text").length, 0);
      const cell = ui.root.querySelector('td[data-field-id="url"]')!;
      assert.equal(cell.textContent, ""); click(cell); click(cell.querySelector(".tb-cell-action")!);
      const editor = document.querySelector<HTMLElement>(".tb-link-editor-popover")!;
      const inputs = [...editor.querySelectorAll<HTMLInputElement>("input")];
      assert.deepEqual(inputs.map((input) => {
        const associatedLabel = input.id ? editor.querySelector<HTMLLabelElement>(`label[for="${input.id}"]`) : null;
        return (associatedLabel ?? input.closest("label"))?.textContent?.trim();
      }), language === "en" ? ["Text", "URL"] : ["文本", "链接"]);
      assert.ok(inputs.every((input) => !input.hasAttribute("aria-label")));
      const edit = cell.querySelector<HTMLButtonElement>(".tb-cell-action")!;
      assert.equal(edit.hasAttribute("aria-label"), false); assert.ok(edit.hasAttribute("aria-labelledby"));
      assert.equal(ui.saved(), null);
    } finally { ui.cleanup(); setLanguage("en"); }
  }
});

test("[views][data-format] date-only and time-only date filters use the selected range mode", () => {
  const table = createDefaultTable(); const field = table.fields[2];
  table.records = [
    { id: "morning", values: { [field.id]: "2026-10-07T09:30" } },
    { id: "date-only", values: { [field.id]: "2026-10-07" } },
  ];
  field.dateFormat = "time"; table.views[0].filters = filtersFor(field.id, "09:00", "between", "10:00");
  assert.deepEqual(filterAndSortRows(table, table.views[0]).map((row) => row.id), ["morning"]);
  field.dateFormat = "iso-date"; table.views[0].filters = filtersFor(field.id, "2026-10-07", "between", "2026-10-07");
  assert.deepEqual(filterAndSortRows(table, table.views[0]).map((row) => row.id), ["morning", "date-only"]);
});

test("[fields][localization] checkbox conversions recognize saved text from either supported language", async () => {
  for (const language of ["en", "zh-CN"]) {
    setLanguage(language); const table = fixture();
    table.records[0].values[table.fields[0].id] = "已勾选";
      table.records[1].values[table.fields[0].id] = "Unchecked";
      const ui = mount(table);
    try {
      click(ui.root.querySelector(".tb-header-menu")!);
      shownMenus.at(-1)!.items.find((item) => item.title === t("Edit column"))!.action!({});
      click(document.querySelector<HTMLElement>(".tb-field-type-selector")!);
      [...document.querySelectorAll<HTMLElement>(".tb-field-type-option")].find((item) => item.textContent?.includes(t("Checkbox")))!.click();
      click(byEditorName(document.body, t("Save"))); await settle();
      assert.equal(ui.saved()!.fields[0].type, "checkbox");
      assert.deepEqual(ui.saved()!.records.map((row) => row.values[table.fields[0].id]), [true, false]);
    } finally { ui.cleanup(); setLanguage("en"); }
  }
});

test("[localization][table-block] startup ignores stale browser language and defaults safely when the Obsidian API throws", async () => {
  const previous = window.localStorage.getItem("language");
  try {
    const cases = [
      { language: "zh", stored: "en", expected: "zh-CN" },
      { language: "en", stored: "zh", expected: "en" },
      { language: "throws", stored: "zh", expected: "en" },
    ] as const;
    for (const scenario of cases) {
      if (scenario.language === "throws") setObsidianLanguageFailure(); else setObsidianLanguage(scenario.language);
      window.localStorage.setItem("language", scenario.stored);
      const commands: any[] = []; let ribbonLabel = ""; let editorMenu: any; const registeredLanguages: string[] = [];
      const plugin = Object.assign(new SuperTablePlugin({} as any, {} as any), {
        app: { workspace: { on: (_: string, callback: any) => { editorMenu = callback; }, getActiveViewOfType: () => null } },
        registerEditorExtension: () => {}, registerMarkdownCodeBlockProcessor: (language: string) => { registeredLanguages.push(language); }, registerEvent: () => {},
        addRibbonIcon: (_: string, label: string) => { ribbonLabel = label; },
        addCommand: (command: any) => { commands.push(command); },
      });
      await plugin.onload();
      const chinese = scenario.expected === "zh-CN";
      assert.equal(getLocale(), scenario.expected);
      assert.equal(ribbonLabel, chinese ? "插入 Super Table" : "Insert Super Table");
      assert.equal(plugin.manifest.description, chinese
        ? "创建可编辑的数据表，设置字段类型和日期格式、按字段分组，并为同一批记录创建多个命名视图。"
        : "Create editable data tables with typed fields, date formats, grouping, and multiple named views over shared records.");
      assert.deepEqual(registeredLanguages, ["super-table"]);
      assert.deepEqual(commands.map((command) => command.id), ["insert-table", "import-smart-table", "convert-markdown-table", "convert-to-markdown"]);
      assert.deepEqual(commands.map((command) => command.name), chinese
        ? ["插入表格", "导入 Smart Table 代码块", "将 Markdown 表格转换为 Super Table", "将 Super Table 表格转换为 Markdown"]
        : ["Insert table", "Import Smart Table block", "Convert Markdown table to Super Table", "Convert Super Table to Markdown"]);
      await commands.find((command) => command.id === "import-smart-table").callback();
      assert.equal(notices.at(-1), chinese ? "请打开一篇 Markdown 笔记，并将光标放在 Smart Table 代码块内。" : "Open a Markdown note and place the cursor inside a Smart Table block.");
      const lines = ["```smart-table", JSON.stringify(old), "```"]; const menu = new Menu();
      editorMenu(menu, { getCursor: () => ({ line: 1, ch: 0 }), lineCount: () => lines.length, getLine: (index: number) => lines[index] });
      assert.equal(menu.items[0].title, chinese ? "将 Smart Table 导入 Super Table" : "Import Smart Table into Super Table");
    }
  } finally {
    if (previous === null) window.localStorage.removeItem("language"); else window.localStorage.setItem("language", previous);
    setObsidianLanguage("en"); setLanguage("en");
  }
});

test("[views][data-format] typed operators handle empty values, case, numeric boundaries and invalid numbers", () => {
  const ids = (type: Field["type"], values: any[], operator: FilterCondition["operator"], value?: FilterCondition["value"], upper?: FilterCondition["upper"]) => {
    const field: Field = { id: "f", name: "Value", type };
    return filterRows([field], values.map((item, id) => ({ id: String(id), values: { f: item } })), filtersFor("f", value, operator, upper)).map((row) => Number(row.id));
  };
  const text = [null, "", " ", "Alpha", "ALPHABET", "Beta"];
  assert.deepEqual(ids("text", text, "eq", "alpha"), [3]);
  assert.deepEqual(ids("link", text, "neq", "ALPHA"), [0, 1, 2, 4, 5]);
  assert.deepEqual(ids("text", text, "contains", "alpha"), [3, 4]);
  assert.deepEqual(ids("text", text, "notContains", "ALPHA"), [0, 1, 2, 5]);
  assert.deepEqual(ids("text", text, "isEmpty"), [0, 1]);
  assert.deepEqual(ids("text", text, "isNotEmpty"), [2, 3, 4, 5]);
  const numbers = [null, "", " ", "bad", -1, 0, "5", 10, 11];
  assert.deepEqual(ids("number", numbers, "eq", 0), [5]);
  assert.deepEqual(ids("number", numbers, "neq", 0), [4, 6, 7, 8]);
  assert.deepEqual(ids("number", numbers, "gt", 10), [8]);
  assert.deepEqual(ids("number", numbers, "gte", 10), [7, 8]);
  assert.deepEqual(ids("number", numbers, "lt", 0), [4]);
  assert.deepEqual(ids("number", numbers, "lte", 0), [4, 5]);
  assert.deepEqual(ids("number", numbers, "between", 0, 10), [5, 6, 7]);
  assert.deepEqual(ids("number", numbers, "isEmpty"), [0, 1]);
  assert.deepEqual(ids("number", numbers, "isNotEmpty"), [2, 3, 4, 5, 6, 7, 8]);
  assert.deepEqual(ids("attachment", [null, [], ["missing.png"]], "isEmpty"), [0, 1]);
  assert.deepEqual(ids("attachment", [null, [], ["missing.png"]], "isNotEmpty"), [2]);
  assert.deepEqual(ids("checkbox", [null, false, true], "checked"), [2]);
  assert.deepEqual(ids("checkbox", [null, false, true], "unchecked"), [0, 1]);
});

test("[views] option filters distinguish exact sets from any overlap without order or label dependencies", () => {
  const field: Field = { id: "f", name: "Tags", type: "multiselect", options: [{ id: "a", label: "Renamed", color: "blue" }, { id: "b", label: "B", color: "red" }] };
  const rows = [null, [], ["a"], ["a", "b"], ["b", "a"], ["b", "c"], ["c"]].map((value, id) => ({ id: String(id), values: { f: value } }));
  const match = (op: FilterCondition["operator"], values?: string[]) => filterRows([field], rows, filtersFor("f", values, op)).map((row) => Number(row.id));
  assert.deepEqual(match("eq", ["a", "b"]), [3, 4]);
  assert.deepEqual(match("neq", ["b", "a"]), [0, 1, 2, 5, 6]);
  assert.deepEqual(match("contains", ["a", "b"]), [2, 3, 4, 5]);
  assert.deepEqual(match("notContains", ["a", "b"]), [0, 1, 6]);
  assert.deepEqual(match("isEmpty"), [0, 1]);
  assert.deepEqual(match("isNotEmpty"), [2, 3, 4, 5, 6]);
  field.type = "select";
  const singleRows = ["a", "b", "c", null, ""].map((value, id) => ({ id: String(id), values: { f: value } }));
  assert.deepEqual(filterRows([field], singleRows, filtersFor("f", ["a", "b"])).map((row) => row.id), ["0", "1"]);
  assert.deepEqual(filterRows([field], singleRows, filtersFor("f", ["a"], "neq")).map((row) => row.id), ["1", "2", "3", "4"]);
});

test("[views][data-format] date filters compare valid dates, minutes and time with inclusive ranges", () => {
  const field: Field = { id: "date", name: "Date", type: "date", dateFormat: "iso-date" };
  const rows = [null, "", "2026-02-30", "2026-10-07", "2026-10-07T09:30:59", "2026-10-08T09:30"].map((value, id) => ({ id: String(id), values: { date: value } }));
  const match = (op: FilterCondition["operator"], value?: string, upper?: string) => filterRows([field], rows, filtersFor(field.id, value, op, upper)).map((row) => Number(row.id));
  assert.deepEqual(match("eq", "2026-10-07"), [3, 4]);
  assert.deepEqual(match("gt", "2026-10-07"), [5]);
  assert.deepEqual(match("lt", "2026-10-08"), [3, 4]);
  assert.deepEqual(match("between", "2026-10-07", "2026-10-08"), [3, 4, 5]);
  assert.deepEqual(match("isEmpty"), [0, 1]);
  assert.deepEqual(match("isNotEmpty"), [2, 3, 4, 5]);
  field.dateFormat = "iso-datetime";
  assert.deepEqual(match("eq", "2026-10-07T09:30"), [4]);
  assert.deepEqual(match("between", "2026-10-07T00:00", "2026-10-07T09:30"), [3, 4]);
  field.dateFormat = "time";
  assert.deepEqual(match("eq", "09:30"), [4, 5]);
  assert.deepEqual(match("between", "00:00", "09:30"), [3, 4, 5]);
  assert.equal(validFilterCondition(filtersFor(field.id, "09:30", "between", "09:29").conditions[0], field), false);
});

test("[views] AND/OR support repeated fields and ignore unresolved references, including an empty OR", () => {
  const field: Field = { id: "f", name: "Name", type: "text" };
  const rows = ["Alpha", "Beta", "Alphabet"].map((value, id) => ({ id: String(id), values: { f: value } }));
  const filters: FilterGroup = { mode: "and", conditions: [
    { id: "first", fieldId: "f", operator: "contains", value: "alpha" },
    { id: "second", fieldId: "f", operator: "notContains", value: "bet" },
    { id: "missing", fieldId: "missing", operator: "eq", value: "impossible" },
  ] };
  assert.deepEqual(filterRows([field], rows, filters).map((row) => row.id), ["0"]);
  filters.mode = "or";
  assert.deepEqual(filterRows([field], rows, filters).map((row) => row.id), ["0", "2"]);
  filters.conditions = [filters.conditions[2]];
  assert.deepEqual(filterRows([field], rows, filters), rows);
  filters.conditions = [];
  assert.deepEqual(filterRows([field], rows, filters), rows);
  assert.deepEqual(rows.map((row) => row.id), ["0", "1", "2"]);
});

test("[data-format][storage] old filter shapes and malformed new conditions disable editing without saving", () => {
  const table = fixture();
  const invalid: unknown[] = [{}, { [table.fields[0].id]: { value: "Win" } }, { mode: "unknown", conditions: [] },
    { mode: "or", conditions: [null] }, filtersFor(table.fields[0].id, undefined), filtersFor(table.fields[0].id, "x", "gt"),
    { mode: "and", conditions: [filtersFor(table.fields[0].id, "x").conditions[0], filtersFor(table.fields[0].id, "y").conditions[0]] },
  ];
  for (const filters of invalid) {
    const raw = { ...table, views: [{ ...table.views[0], filters }] }; const source = JSON.stringify(raw);
    assert.throws(() => readTable(source), /Invalid stored data at views\[0\].filters/);
    const root = document.createElement("div"); document.body.append(root); let writes = 0;
    const controller = renderTable({ app: {} } as any, source, { root, sourcePath: "invalid-filters.md", save: async () => { writes++; return ""; } });
    assert.equal(root.querySelector(".tb-grid"), null); assert.ok(root.textContent?.includes(source)); assert.equal(writes, 0);
    assert.equal(JSON.stringify(raw), source); controller.destroy(); root.remove();
  }
});

test("[import-export][views] Smart Table imports supported filters together and clears all on any unsupported condition", () => {
  const raw = {
    columns: [{ id: "text", name: "Text", type: "text" }, { id: "n", name: "Number", type: "number" }, { id: "date", name: "Date", type: "date" }, { id: "check", name: "Check", type: "checkbox" },
      { id: "single", name: "Single", type: "select", options: ["A", "B"] }, { id: "tags", name: "Tags", type: "multiselect", options: ["A", "B"] }],
    rows: [{ cells: { text: "Alpha", n: 5, date: "2026-10-07", check: true, single: "A", tags: ["A", "B"] } }],
    filters: { text: "alpha", n: "0|10", date: "2026-10-07|2026-10-08", check: true, single: "A", tags: "B" },
    sort: { col: "n", dir: "desc" }, group: { col: "single", dir: "asc" },
  };
  const converted = convertSmartTable(JSON.stringify(raw));
  assert.deepEqual(converted.warnings, []);
  assert.deepEqual(converted.table.views[0].filters.conditions.map((rule) => rule.operator), ["contains", "between", "between", "checked", "eq", "contains"]);
  assert.equal(filterAndSortRows(converted.table, converted.table.views[0]).length, 1);
  for (const range of ["0|", "|10", "0"]) {
    const result = convertSmartTable(JSON.stringify({ ...raw, filters: { n: range } }));
    assert.equal(result.warnings.length, 0); assert.equal(result.table.views[0].filters.conditions[0].operator, range.startsWith("|") ? "lte" : "gte");
  }
  for (const filters of [{ ...raw.filters, single: "Missing" }, { ...raw.filters, missing: "x" }, { ...raw.filters, n: "10|1" }, { ...raw.filters, n: "oops|10" }, { ...raw.filters, date: "2026-10-07|" }, { ...raw.filters, date: "2026-02-30|2026-03-01" }, [{ field: "n" }], "unknown", { text: { value: "x" } }]) {
    const result = convertSmartTable(JSON.stringify({ ...raw, filters }));
    assert.deepEqual(result.table.views[0].filters, emptyFilters()); assert.equal(result.warnings.length, 1);
    assert.ok(result.warnings[0].includes("All imported filters were cleared"));
    assert.match(result.warnings[0], /not found|invalid or unsupported|structure is unsupported/);
    assert.equal(result.table.records.length, 1); assert.ok(result.table.views[0].sort); assert.ok(result.table.views[0].group);
    assert.equal(result.table.schemaVersion, 1);
  }
});

test("[views][interaction] desktop filter field menus preserve drafts, cancel before the panel and commit a new field only with a valid value", async () => {
  const table = fixture(); const [text, select] = table.fields;
  table.views[0].filters = filtersFor(text.id, "Win");
  const ui = mount(table); const surface = document.createElement("div"); surface.className = "menu";
  try {
    click(ui.root.querySelector(".tb-filter-toggle")!);
    const panel = document.querySelector<HTMLElement>(".tb-filter-popover")!;
    const trigger = panel.querySelector<HTMLButtonElement>("button.tb-filter-field")!;
    click(trigger); const menu = shownMenus.at(-1)!;
    assert.equal(menu.useNativeMenu, false); assert.equal(menu.mouseEvent, undefined);
    assert.equal(menu.ownerDocument, document);
    assert.deepEqual(menu.items.map((item) => item.title), table.fields.map((field) => field.name));
    assert.ok(menu.items.every((item) => item.titleFragment?.querySelector(".tb-config-menu-label")), "all field rows reserve the same scoped check column");
    assert.ok(menu.items.every((item) => item.section === "super-table-config-icon"));
    assert.deepEqual(menu.items.map((item) => item.icon), ["text", "chevron-down-circle", "tags"]);
    assert.deepEqual(menu.items.map((item) => item.checked), [true, false, false]);
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    document.body.append(surface); surface.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }));
    assert.ok(panel.isConnected, "menu clicks must not dismiss the filter panel");
    surface.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.ok(menu.hidden); assert.ok(panel.isConnected); assert.equal(document.activeElement, trigger);
    assert.equal(trigger.getAttribute("aria-expanded"), "false"); assert.equal(ui.saved(), null);
    click(trigger); shownMenus.at(-1)!.items[0].action!({}); await settle();
    assert.equal(panel.querySelector<HTMLInputElement>(".tb-filter-value")?.value, "Win"); assert.equal(ui.saved(), null);
    trigger.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const nextMenu = shownMenus.at(-1)!; nextMenu.items[1].action!({}); await settle();
    assert.ok(nextMenu.hidden); assert.ok(panel.isConnected); assert.equal(ui.saved(), null);
    assert.equal(document.activeElement, panel.querySelector(".tb-filter-field"));
    click(panel.querySelector(".tb-filter-value-choice")!);
    click(document.querySelector(".tb-filter-option")!); await settle();
    assert.equal(ui.saved()?.views[0].filters.conditions[0].fieldId, select.id);
    assert.deepEqual(ui.saved()?.views[0].filters.conditions[0].value, [select.options![0].id]);
    click(panel.querySelector(".tb-filter-field")!); const lastMenu = shownMenus.at(-1)!;
    click(panel.querySelector(".tb-filter-close")!); assert.ok(lastMenu.hidden); assert.equal(panel.isConnected, false);
  } finally { surface.remove(); ui.cleanup(); }
});

test("[views][interaction] desktop filter field menu can reopen after an in-panel outside dismissal", () => {
  const table = fixture();
  table.views[0].filters = filtersFor(table.fields[0].id, "Win");
  const ui = mount(table);
  try {
    click(ui.root.querySelector(".tb-filter-toggle")!);
    const panel = document.querySelector<HTMLElement>(".tb-filter-popover")!;
    const trigger = panel.querySelector<HTMLButtonElement>("button.tb-filter-field")!;
    click(trigger);
    const firstMenu = shownMenus.at(-1)!;

    panel.querySelector<HTMLElement>(".tb-filter-add")!.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }));
    assert.ok(firstMenu.hidden, "clicking another control in the parent panel dismisses only the column menu");
    assert.equal(trigger.getAttribute("aria-expanded"), "false");

    trigger.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail: 1 }));
    const reopenedMenu = shownMenus.at(-1)!;
    assert.notEqual(reopenedMenu, firstMenu);
    assert.equal(reopenedMenu.hidden, false);
    assert.equal(trigger.getAttribute("aria-expanded"), "true");
    click(panel.querySelector(".tb-filter-close")!);
  } finally { ui.cleanup(); }
});

test("[views][interaction] desktop filter selectors toggle and switch without host outside-mouse dismissal", async () => {
  const table = fixture(); table.views[0].filters = filtersFor(table.fields[0].id, "Win");
  const ui = mount(table);
  // Obsidian Menu dismisses on window mousedown/click outside its own DOM.
  const hostDismiss = () => { const menu = shownMenus.at(-1); if (menu && !menu.hidden) menu.hide(); };
  dom.window.addEventListener("mousedown", hostDismiss); dom.window.addEventListener("click", hostDismiss);
  try {
    click(ui.root.querySelector(".tb-filter-toggle")!);
    const panel = document.querySelector<HTMLElement>(".tb-filter-popover")!;
    assert.equal(panel.querySelectorAll("select").length, 0, "desktop selectors all use Menu buttons");
    const field = panel.querySelector<HTMLButtonElement>(".tb-filter-field")!;
    const operator = panel.querySelector<HTMLButtonElement>(".tb-filter-operator")!;
    const mode = panel.querySelector<HTMLButtonElement>(".tb-filter-mode")!;
    const activate = async (trigger: HTMLButtonElement) => {
      trigger.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true, button: 0 }));
      trigger.focus(); await Promise.resolve();
      trigger.dispatchEvent(new dom.window.MouseEvent("mousedown", { bubbles: true, button: 0 }));
      trigger.dispatchEvent(new dom.window.MouseEvent("mouseup", { bubbles: true, button: 0 }));
      trigger.dispatchEvent(new dom.window.MouseEvent("click", { bubbles: true, detail: 1 }));
    };
    let previousMenu: Menu | undefined;
    for (const trigger of [field, operator, field, mode, operator, mode]) {
      await activate(trigger);
      const menu = shownMenus.at(-1)!;
      if (previousMenu) assert.ok(previousMenu.hidden, "switching closes the previous menu");
      assert.equal(menu.hidden, false, "the same opening gesture must not close the new menu");
      assert.equal(menu.useNativeMenu, false); assert.equal(menu.ownerDocument, document);
      assert.ok(menu.items.every((item) => item.titleFragment?.querySelector(".tb-config-menu-label")), "operator, relationship and field menus share the check-column scope");
      const expectedSection = trigger === field ? "super-table-config-icon" : "super-table-config";
      assert.ok(menu.items.every((item) => item.section === expectedSection), "each field, operator or relationship menu stays within its matching section");
      assert.equal(trigger.getAttribute("aria-expanded"), "true");
      assert.equal([field, operator, mode].filter((button) => button.getAttribute("aria-expanded") === "true").length, 1);
      previousMenu = menu;
    }
    assert.deepEqual(previousMenu!.items.map((item) => item.checked), [true, false]);
    await activate(mode); assert.ok(previousMenu!.hidden, "repeat click closes the open menu");
    await activate(mode); const reopened = shownMenus.at(-1)!; assert.equal(reopened.hidden, false);
    mode.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.ok(reopened.hidden); assert.ok(panel.isConnected); assert.equal(document.activeElement, mode);
    operator.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true }));
    const keyboardMenu = shownMenus.at(-1)!;
    assert.deepEqual(keyboardMenu.items.map((item) => item.checked), [false, false, true, false, false, false]);
    click(panel.querySelector(".tb-filter-close")!); assert.ok(keyboardMenu.hidden);
    assert.equal(ui.saved(), null, "opening, switching and cancellation never change filters");
  } finally {
    dom.window.removeEventListener("mousedown", hostDismiss); dom.window.removeEventListener("click", hostDismiss);
    ui.cleanup();
  }
});

test("[views][interaction] host Escape dismissal closes only the active filter submenu", () => {
  const ui = mount();
  const hostEscape = (event: KeyboardEvent) => {
    const menu = shownMenus.at(-1);
    if (event.key === "Escape" && menu && !menu.hidden) menu.hide();
  };
  dom.window.addEventListener("keydown", hostEscape, true);
  try {
    addFilterDraft(ui.root); const panel = document.querySelector<HTMLElement>(".tb-filter-popover")!;
    for (const selector of [".tb-filter-field", ".tb-filter-operator", ".tb-filter-mode"]) {
      const trigger = panel.querySelector<HTMLButtonElement>(selector)!; click(trigger);
      const menu = shownMenus.at(-1)!;
      trigger.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
      assert.ok(menu.hidden); assert.ok(panel.isConnected, "host-first dismissal must not also close the parent");
      assert.equal(document.activeElement, trigger); assert.equal(trigger.getAttribute("aria-expanded"), "false");
    }
    panel.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(panel.isConnected, false, "the next Escape closes the parent"); assert.equal(ui.saved(), null);
  } finally { dom.window.removeEventListener("keydown", hostEscape, true); ui.cleanup(); }
});

test("[views][storage] desktop relationship menus restore the saved label and check after failure", async () => {
  const table = fixture(); table.views[0].filters = filtersFor(table.fields[0].id, "Win");
  const source = JSON.stringify(table); const root = document.createElement("div"); document.body.append(root); let writes = 0;
  const controller = renderTable({ app: {} } as any, source, { root, sourcePath: `${table.tableId}.md`, save: async () => {
    writes++; throw new Error("External edit conflict");
  } });
  try {
    click(root.querySelector(".tb-filter-toggle")!); const panel = document.querySelector(".tb-filter-popover")!;
    const mode = panel.querySelector<HTMLButtonElement>(".tb-filter-mode")!;
    const input = panel.querySelector<HTMLInputElement>(".tb-filter-value")!;
    input.value = "unsaved"; input.dispatchEvent(new dom.window.Event("input"));
    selectFilterChoice(mode, t("Meet any condition")); await settle();
    assert.equal(writes, 1); assert.equal(mode.textContent, t("Meet all conditions")); assert.equal(mode.value, "and");
    assert.equal(document.activeElement, mode); assert.equal(input.value, "unsaved");
    assert.equal(panel.querySelector<HTMLInputElement>(".tb-filter-value"), input);
    click(mode); assert.deepEqual(shownMenus.at(-1)!.items.map((item) => item.checked), [true, false]);
    shownMenus.at(-1)!.items[0].action!({}); await settle();
    assert.equal(writes, 1, "reselecting the saved relationship does not write");
    click(mode); const menu = shownMenus.at(-1)!;
    root.dispatchEvent(new dom.window.MouseEvent("pointerdown", { bubbles: true }));
    assert.ok(menu.hidden); assert.equal(document.querySelector(".tb-filter-popover"), null);
  } finally { controller.destroy(); root.remove(); }
});

test("[views][interaction] desktop operator menus retain option validation and valueless predicates", async () => {
  const table = fixture(); const field = table.fields[1];
  table.views[0].filters = filtersFor(field.id, field.options!.map((option) => option.id), "contains");
  const ui = mount(table);
  try {
    click(ui.root.querySelector(".tb-filter-toggle")!); const panel = document.querySelector(".tb-filter-popover")!;
    click(panel.querySelector(".tb-filter-value-choice")!); const picker = document.querySelector(".tb-filter-values-menu")!;
    const operator = panel.querySelector<HTMLButtonElement>(".tb-filter-operator")!;
    click(operator); assert.equal(picker.isConnected, false, "opening an operator menu closes the value picker");
    const menu = shownMenus.at(-1)!; menu.items.find((item) => item.title === t("Equals"))!.action!({}); await settle();
    assert.ok(menu.hidden); assert.equal(ui.saved(), null, "narrowing several values to one leaves a draft");
    assert.equal(panel.querySelector(".tb-filter-selected-values")!.textContent, t("Choose options…"));
    assert.equal(document.activeElement, panel.querySelector(".tb-filter-operator"));
    selectFilterChoice(panel.querySelector(".tb-filter-operator")!, t("Is empty")); await settle();
    assert.equal(ui.saved()?.views[0].filters.conditions[0].operator, "isEmpty");
    assert.equal(panel.querySelector(".tb-filter-value-choice"), null); assert.ok(panel.isConnected);
  } finally { ui.cleanup(); }
});

test("[views][interaction] mobile filter fields keep native selection and the same draft validation", async () => {
  const previous = Platform.isMobile; Platform.isMobile = true;
  const table = fixture(); table.fields.push({ id: "n", name: "Number", type: "number" });
  const ui = mount(table);
  try {
    addFilterDraft(ui.root);
    const panel = document.querySelector(".tb-filter-popover")!;
    const field = panel.querySelector<HTMLSelectElement>("select.tb-filter-field")!;
    assert.ok(field); assert.equal(panel.querySelector("button.tb-filter-field"), null);
    assert.equal(panel.querySelectorAll("select").length, 3);
    assert.equal(panel.querySelectorAll(".tb-filter-menu-trigger").length, 0);
    field.value = "n"; field.dispatchEvent(new dom.window.Event("change")); await settle();
    assert.equal(panel.querySelector<HTMLInputElement>(".tb-filter-value")?.type, "number"); assert.equal(ui.saved(), null);
    const input = panel.querySelector<HTMLInputElement>(".tb-filter-value")!;
    input.value = "0"; input.dispatchEvent(new dom.window.Event("change")); await settle();
    assert.equal(ui.saved()?.views[0].filters.conditions[0].fieldId, "n");
    assert.equal(ui.saved()?.views[0].filters.conditions[0].value, 0);
    selectFilterChoice(panel.querySelector(".tb-filter-operator")!, t("Greater than")); await settle();
    assert.equal(ui.saved()?.views[0].filters.conditions[0].operator, "gt");
    selectFilterChoice(panel.querySelector(".tb-filter-mode")!, t("Meet any condition")); await settle();
    assert.equal(ui.saved()?.views[0].filters.mode, "or");
  } finally { ui.cleanup(); Platform.isMobile = previous; }
});

test("[views][interaction] incomplete numeric ranges keep the saved predicate and commit only valid complete input", async () => {
  const table = fixture(); const field: Field = { id: "n", name: "Number", type: "number" }; table.fields.push(field);
  table.records[0].values.n = 0; table.records[1].values.n = 10;
  table.views[0].filters = filtersFor("n", 0, "gte");
  const ui = mount(table);
  try {
    click(ui.root.querySelector(".tb-filter-toggle")!);
    const panel = document.querySelector(".tb-filter-popover")!;
    const op = panel.querySelector<HTMLButtonElement>(".tb-filter-operator")!; selectFilterChoice(op, t("Between")); await settle();
    assert.equal(ui.saved(), null); assert.equal(ui.root.querySelectorAll(".tb-data-row").length, 2);
    const upper = panel.querySelector<HTMLInputElement>('[data-bound="upper"]')!;
    upper.focus(); upper.value = "-1"; upper.dispatchEvent(new dom.window.Event("input")); upper.dispatchEvent(new dom.window.Event("change")); await settle();
    assert.equal(ui.saved(), null); assert.equal(ui.root.querySelectorAll(".tb-data-row").length, 2);
    assert.equal(panel.querySelector(".tb-filter-status")?.textContent, "");
    assert.equal(panel.querySelector<HTMLElement>(".tb-filter-status")?.hidden, true);
    upper.value = "0"; upper.dispatchEvent(new dom.window.Event("input")); upper.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await settle();
    assert.equal(ui.saved()?.views[0].filters.conditions[0].upper, 0);
    assert.equal(ui.root.querySelectorAll(".tb-data-row").length, 1); assert.equal(document.activeElement, upper); assert.equal(document.querySelector(".tb-filter-popover"), panel);
    upper.blur(); await settle();
    assert.equal(panel.querySelector(".tb-filter-status")?.textContent, "");
  } finally { ui.cleanup(); }
});

test("[views][interaction] option filtering keeps its searchable picker open across saves and Escape closes child first", async () => {
  const table = fixture(); const tags = table.fields[2];
  table.views[0].filters = filtersFor(tags.id, [tags.options![0].id]);
  const ui = mount(table);
  try {
    click(ui.root.querySelector(".tb-filter-toggle")!);
    const panel = document.querySelector(".tb-filter-popover")!; click(panel.querySelector(".tb-filter-value-choice")!);
    const picker = document.querySelector(".tb-filter-values-menu")!;
    const search = picker.querySelector<HTMLInputElement>("input")!; search.value = "B"; search.dispatchEvent(new dom.window.Event("input"));
    assert.equal(picker.querySelectorAll(".tb-filter-option").length, 1);
    click(picker.querySelector(".tb-filter-option")!); await settle();
    assert.equal(document.querySelector(".tb-filter-values-menu"), picker); assert.equal(search.value, "B");
    assert.deepEqual(ui.saved()?.views[0].filters.conditions[0].value, tags.options!.map((item) => item.id));
    document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
    assert.equal(document.querySelector(".tb-filter-values-menu"), null); assert.equal(document.querySelector(".tb-filter-popover"), panel);
    document.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); assert.equal(document.querySelector(".tb-filter-popover"), null);
  } finally { ui.cleanup(); }
});

test("[views][layout] filter options flip above a lower-edge trigger and stay inside the visual viewport", () => {
  const table = fixture(); const field = table.fields[2];
  table.views[0].filters = filtersFor(field.id, [field.options![0].id]);
  const previousViewport = Object.getOwnPropertyDescriptor(dom.window, "visualViewport");
  const originalRect = dom.window.HTMLElement.prototype.getBoundingClientRect;
  const viewport = Object.assign(new dom.window.EventTarget(), { offsetLeft: 20, offsetTop: 100, width: 500, height: 400 });
  const rect = (left: number, top: number, width: number, height: number) => ({ left, top, right: left + width, bottom: top + height, width, height, x: left, y: top, toJSON() {} }) as DOMRect;
  Object.defineProperty(dom.window, "visualViewport", { configurable: true, value: viewport });
  dom.window.HTMLElement.prototype.getBoundingClientRect = function () {
    if (this.matches(".tb-filter-value-choice")) return rect(440, 420, 60, 32);
    if (this.matches(".tb-filter-values-menu")) return rect(Number.parseFloat(this.style.left) || 0, Number.parseFloat(this.style.top) || 0, Number.parseFloat(this.style.width) || 240, Math.min(220, Number.parseFloat(this.style.maxHeight) || 220));
    return originalRect.call(this);
  };
  const ui = mount(table);
  try {
    click(ui.root.querySelector(".tb-filter-toggle")!);
    const panel = document.querySelector(".tb-filter-popover")!;
    const trigger = panel.querySelector<HTMLElement>(".tb-filter-value-choice")!;
    click(trigger);
    const picker = document.querySelector<HTMLElement>(".tb-filter-values-menu")!;
    let bounds = picker.getBoundingClientRect();
    assert.ok(bounds.bottom <= trigger.getBoundingClientRect().top - 8, "the picker opens above instead of covering the lower-edge trigger");
    assert.ok(bounds.left >= viewport.offsetLeft + 16 && bounds.right <= viewport.offsetLeft + viewport.width - 16);
    assert.ok(bounds.top >= viewport.offsetTop + 16);
    viewport.height = 800; viewport.dispatchEvent(new dom.window.Event("resize"));
    bounds = picker.getBoundingClientRect();
    assert.ok(bounds.top >= trigger.getBoundingClientRect().bottom + 8, "the picker returns below when the viewport has space");
    assert.ok(bounds.bottom <= viewport.offsetTop + viewport.height - 16);
    assert.equal(ui.saved(), null, "positioning a picker never changes filter values");
  } finally {
    ui.cleanup(); dom.window.HTMLElement.prototype.getBoundingClientRect = originalRect;
    if (previousViewport) Object.defineProperty(dom.window, "visualViewport", previousViewport);
    else Reflect.deleteProperty(dom.window, "visualViewport");
  }
});

test("[views][storage] filter edits rebind to a recreated renderer without losing input, picker or draft state", async () => {
  const table = fixture(); delete table.views[0].group; delete table.views[0].sort;
  const name = table.fields[0]; const tags = table.fields[2];
  table.views[0].filters = { mode: "and", conditions: [
    { id: "name-filter", fieldId: name.id, operator: "contains", value: "Win" },
    { id: "tags-filter", fieldId: tags.id, operator: "contains", value: [tags.options![0].id] },
  ] };
  let source = JSON.stringify(table); let saves = 0;
  let active: { root: HTMLElement; controller: ReturnType<typeof renderTable> };
  const create = (body: string) => {
    const root = document.createElement("div"); document.body.append(root);
    const controller = renderTable({ app: {} } as any, body, { root, sourcePath: `${table.tableId}.md`, save: async (expected, next) => {
      assert.equal(expected, source); source = JSON.stringify(next); saves++;
      active.controller.destroy(); active.root.remove(); active = create(source); return source;
    } });
    return { root, controller };
  };
  active = create(source);
  try {
    click(active.root.querySelector(".tb-filter-toggle")!);
    const panel = document.querySelector(".tb-filter-popover")!;
    const input = panel.querySelector<HTMLInputElement>(".tb-filter-value")!;
    input.focus(); input.value = "IINA"; input.dispatchEvent(new dom.window.Event("change")); await settle();
    assert.equal(saves, 1); assert.equal(document.activeElement, input); assert.equal(document.querySelector(".tb-filter-popover"), panel);
    input.dispatchEvent(new dom.window.Event("blur")); await settle(); assert.equal(saves, 1, "unchanged blur does not save again");
    input.value = ""; input.dispatchEvent(new dom.window.Event("input"));
    click(panel.querySelector(".tb-filter-value-choice")!);
    const picker = document.querySelector(".tb-filter-values-menu")!;
    click(picker.querySelectorAll(".tb-filter-option")[1]); await settle();
    assert.equal(saves, 2); assert.equal(document.querySelector(".tb-filter-values-menu"), picker); assert.equal(input.value, "");
    const stored = readTable(source); assert.equal(stored.views[0].filters.conditions[0].value, "IINA");
    assert.equal(stored.views[0].filters.conditions[1].value?.length, 2);
    click(panel.querySelector(".tb-filter-close")!); assert.equal(document.querySelector(".tb-filter-popover"), null);
  } finally { click(active.root.querySelector(".tb-filter-toggle")!); if (document.querySelector(".tb-filter-popover")) click(active.root.querySelector(".tb-filter-toggle")!); active.controller.destroy(); active.root.remove(); }
});

test("[views][storage] failed filter writes keep old rows and retain input for retry", async () => {
  const table = fixture(); delete table.views[0].sort; delete table.views[0].group;
  table.views[0].filters = filtersFor(table.fields[0].id, "Win");
  const root = document.createElement("div"); document.body.append(root); let fail = true; let source = JSON.stringify(table); let attempts = 0;
  const controller = renderTable({ app: {} } as any, source, { root, sourcePath: `${table.tableId}.md`, save: async (expected, next) => {
    attempts++; assert.equal(expected, source); if (fail) throw new Error("External edit conflict"); source = JSON.stringify(next); return source;
  } });
  try {
    click(root.querySelector(".tb-filter-toggle")!); const panel = document.querySelector(".tb-filter-popover")!;
    const input = panel.querySelector<HTMLInputElement>(".tb-filter-value")!; input.value = "IINA"; input.dispatchEvent(new dom.window.Event("change")); await settle();
    assert.equal(attempts, 1); assert.equal(readTable(source).views[0].filters.conditions[0].value, "Win");
    assert.ok(root.querySelector(".tb-data-row")?.textContent?.includes("WinMTR"));
    assert.equal(input.value, "IINA"); assert.ok(panel.querySelector(".tb-filter-status")?.textContent?.includes("Could not save"));
    assert.equal(panel.querySelector<HTMLElement>(".tb-filter-status")?.hidden, false);
    fail = false; input.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); await settle();
    assert.equal(attempts, 2); assert.equal(readTable(source).views[0].filters.conditions[0].value, "IINA");
    assert.equal(panel.querySelector<HTMLElement>(".tb-filter-status")?.hidden, true);
    assert.ok(root.querySelector(".tb-data-row")?.textContent?.includes("IINA"));
  } finally { click(root.querySelector(".tb-filter-toggle")!); controller.destroy(); root.remove(); }
});

test("[views] the popover adds repeated fields, switches AND/OR and deletes or clears immediately", async () => {
  const ui = mount();
  try {
    addFilterDraft(ui.root);
    const panel = document.querySelector(".tb-filter-popover")!;
    const input = panel.querySelector<HTMLInputElement>(".tb-filter-value")!;
    input.value = "WinMTR"; input.dispatchEvent(new dom.window.Event("change")); await settle();
    click(panel.querySelector(".tb-filter-add")!); const second = panel.querySelectorAll<HTMLInputElement>(".tb-filter-value")[1];
    second.value = "IINA"; second.dispatchEvent(new dom.window.Event("change")); await settle();
    assert.equal(ui.root.querySelectorAll(".tb-data-row").length, 0);
    const mode = panel.querySelector<HTMLButtonElement>(".tb-filter-mode")!; selectFilterChoice(mode, t("Meet any condition")); await settle();
    assert.equal(ui.saved()?.views[0].filters.mode, "or"); assert.equal(ui.root.querySelectorAll(".tb-data-row").length, 2);
    click(panel.querySelector(".tb-filter-remove")!); await settle();
    assert.equal(ui.saved()?.views[0].filters.conditions.length, 1); assert.equal(ui.root.querySelectorAll(".tb-data-row").length, 1);
    click(panel.querySelector(".tb-filter-clear")!); await settle(); assert.equal(ui.saved()?.views[0].filters.conditions.length, 0);
    assert.equal(ui.root.querySelectorAll(".tb-data-row").length, 2); assert.ok(panel.isConnected);
  } finally { ui.cleanup(); }
});

test("[views][layout][localization] filter controls use accessible labels without hover-tooltip attributes in both languages", () => {
  for (const language of ["en", "zh-CN"]) {
    setLanguage(language); const ui = mount();
    try {
      addFilterDraft(ui.root);
      const panel = document.querySelector<HTMLElement>(".tb-filter-popover")!;
      assert.equal(panel.querySelector("[title], [aria-label]"), null);
      for (const input of panel.querySelectorAll("input,select")) {
        const label = input.getAttribute("aria-labelledby"); assert.ok(label); assert.ok(document.getElementById(label!)?.textContent);
      }
      assert.ok(panel.textContent?.includes(t("Meet all conditions")));
    } finally { ui.cleanup(); setLanguage("en"); }
  }
});

test("[layout][views][fields][attachments] hidden accessible labels stay associated and clipped in real UI DOM", async () => {
  const style = document.createElement("style"); style.textContent = readFileSync("styles.css", "utf8"); document.head.append(style);
  const assertHiddenLabel = (control: Element, expectedText?: string) => {
    const ids = control.getAttribute("aria-labelledby")?.trim().split(/\s+/).filter(Boolean) ?? [];
    assert.ok(ids.length, "the control references its accessible label");
    const labels = ids.map((id) => document.getElementById(id));
    const label = labels.find((element) => element?.classList.contains("tb-sr-only"));
    assert.ok(label, "the reference resolves to a real sr-only label");
    if (expectedText) assert.equal(label.textContent, expectedText);
    assert.equal(label.isConnected, true);
    assert.equal(label.hidden, false);
    assert.notEqual(label.getAttribute("aria-hidden"), "true");
    const computed = dom.window.getComputedStyle(label);
    assert.equal(computed.position, "absolute");
    assert.notEqual(computed.display, "none");
    assert.notEqual(computed.visibility, "hidden");
    assert.equal(computed.width, "1px"); assert.equal(computed.height, "1px");
    assert.equal(computed.overflow, "hidden");
    assert.match(computed.clip, /rect\(/); assert.equal(computed.clipPath, "", "the accessible label remains clipped without clip-path");
  };
  try {
    const prompt = promptForm({} as any, "Rename view", [{ label: "View name", value: "Draft" }], undefined, { hideSingleFieldLabel: true });
    try {
      const form = document.querySelector<HTMLFormElement>(".tb-dialog form")!;
      const input = form.querySelector<HTMLInputElement>("input")!;
      assertHiddenLabel(input, "View name");
      form.dispatchEvent(new dom.window.Event("submit", { bubbles: true, cancelable: true }));
      assert.deepEqual(await prompt, ["Draft"]);
    } finally { document.querySelector<HTMLButtonElement>(".modal-close-button")?.click(); }

    const filtered = mount();
    try {
      addFilterDraft(filtered.root);
      const panel = document.querySelector<HTMLElement>(".tb-filter-popover")!;
      for (const selector of [".tb-filter-field", ".tb-filter-operator", ".tb-filter-mode"]) {
        assertHiddenLabel(panel.querySelector(selector)!);
      }
    } finally { filtered.cleanup(); }

    const table = fixture();
    table.fields.push({ id: "sr-date", name: "Date", type: "date" });
    table.records[0].values["sr-date"] = "2026-10-07";
    const dated = mount(table);
    try {
      const cell = dated.root.querySelector<HTMLTableCellElement>('td[data-field-id="sr-date"]')!;
      click(cell); click(byLabel(cell, "Edit Date"));
      assertHiddenLabel(cell.querySelector(".tb-date-input")!, "Date value");
      assertHiddenLabel(cell.querySelector(".tb-cell-action")!, "Choose date for Date");
    } finally { dated.cleanup(); }

    const attached = mountAttachmentTable();
    try {
      pointerClick(attached.cell); pointerClick(attached.cell);
      const close = document.querySelector<HTMLElement>(".tb-attachment-popover .tb-attachment-close")!;
      assertHiddenLabel(close, "Close attachments");
    } finally { attached.cleanup(); }
  } finally { style.remove(); }
});

test("[views][storage] rapid option and relationship reversals are evaluated against the queued saved state", async () => {
  const table = fixture(); delete table.views[0].sort; delete table.views[0].group;
  const tags = table.fields[2]; table.views[0].filters = filtersFor(tags.id, [tags.options![0].id]);
  const root = document.createElement("div"); document.body.append(root); let source = JSON.stringify(table); let writes = 0;
  const controller = renderTable({ app: {} } as any, source, { root, sourcePath: `${table.tableId}.md`, save: async (expected, next) => {
    assert.equal(expected, source); await new Promise((resolve) => setTimeout(resolve, 10)); writes++; source = JSON.stringify(next); return source;
  } });
  try {
    click(root.querySelector(".tb-filter-toggle")!); const panel = document.querySelector(".tb-filter-popover")!;
    click(panel.querySelector(".tb-filter-value-choice")!);
    const chooseB = () => document.querySelectorAll(".tb-filter-option")[1];
    click(chooseB()); click(chooseB());
    await waitForCondition(() => writes === 2, "both queued option reversals");
    assert.deepEqual(readTable(source).views[0].filters.conditions[0].value, [tags.options![0].id]);
    const mode = panel.querySelector<HTMLButtonElement>(".tb-filter-mode")!;
    selectFilterChoice(mode, t("Meet any condition")); selectFilterChoice(mode, t("Meet all conditions"));
    await waitForCondition(() => writes === 4, "both queued relation reversals");
    assert.equal(readTable(source).views[0].filters.mode, "and");
    selectFilterChoice(mode, t("Meet all conditions")); await settle(); assert.equal(writes, 4, "unchanged settings do not write");
  } finally { click(root.querySelector(".tb-filter-toggle")!); controller.destroy(); root.remove(); }
});

test("[views][interaction] detached filter sessions close their panel and picker without a replacement controller", async () => {
  const table = fixture(); const field = table.fields[2]; table.views[0].filters = filtersFor(field.id, [field.options![0].id]);
  const ui = mount(table);
  click(ui.root.querySelector(".tb-filter-toggle")!); click(document.querySelector(".tb-filter-value-choice")!);
  assert.ok(document.querySelector(".tb-filter-values-menu"));
  ui.controller.destroy(); ui.root.remove();
  await new Promise((resolve) => setTimeout(resolve, 275));
  assert.equal(document.querySelector(".tb-filter-popover"), null); assert.equal(document.querySelector(".tb-filter-values-menu"), null);
});

test("[views] duplicated views retain independent conditions and AND/OR mode", async () => {
  const table = fixture(); table.views[0].filters = filtersFor(table.fields[0].id, "Win"); table.views[0].filters.mode = "or";
  const ui = mount(table);
  try {
    click(ui.root.querySelector(".tb-view-menu-button")!);
    await shownMenus.at(-1)!.items.find((item) => item.title === t("Duplicate view"))!.action!({}); await settle();
    const saved = ui.saved()!; assert.equal(saved.views.length, 2);
    assert.deepEqual(saved.views[1].filters, table.views[0].filters);
    click(ui.root.querySelector(".tb-filter-toggle")!); click(document.querySelector(".tb-filter-clear")!); await settle();
    assert.equal(ui.saved()?.views[1].filters.conditions.length, 0);
    assert.deepEqual(ui.saved()?.views[0].filters, table.views[0].filters);
  } finally { ui.cleanup(); }
});

test("[fields][views] single-select to multi-select retains all typed conditions across views", async () => {
  const table = fixture(); const field = table.fields[1];
  table.views[0].filters = { mode: "or", conditions: [
    { id: "eq", fieldId: field.id, operator: "eq", value: [field.options![0].id] },
    { id: "contains", fieldId: field.id, operator: "contains", value: field.options!.map((option) => option.id) },
  ] };
  table.views.push({ id: "another", name: "Another", filters: filtersFor(field.id, [field.options![1].id], "neq") });
  const ui = mount(table);
  try {
    click(ui.root.querySelectorAll(".tb-header-menu")[1]);
    shownMenus.at(-1)!.items.find((item) => item.title === "Edit column")!.action!({});
    click(document.querySelector(".tb-field-type-selector")!);
    [...document.querySelectorAll<HTMLElement>(".tb-field-type-option")].find((item) => item.textContent?.includes(t("Multi-select")))!.click();
    click(byEditorName(document.body, "Save")); await settle();
    assert.equal(ui.saved()?.fields[1].type, "multiselect");
    assert.deepEqual(ui.saved()?.views.map((view) => view.filters), table.views.map((view) => view.filters));
    const normalized = readTable(JSON.stringify(ui.saved()));
    assert.equal(filterAndSortRows(normalized, normalized.views[0]).length, 2);
  } finally { ui.cleanup(); }
});

test("[data-format] the public Skill example uses the current filter shape with schema version one", () => {
  for (const path of ["SKILL.md"]) {
    const source = readFileSync(path, "utf8"); let count = 0;
    for (const match of source.matchAll(/```super-table\n([\s\S]*?)```/g)) {
      const table = readTable(match[1]); count++;
      assert.equal(table.schemaVersion, 1);
      assert.ok(table.views.every((view) => ["and", "or"].includes(view.filters.mode) && Array.isArray(view.filters.conditions)), path);
    }
    assert.ok(count > 0, path);
  }
});

test("[data-format] the public Skill filter example resolves its fields and applies its numeric range", () => {
  const source = readFileSync("SKILL.md", "utf8");
  const block = scanFencedBlocks(source).find((candidate) => candidate.language === "super-table");
  assert.ok(block);
  const table = readTable(block.body);
  const example = source.match(/`(\{"mode":"(?:and|or)","conditions":\[\{[^`\n]+\}\]\})`/);
  assert.ok(example);
  const filters = JSON.parse(example[1]) as FilterGroup;
  for (const condition of filters.conditions) {
    const field = table.fields.find((candidate) => candidate.id === condition.fieldId);
    assert.ok(field, `Skill filter references an undefined field: ${condition.fieldId}`);
    assert.ok(validFilterCondition(condition, field));
    if (Array.isArray(condition.value)) {
      for (const optionId of condition.value) assert.ok(field.options?.some((option) => option.id === optionId));
    }
  }
  table.views[0].filters = filters;
  const originalRows = filterAndSortRows(table, table.views[0]).map((row) => row.id);
  assert.ok(originalRows.length > 0);
  const range = filters.conditions.find((condition) => condition.operator === "between" && typeof condition.upper === "number");
  assert.ok(range && typeof range.upper === "number");
  const outside = structuredClone(table.records.find((row) => row.id === originalRows[0])!);
  outside.id = "skill-outside-range";
  outside.values[range.fieldId] = range.upper + 1;
  table.records.push(outside);
  assert.deepEqual(filterAndSortRows(table, table.views[0]).map((row) => row.id), originalRows);
});

test("[data-format] malformed typed filter operands are rejected before tables become editable", () => {
  const cases: Array<[Field, Partial<FilterCondition>]> = [
    [{ id: "f", name: "Number", type: "number" }, { operator: "eq", value: "0" }],
    [{ id: "f", name: "Number", type: "number" }, { operator: "between", value: 0 }],
    [{ id: "f", name: "Number", type: "number" }, { operator: "between", value: 1, upper: 0 }],
    [{ id: "f", name: "Number", type: "number" }, { operator: "eq", value: Infinity }],
    [{ id: "f", name: "Select", type: "select", options: [] }, { operator: "eq", value: ["a", "b"] }],
    [{ id: "f", name: "Tags", type: "multiselect", options: [] }, { operator: "contains", value: ["a", "a"] }],
    [{ id: "f", name: "Tags", type: "multiselect", options: [] }, { operator: "contains", value: [] }],
    [{ id: "f", name: "Date", type: "date", dateFormat: "iso-date" }, { operator: "eq", value: "2026-02-30" }],
    [{ id: "f", name: "Time", type: "date", dateFormat: "time" }, { operator: "eq", value: "24:00" }],
    [{ id: "f", name: "Date time", type: "date", dateFormat: "iso-datetime" }, { operator: "eq", value: "2026-10-15 09:30" }],
    [{ id: "f", name: "Attachments", type: "attachment" }, { operator: "contains", value: "file" }],
  ];
  for (const [field, condition] of cases) {
    const table = { schemaVersion: 1, tableId: "invalid-condition", fields: [field], records: [], views: [{ id: "all", name: "All", filters: { mode: "and", conditions: [{ id: "rule", fieldId: "f", ...condition }] } }], defaultViewId: "all" };
    const source = JSON.stringify(table); assert.throws(() => readTable(source), /filters.conditions\[0\]/); assert.equal(JSON.stringify(table), source);
  }
});

function searchTable(root: HTMLElement, query: string): HTMLInputElement {
  if (!root.querySelector('.tb-search-input')) click(root.querySelector('.tb-search-toggle')!);
  const input = root.querySelector<HTMLInputElement>('.tb-search-input')!;
  input.focus(); input.value = query;
  input.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true }));
  return root.querySelector<HTMLInputElement>('.tb-search-input')!;
}

test("[layout][search] viewport takeover survives controller replacement and stays isolated between note panes", () => {
  const firstPane = document.createElement("div"); const secondPane = document.createElement("div");
  document.body.append(firstPane, secondPane);
  const oldRoot = document.createElement("div"); firstPane.append(oldRoot);
  const calls: string[] = [];
  const releaseFirst = registerViewportRestoration(firstPane, "save", () => { calls.push("first"); releaseFirst(); });
  const releaseSecond = registerViewportRestoration(secondPane, "history", () => { calls.push("second"); releaseSecond(); });
  try {
    const replacement = document.createElement("div"); oldRoot.replaceWith(replacement);
    cancelViewportRestorations(replacement);
    assert.deepEqual(calls, ["first"]);
    cancelViewportRestorations(replacement); assert.deepEqual(calls, ["first"], "cancelled tasks unregister themselves");
    cancelViewportRestorations(secondPane); assert.deepEqual(calls, ["first", "second"]);
  } finally { releaseFirst(); releaseSecond(); firstPane.remove(); secondPane.remove(); }
});

for (const mode of ["live-preview", "reading"] as const) for (const operation of ["save", "undo", "redo", "native-undo", "native-redo"] as const) {
  if (mode === "reading" && operation.startsWith("native")) continue;
  test(`[search][storage][layout] ${mode} search takes over pending ${operation} restoration across controller replacement`, async () => {
    const table = fixture(); delete table.views[0].sort; delete table.views[0].group;
    table.records = Array.from({ length: 40 }, (_, index) => ({
      id: `row-${index}`, values: { ...table.records[0].values, [table.fields[0].id]: index === 39 ? "search target" : `Item ${index}` },
    }));
    const path = `${mode}-${operation}.md`;
    const scroller = document.createElement("div"); scroller.style.overflowY = "auto"; scroller.style.overflowX = "auto";
    Object.defineProperties(scroller, {
      clientHeight: { value: 600 }, scrollHeight: { value: 3000 }, clientWidth: { value: 800 }, scrollWidth: { value: 2000 },
    });
    scroller.scrollTop = 120; scroller.scrollLeft = 30; document.body.append(scroller);
    const prototype = dom.window.HTMLElement.prototype;
    const originalRect = prototype.getBoundingClientRect;
    const originalScroll = Object.getOwnPropertyDescriptor(prototype, "scrollIntoView");
    const rect = (top: number, height = 40) => ({ top, bottom: top + height, left: 0, right: 800, width: 800, height, x: 0, y: top, toJSON() {} }) as DOMRect;
    let root: HTMLElement;
    let layoutShift = 0;
    prototype.getBoundingClientRect = function () {
      if (this === scroller) return rect(0, 600);
      if (root && (this === root || root.contains(this))) {
        const row = this.closest<HTMLElement>("tr.tb-data-row");
        const index = row ? [...root.querySelectorAll("tr.tb-data-row")].indexOf(row) : -1;
        return rect(140 + Math.max(index, 0) * 40 + layoutShift - scroller.scrollTop);
      }
      return originalRect.call(this);
    };
    let revealCount = 0;
    Object.defineProperty(prototype, "scrollIntoView", { configurable: true, value(this: HTMLElement) {
      if (!this.matches(".is-search-current")) return;
      revealCount++; scroller.scrollTop = 1360 + layoutShift; scroller.scrollLeft = 250;
      scroller.dispatchEvent(new dom.window.Event("scroll"));
    } });
    const original = serializeTable(table);
    let note = original;
    let edited = "";
    let cleanup = () => {};
    let tracker: ReturnType<typeof trackLivePreviewHistoryViewport> | undefined;
    let applyHistory: (text: string) => void;
    const noteView = { file: { path }, getMode: () => mode === "reading" ? "preview" : "source", containerEl: scroller,
      editor: { undo: () => applyHistory(original), redo: () => applyHistory(edited) } };
    const plugin = { app: {
      workspace: { getActiveViewOfType: () => noteView },
      vault: { getAbstractFileByPath: () => new TFile(path), process: async (_file: unknown, update: (text: string) => string) => {
        note = update(note); replaceReadingRoot();
      } },
    } } as any;
    const replaceReadingRoot = () => {
      const replacement = document.createElement("div");
      if (root) { cleanup(); root.replaceWith(replacement); } else scroller.append(replacement);
      root = replacement;
      const controller = renderTable(plugin, scanFencedBlocks(note)[0].body, { root, sourcePath: path });
      cleanup = () => controller.destroy();
    };
    const frames = async () => { for (let i = 0; i < 3; i++) await new Promise<void>((resolve) => dom.window.requestAnimationFrame(() => resolve())); };
    try {
      if (mode === "live-preview") {
        const extension = tableEditorExtension(plugin) as any[]; const field = extension[0];
        let state = EditorState.create({ doc: note, extensions: [editorInfoField.init(() => ({ file: { path } })), editorLivePreviewField, extension] });
        const editor = { dom: scroller, scrollDOM: scroller, get state() { return state; }, requestMeasure() {},
          dispatch(spec: any) { const before = state.doc.toString(); state = state.update(spec).state; note = state.doc.toString(); tracker?.onDocumentChange(before, note, path, true); },
        };
        const mountWidget = () => {
          let widget: any;
          state.field(field).between(0, state.doc.length, (_from: number, _to: number, decoration: any) => { widget = decoration.spec.widget; });
          const replacement = widget.toDOM(editor);
          if (root) { cleanup(); root.replaceWith(replacement); } else scroller.append(replacement);
          root = replacement; cleanup = () => widget.destroy();
        };
        mountWidget();
        tracker = trackLivePreviewHistoryViewport(plugin.app, path, editor as any);
        applyHistory = (text) => {
          const before = note; state = state.update({ changes: { from: 0, to: state.doc.length, insert: text } }).state;
          note = text; mountWidget(); tracker!.onDocumentChange(before, text, path, true);
        };
      } else {
        replaceReadingRoot();
        const hiddenSource = document.createElement("div"); hiddenSource.className = "markdown-source-view";
        hiddenSource.style.display = "none"; hiddenSource.append(root!.cloneNode(true)); scroller.prepend(hiddenSource);
      }
      await editTextCell(root!, "edited first row"); edited = note;
      assert.notEqual(edited, original, "the edit must actually save before checking navigation");
      if (operation !== "save") {
        await frames();
        const history = async (redo: boolean) => {
          if (operation.startsWith("native")) applyHistory(redo ? edited : original);
          else {
            const cell = root!.querySelector<HTMLTableCellElement>("td.tb-cell")!; pointerClick(cell);
            cell.dispatchEvent(new dom.window.KeyboardEvent("keydown", { key: "z", metaKey: true, shiftKey: redo, bubbles: true, cancelable: true }));
          }
          await waitForCondition(() => note === (redo ? edited : original), "history applies the expected document");
        };
        await history(false);
        if (operation.endsWith("redo")) await history(true);
      }
      await frames();
      assert.equal(scroller.scrollTop, 120, "editing and history preserve the viewport before explicit navigation");
      assert.equal(scroller.scrollLeft, 30);
      layoutShift = 80;
      root!.querySelector("td.tb-cell")!.append(document.createTextNode("changed row height"));
      await frames();
      assert.equal(scroller.scrollTop, operation.startsWith("native") ? 120 : 200,
        "focused editing/history follows its cell anchor; native history keeps the note offset");
      // Keyboard activation and typing do not emit pointerdown, unlike a mouse search.
      const input = searchTable(root!, "search target");
      await frames();
      assert.ok(revealCount > 0);
      assert.equal(scroller.scrollTop, 1440, "pending save/history must not override explicit search navigation");
      assert.equal(scroller.scrollLeft, 250, "horizontal navigation must also take over restoration");
      root!.querySelector("td.tb-cell")!.append(document.createTextNode("late Markdown render"));
      await frames();
      assert.equal(scroller.scrollTop, 1440, "late rendering must not reactivate the old anchor");
      assert.equal(scroller.scrollLeft, 250);
      assert.equal(document.activeElement, input);
      assert.equal(note, operation.endsWith("undo") ? original : edited, "search must not write to the note");
      layoutShift += 300;
      root!.querySelector("td.tb-cell")!.append(document.createTextNode("late Markdown height increase"));
      await frames();
      assert.equal(scroller.scrollTop, 1740, "search follows its target after lazy Markdown changes row heights");
      scroller.dispatchEvent(new dom.window.Event("wheel", { bubbles: true }));
      scroller.scrollTop = 1800; layoutShift += 100;
      root!.querySelector("td.tb-cell")!.append(document.createTextNode("render after user scrolling"));
      await frames();
      assert.equal(scroller.scrollTop, 1800, "user scrolling cancels search layout following");
    } finally {
      document.body.dispatchEvent(new dom.window.Event("pointerdown", { bubbles: true }));
      tracker?.destroy(); cleanup(); scroller.remove(); prototype.getBoundingClientRect = originalRect;
      if (originalScroll) Object.defineProperty(prototype, "scrollIntoView", originalScroll);
      else delete (prototype as HTMLElement & { scrollIntoView?: () => void }).scrollIntoView;
    }
  });
}

test('[search] matching uses labels, raw text, paths, numbers and displayed or stored dates once per cell', () => {
  const fields: Field[] = [
    { id: 'text', name: 'Hidden field name', type: 'text' },
    { id: 'choice', name: 'Choice', type: 'select', options: [{ id: 'opaque-option', label: '待处理', color: 'gray' }] },
    { id: 'multi', name: 'Multi', type: 'multiselect', options: [{ id: 'opaque-multi', label: 'Apple', color: 'gray' }] },
    { id: 'date', name: 'Date', type: 'date', dateFormat: 'month-day' },
    { id: 'number', name: 'Number', type: 'number' },
    { id: 'files', name: 'Files', type: 'attachment' },
    { id: 'link', name: 'Link', type: 'link' },
    { id: 'checked', name: 'Checked', type: 'checkbox' },
  ];
  const rows = [{ id: 'opaque-row', values: {
    text: '**Apple** Apple 中文', choice: 'opaque-option', multi: ['opaque-multi'], date: '2026-10-20',
    number: 0, files: ['Assets/Report.pdf'], link: '[Home](https://example.com)', checked: true,
  } }];
  const found = (query: string) => findCells(rows, fields, query).map((cell) => cell.fieldId);
  assert.deepEqual(found('APPLE'), ['text', 'multi']);
  assert.deepEqual(found('中文'), ['text']); assert.deepEqual(found('待处理'), ['choice']);
  assert.deepEqual(found('2026'), ['date']); assert.deepEqual(found('10-20'), ['date']);
  assert.ok(found('0').includes('number')); assert.deepEqual(found('report.PDF'), ['files']);
  assert.deepEqual(found('example.com'), ['link']); assert.deepEqual(found('Home'), ['link']);
  assert.deepEqual(found('opaque'), []); assert.deepEqual(found('Hidden field name'), []);
  assert.deepEqual(found('true'), []); assert.deepEqual(found(''), []);
});

test('[search][views] search excludes filtered rows and hidden fields and leaves the grid and document intact', async () => {
  const table = fixture(); const [name, platform] = table.fields;
  table.views[0].filters = filtersFor(name.id, 'Win');
  table.views[0].visibleFieldIds = [name.id];
  const ui = mount(table);
  try {
    click(ui.root.querySelector('.tb-search-toggle')!);
    const grid = ui.root.querySelector('.tb-grid'); const rowCount = ui.root.querySelectorAll('.tb-data-row').length;
    searchTable(ui.root, 'Win');
    assert.equal(ui.root.querySelectorAll('.is-search-match').length, 1);
    assert.equal(ui.root.querySelector('.tb-search-status')?.textContent, '1 / 1 cells');
    assert.equal(ui.root.querySelector('.tb-grid'), grid, 'typing does not rebuild the grid');
    assert.equal(ui.root.querySelectorAll('.tb-data-row').length, rowCount, 'search does not filter rows');
    searchTable(ui.root, 'IINA'); assert.equal(ui.root.querySelectorAll('.is-search-match').length, 0);
    searchTable(ui.root, platform.options![0].label); assert.equal(ui.root.querySelectorAll('.is-search-match').length, 0);
    assert.equal(ui.root.querySelector('.tb-search-status')?.textContent, 'No matches in this view');
    await settle(); assert.equal(ui.saved(), null, 'opening, searching and navigating never saves');
    click(ui.root.querySelector('.tb-search-close')!);
    assert.equal(ui.root.querySelector('.tb-search-bar'), null);
    assert.equal(document.activeElement, ui.root.querySelector('.tb-search-toggle'));
  } finally { ui.cleanup(); }
});

test('[search][interaction] navigation follows displayed rows and columns, wraps, scrolls and preserves query focus', async () => {
  const table = fixture(); table.records.forEach((row) => { row.values[table.fields[0].id] = 'find find'; });
  table.fields.push({ id: 'more', name: 'More', type: 'text' });
  table.records.forEach((row) => { row.values.more = 'FIND'; });
  table.views[0].sort = { fieldId: table.fields[1].id, direction: 'asc' };
  delete table.views[0].group;
  const ui = mount(table, true);
  const prototype = HTMLElement.prototype;
  const descriptor = Object.getOwnPropertyDescriptor(prototype, 'scrollIntoView');
  const scrolled: Array<{ cell: HTMLElement; options: ScrollIntoViewOptions }> = [];
  Object.defineProperty(prototype, 'scrollIntoView', { configurable: true, value(this: HTMLElement, options: ScrollIntoViewOptions) { scrolled.push({ cell: this, options }); } });
  try {
    const input = searchTable(ui.root, 'find');
    const expected = filterAndSortRows(table, table.views[0]).flatMap((row) => [table.fields[0].id, 'more'].map((fieldId) => [row.id, fieldId]));
    const current = () => { const cell = ui.root.querySelector<HTMLElement>('.is-search-current')!; return [cell.parentElement!.dataset.rowId, cell.dataset.fieldId]; };
    assert.deepEqual(current(), expected[0]); assert.equal(ui.root.querySelector('.tb-search-status')?.textContent, '1 / 4 cells');
    for (let i = 1; i <= 4; i++) {
      input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
      assert.deepEqual(current(), expected[i % 4]);
    }
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', shiftKey: true, bubbles: true }));
    assert.deepEqual(current(), expected[3]); assert.equal(document.activeElement, input);
    const nativeFind = new dom.window.KeyboardEvent('keydown', { key: 'f', ctrlKey: true, bubbles: true, cancelable: true });
    input.dispatchEvent(nativeFind); assert.equal(nativeFind.defaultPrevented, false);
    await settle(); assert.equal(scrolled.at(-1)?.cell.dataset.fieldId, 'more');
    assert.equal(scrolled.at(-1)?.options.inline, 'nearest');
    assert.match(scrolled.at(-1)!.cell.style.scrollMarginTop, /px$/);
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    assert.equal(ui.root.querySelector('.is-search-current'), null);
  } finally {
    ui.cleanup(); if (descriptor) Object.defineProperty(prototype, 'scrollIntoView', descriptor);
    else delete (prototype as any).scrollIntoView;
  }
});

test('[search][views] folded groups participate in search and temporary expansion restores on close', () => {
  const table = fixture(); const view = table.views[0];
  delete view.sort; view.group = { fieldId: table.fields[1].id, direction: 'asc' };
  const ui = mount(table, true);
  try {
    [...ui.root.querySelectorAll('.tb-group-row')].forEach((line) => click(line));
    assert.equal(ui.root.querySelectorAll('.tb-data-row').length, 0);
    const input = searchTable(ui.root, 'IINA');
    assert.equal(input.value, 'IINA'); assert.equal(document.activeElement, input);
    assert.equal(ui.root.querySelector('.is-search-current')?.parentElement?.getAttribute('data-row-id'), table.records[1].id);
    assert.equal(ui.root.querySelectorAll('.tb-data-row').length, 1);
    click(ui.root.querySelector('.tb-search-close')!);
    assert.equal(ui.root.querySelectorAll('.tb-data-row').length, 0);
    [...ui.root.querySelectorAll('.tb-group-row')].forEach((line) => click(line));
  } finally { ui.cleanup(); }
});

test('[search][views] switching views clears the query and temporary highlights', () => {
  const table = fixture(); table.views.push({ id: 'another', name: 'Another', filters: emptyFilters() });
  const ui = mount(table);
  try {
    searchTable(ui.root, 'Win'); click(ui.root.querySelector('.tb-view-menu-button')!);
    shownMenus.at(-1)!.items.find((item) => item.title === 'Another')!.action!({});
    assert.equal(ui.root.querySelector<HTMLInputElement>('.tb-search-input')?.value, '');
    assert.equal(ui.root.querySelector('.is-search-match'), null);
  } finally { ui.cleanup(); }
});

test('[search][interaction] IME composition does not navigate or rebuild until composition ends', () => {
  const ui = mount();
  try {
    const input = searchTable(ui.root, 'Win'); const current = ui.root.querySelector('.is-search-current');
    input.value = 'IINA'; input.dispatchEvent(new dom.window.InputEvent('input', { bubbles: true, isComposing: true }));
    input.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true, isComposing: true }));
    assert.equal(ui.root.querySelector('.is-search-current'), current);
    input.dispatchEvent(new dom.window.CompositionEvent('compositionend', { bubbles: true }));
    assert.equal(ui.root.querySelector('.is-search-current')?.parentElement?.getAttribute('data-row-id'), ui.table.records[1].id);
  } finally { ui.cleanup(); }
});

test('[search][storage] editing a matching cell refreshes results without persisting search state', async () => {
  const ui = mount();
  try {
    searchTable(ui.root, 'Win');
    const cell = ui.root.querySelector<HTMLElement>('.is-search-current')!;
    cell.focus(); cell.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    const editor = cell.querySelector<HTMLTextAreaElement>('textarea')!;
    editor.value = 'Different'; editor.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await waitForCondition(() => !!ui.saved(), 'edit saved');
    assert.equal(ui.root.querySelector('.is-search-match'), null);
    assert.equal(ui.root.querySelector('.tb-search-status')?.textContent, 'No matches in this view');
    assert.equal(ui.root.querySelector<HTMLInputElement>('.tb-search-input')?.value, 'Win');
    assert.deepEqual(Object.keys(ui.saved()!).sort(), Object.keys(ui.table).sort());
  } finally { ui.cleanup(); }
});

test('[search][storage] host replacement keeps the query, current cell and selection in its pane', () => {
  const table = fixture(); const pane = document.createElement('div'); pane.className = 'markdown-preview-view'; document.body.append(pane);
  const plugin = { app: {} } as any;
  const first = document.createElement('div'); pane.append(first);
  const firstController = renderTable(plugin, JSON.stringify(table), { root: first, sourcePath: 'search-rebuild.md', save: async (_, next) => JSON.stringify(next) });
  let secondController: ReturnType<typeof renderTable> | undefined;
  try {
    const input = searchTable(first, 'Win'); input.setSelectionRange(1, 2);
    firstController.destroy(); first.remove();
    const second = document.createElement('div'); pane.append(second);
    secondController = renderTable(plugin, JSON.stringify(table), { root: second, sourcePath: 'search-rebuild.md', save: async (_, next) => JSON.stringify(next) });
    const restored = second.querySelector<HTMLInputElement>('.tb-search-input')!;
    assert.equal(restored.value, 'Win'); assert.equal(document.activeElement, restored);
    assert.equal(restored.selectionStart, 1); assert.equal(restored.selectionEnd, 2);
    assert.equal(second.querySelector('.tb-search-status')?.textContent, '1 / 1 cells');
  } finally { firstController.destroy(); secondController?.destroy(); pane.remove(); }
});

test('[search] sessions are isolated by plugin, pane and table and expire after unmount', async () => {
  const plugin = {}; const pane = document.createElement('div'); pane.className = 'cm-editor';
  const root = document.createElement('div'); pane.append(root);
  const first = attachSearchState(plugin, root, 'one', 'view'); first.state.query = 'private query';
  assert.notEqual(attachSearchState({}, root, 'one', 'view').state, first.state);
  assert.notEqual(attachSearchState(plugin, root, 'two', 'view').state, first.state);
  const otherPane = document.createElement('div'); otherPane.className = 'cm-editor';
  const other = document.createElement('div'); otherPane.append(other);
  assert.notEqual(attachSearchState(plugin, other, 'one', 'view').state, first.state);
  first.detach(); const replacement = attachSearchState(plugin, root, 'one', 'view');
  await new Promise((resolve) => setTimeout(resolve, 280));
  const rebound = attachSearchState(plugin, root, 'one', 'view');
  assert.equal(rebound.state, first.state, 'an old controller cannot delete its replacement session');
  replacement.detach(); rebound.detach();
  await new Promise((resolve) => setTimeout(resolve, 280));
  assert.equal(attachSearchState(plugin, root, 'one', 'view').state.query, '');
});
