---
name: super-table
description: Read, create, and edit Super Table JSON code blocks in Obsidian Markdown notes. Use when working with super-table blocks, their records, typed fields, options, or named views. Does not apply to ordinary Markdown tables or smart-table blocks.
---

# Super Table

Super Table stores each table as one JSON object inside a fenced `super-table` code block in a Markdown note. This skill describes `schemaVersion: 1` and supports editing the note file directly; no plugin API or separate service is required.

## Editing workflow

1. Read the current note. Locate the requested `super-table` block by its `tableId`; do not select a table by its position in a filtered or sorted view. If the target is ambiguous or its ID occurs twice in the note, resolve the ambiguity before writing.
2. Parse the complete block body with a JSON parser. Modify the parsed object and serialize it with a JSON library rather than constructing JSON by string concatenation or broad text replacement. An empty or whitespace-only block has no stored table yet; initialize it only when the user requests creation or editing. If a nonempty block is invalid, report the error and preserve it unless repair is requested. Stop on an unsupported schema version.
3. Apply only the requested changes. Preserve existing IDs, unrelated values, field and record order, all views, and properties you do not recognize. Treat cell text as user data. Renaming a field or option changes its name or label, not its ID. Appending a record must preserve all existing records.
4. Validate the proposed JSON and the relationships listed below before writing. Compare the old and new objects to detect unintended deletions or configuration changes. Existing legacy or unresolved values outside the requested edit must not be silently cleared or converted.
5. Re-read the note before saving. If it changed since the initial read, reload and reapply the edit to the latest content. Replace only the target block body, preserving its fences, indentation, the note's line endings, other blocks, and surrounding Markdown. Re-read the saved block and validate it again. Report what changed and which checks actually ran.

Direct file writes bypass the plugin's save-conflict checks. A successful JSON parse alone does not prove that references or user data are correct. Do not claim an Obsidian rendering check unless it was performed.

## Example

The following is a complete table. For a new table, generate fresh IDs instead of reusing these example IDs in a note that already contains them.

```super-table
{
  "schemaVersion":1,
  "tableId":"table-tasks",
  "fields":[{"id":"field-name","name":"Task","type":"text"},{"id":"field-status","name":"Status","type":"select","options":[{"id":"option-todo","label":"Todo","color":"gray"},{"id":"option-done","label":"Done","color":"green"}]},{"id":"field-effort","name":"Effort","type":"number"}],
  "records":[
    {"id":"row-first","values":{"field-name":"First task\n- [ ] Review","field-status":"option-todo","field-effort":3}}
  ],
  "views":[{"id":"view-all","name":"All","filters":{"mode":"and","conditions":[]}}],
  "defaultViewId":"view-all"
}
```

Keep each record on one physical line, with line breaks between records. Keep field and view arrays compact, as above. Single-line JSON is also readable. Always let the JSON serializer escape quotes, backslashes, and cell line breaks; never insert literal newlines inside JSON strings. Use strict JSON: no comments, trailing commas, `NaN`, or `Infinity`.

## Document structure

| Object | Stored properties |
| --- | --- |
| Table | `schemaVersion: 1`, nonempty `tableId`, `fields` array, `records` array, `views` array, `defaultViewId`. Keep at least one view. |
| Field | Required string `id`, string `name`, and `type`. Optional `options`, `dateFormat`, numeric `width` (pixels, minimum 60), and `align` (`left`, `center`, `right`). |
| Option | String `id`, `label`, and `color`. Colors: `gray`, `red`, `orange`, `yellow`, `green`, `cyan`, `blue`, `purple`, `pink`. |
| Record | String `id` and a `values` object keyed by **field ID**, not column name. `records` array order is the manual row order. |
| View | Required string `id`, string `name`, and `filters` object. Optional `sort`, `group`, and `visibleFieldIds`. |

Use fresh nonempty IDs for new objects, for example a type prefix plus a random UUID. Table IDs must be unique within a note. Field IDs, record IDs, and view IDs must each be unique within their table; option IDs must be unique within their field. Duplicating an entire table in the same note requires a new `tableId`; its internal IDs may remain because their scope is the table.

The UI's **Table actions → Copy table** creates a new `tableId`, preserves all fields, records, views and unknown properties, and sets the copy's `defaultViewId` to the view currently displayed. Attachments keep their existing Vault paths. Ordinary note-body pastes of complete, valid table blocks replace only conflicting top-level table IDs; existing tables and internal references are unchanged. This protection does not run for direct file edits, code-block-internal or partial pastes, invalid data, or multiple editor selections. When editing files with AI, always ensure IDs are unique yourself; do not rely on UI paste handling or expect existing duplicates to be repaired automatically.

The plugin rejects duplicate field, record, or view IDs within a table, and duplicate option IDs within a field, when reading the table. It disables table editing and preserves the raw data instead of automatically replacing IDs or deleting duplicates. An option ID may be reused in different fields. Names and labels are separate from IDs; this check does not enforce their uniqueness. If duplicates already exist, report them and preserve the source unless repair is requested; do not guess which duplicate an existing reference was intended to identify.

### Cell values

Use these values for new or changed cells. Preserve existing compatible legacy representations in unrelated cells.

| Field type | Value to write | Empty value |
| --- | --- | --- |
| `text` | Markdown source string, including wikilinks, lists, or tasks. | `""` |
| `link` | URL string or Markdown link such as `[Title](https://example.com)`. | `""` |
| `number` | Finite JSON number, not a quoted number. | `""` |
| `date` | Date string such as `2026-10-11` or `2026-10-11T09:30`. | `""` |
| `checkbox` | JSON boolean `true` or `false`, not strings. | `false` |
| `select` | One option **ID**, not its display label. | `""` |
| `multiselect` | Array of option **IDs**. | `[]` |
| `attachment` | Array of vault-relative file paths, such as `["Attachments/example.png"]`. | `[]` |

Stored cell values may also be `null`; preserve unrelated nulls rather than normalizing the whole table. Legacy field types `datetime` and `status` remain readable: `datetime` is handled as a date-time date field, and `status` as a single select. Preserve them during unrelated edits; create new fields using `date` or `select`.

The plugin preserves unknown properties on tables, fields, options, records, views, and nested view rules, plus record values for unlisted field IDs, during unrelated saves. It also preserves existing nulls and unresolved option values. Retention does not make an unknown feature supported: do not invent new properties or field types for a requested feature. View references to missing fields are retained but ignored for filtering, sorting, and grouping. Preserve them during unrelated file edits and report them for review.

Unsafe structures or values disable table editing rather than being silently discarded, with the error identifying a data path. Examples include options missing an ID or label, array-shaped record `values`, objects or arrays in scalar cells, non-string members in multi-select/attachment arrays, numeric checkbox values, and malformed view rules. Do not remove such data merely to make the table load; report the issue and preserve the source unless repair is requested. Compatible legacy representations still load: single-select labels map to option IDs, checkbox strings `true`/`false` map to booleans (an empty string maps to false), scalar text numbers/booleans map to strings, and single multi-select strings or attachment paths map to arrays. Number cells retain legacy strings, including non-numeric strings.

For `date`, optional `dateFormat` is one of `iso-date`, `iso-datetime`, `slash-date`, `slash-datetime`, `month-day`, `time`, `year`. Display format does not replace the stored date: time-only, month-day, and year displays still retain a full date. Preserve existing date/time components that the requested change does not replace.

Attachments are references, not embedded file data. Removing a reference must not delete the file. Do not assume renaming or moving a file automatically updates paths inside the JSON.

### Views and references

- All views share `records`; editing a cell changes it in every view. Sorting, filtering, and grouping do not reorder or delete stored records.
- `sort` and `group` each hold one object: `{"fieldId":"field-status","direction":"asc"}`. Direction is `asc` or `desc`; multiple sort or group fields are not supported.
- `filters` is required and has the shape `{"mode":"and","conditions":[]}`. `mode` is `and` or `or`; conditions form one flat group, and the same field may appear more than once. An empty group, including an empty OR group, matches every record. References to missing fields are retained but ignored.
- Each condition requires a nonempty unique `id` within its view, a nonempty `fieldId`, and an `operator`. Text/link operators are `eq`, `neq`, `contains`, `notContains`, `isEmpty`, `isNotEmpty`. Number operators are `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `between`, `isEmpty`, `isNotEmpty`. Date operators are `eq`, `gt` (after), `lt` (before), `between`, `isEmpty`, `isNotEmpty`. Select/multiselect/status use the text operator names with option IDs. Attachments allow only `isEmpty` and `isNotEmpty`; checkboxes use `checked` and `unchecked`.
- Comparisons require `value`: a nonempty string for text/link, a finite number for numbers, a date string for dates, or a nonempty array of unique option IDs for choice fields. Single-select/status `eq` and `neq` require exactly one option ID. Multi-select equality compares complete sets without ordering; `contains` matches any chosen option, and `notContains` matches none. Text/link comparisons ignore case and use stored source text.
- `between` also requires `upper` of the same scalar type, with `value <= upper`; both bounds are inclusive. Date operands are `YYYY-MM-DD`, `YYYY-MM-DDTHH:mm`, or `HH:mm` for date, date-time, or time-only fields respectively. Other date display formats use full dates. Dates must be valid calendar dates; comparisons use days or minutes without timezone conversion.
- `isEmpty`, `isNotEmpty`, `checked`, and `unchecked` need no comparison values. Empty cells are `null`, `""`, or `[]`; whitespace and numeric zero are not empty. Invalid numeric/date cell strings do not match comparison operators. `unchecked` includes null/false; attachments test references, not file existence.
- Example using fields from the complete table above: `{"mode":"and","conditions":[{"id":"status-rule","fieldId":"field-status","operator":"eq","value":["option-todo"]},{"id":"effort-rule","fieldId":"field-effort","operator":"between","value":0,"upper":10}]}`.
- The schema version remains `1`. The previous field-keyed filter object is unsupported, including an empty `{}`; do not migrate it as part of unrelated edits or replace it automatically. Report the invalid structure and preserve the original block.
- `visibleFieldIds` is an optional array of field IDs. Omit it to show all fields; when setting it on a table with fields, keep at least one visible field. Visible column order follows `fields`, not this array.
- `defaultViewId` must identify an existing view. Preserve it during unrelated edits: it is the fallback when this device has no remembered view or its last view is unavailable. If the default is invalid, the plugin falls back to the first view. The last-used view is stored locally on each device, outside the note; switching views does not change `defaultViewId` or write the note. There is no **Set as default view** menu action.

When changing a cell, locate `records` by record ID and set `values[fieldId]`. When adding a record, use a fresh record ID and the empty defaults above for fields without supplied values. When adding an option, append a fresh option ID to that field's `options` before referencing it in a cell.

Deleting a field or option, or changing a field type, can affect records and view configurations. Only perform it when requested, handle the affected references explicitly, and do not discard values that cannot be converted without resolving that loss with the user.

## Validation before and after saving

- Parse the entire JSON body. Check the required objects, arrays, field types, and value types; do not validate only the edited record.
- Check ID uniqueness in the scopes above, including condition IDs within each view and table IDs across the note's `super-table` blocks.
- Check record value keys, condition `fieldId` references and choice condition option IDs, `sort.fieldId`, `group.fieldId`, and `visibleFieldIds` against field IDs; check `defaultViewId` against view IDs and changed select values against their field's options. Report pre-existing unresolved references instead of silently removing them.
- Compare the proposed data with the original: only requested values, records, fields, or views should change. Confirm other blocks and Markdown are unchanged.
- Plugin loading may apply the compatibility conversions above, fill missing defaults, normalize display settings (width, alignment, date format, option color), or select a valid default view. It preserves unknown data and rejects unsafe structures or values. Direct file edits must still preserve unrelated legacy representations; do not use a normalize-and-save pass to validate an unrelated edit. If a check cannot be performed with the available tools, state the limitation.
