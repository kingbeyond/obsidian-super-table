# Super Table User Guide

[English](USER_GUIDE.md) | [简体中文](USER_GUIDE.zh-CN.md) | [Back to README](../README.md)

Try the [example tables](examples/README.md) in your vault.

Version 1.0.4 and later require Obsidian 1.13.0 or newer. Versions 1.0.1–1.0.3 retain their Obsidian 1.8.7 minimum.

## Creating and viewing tables

In note editing mode, run **Super Table: Insert table** or click the table button in the ribbon. You can also type an empty code block:

```super-table
```

An empty block displays a default sample table, saved into the note on the first edit. Tables are editable in Live Preview and Reading view; everyday use requires no JSON editing.

## Editing cells

Click a cell to select it, then use the corresponding action:

| Action | Method |
| --- | --- |
| Edit text or numbers | Click the cell body again or double-click it, or select it and press Enter or Space. |
| Open choices, dates, links, or attachments | Select the cell and click its action button, or press Enter or Space. |
| Save or cancel input | Click outside the input to save; press Escape to cancel. Markdown text shortcuts are listed below. |
| Toggle a checkbox | Click it directly. |
| Clear a cell | Select the cell, then press `Delete` (⌫) on macOS or `Backspace` / `Delete` (Del) on Windows. |

Clearing an attachment cell removes its references without deleting vault files. See [Records and bulk operations](#records-and-bulk-operations) for copying and pasting.

Super Table supports undo and redo.

### Markdown text

Text cells support bold, italics, lists, and internal and external links, such as `[[Note name|Display name]]`. Click links to open them; click outside links and controls to edit the text.

Press Enter or `Cmd/Ctrl+Enter` to save, or Shift+Enter for a line break. You can paste multiline Markdown; copying a cell preserves its source.

Use `- [ ] To do` and `- [x] Done` for task lists, and toggle tasks in the preview. If a task cannot be toggled, edit its source.

Embed images with `![[image.png]]`. Wikilink embeds for notes, PDFs, audio, and video appear as links that open on click.

### Attachments

![Image thumbnails and Markdown tasks](images/attachments.png)

Set a column's type to **Attachments**, select a cell, and click its dropdown button to open the attachment panel.

- **Add vault files**: Choose **Add attachment**, search and select files, then choose **Add selected**. A cell can reference multiple files.
- **Import from device**: Copy files to Obsidian's configured attachment folder.
- **Paste an image**: Copy an image, select an attachment cell or leave its panel open, and press `Cmd/Ctrl+V`.

In **Settings → Community plugins → Super Table → Attachment image paste location**, choose Obsidian's attachment settings or `附件/<note name>/` beside the note. This affects pasted images only. Pasting requires image data in the clipboard; an image URL alone is not downloaded.

This option is also available through settings search.

Click images to preview, browse, and zoom. Other attachments open through Obsidian.

An attachment's `×` removes its reference without deleting the file. Files created by importing or pasting also remain if selection is canceled or saving fails.

Links and attachment references do not update automatically when files are renamed or moved; check and reassociate them afterward. Native backlinks and graph indexing are not guaranteed.

### Single select and multi-select

Select a cell and open its dropdown to choose options. Click a selected option again to deselect it, or use a tag's `×` to remove it.

Use **Edit options…** to rename, recolor, or delete options. On desktop, drag option rows to reorder them.

### Dates and links

Dates and date-times share the **Date** field type; choose a display format in **Edit column**. Select a cell and click its calendar button to pick or enter a date.

Link cells have separate display text and URL settings; blank display text defaults to the URL. Clicking **Fetch link title** requests the webpage and fills its title. Pages requiring sign-in or JavaScript may not return a title.

## Fields and column settings

![Column types, option labels, and colors in the column editor](images/column-options.png)

Use **Column** in the toolbar or the trailing header `+` to add a field. Double-click a column name to rename it; right-click the heading or open its menu for more settings.

Choose **Edit column** to change the type, date format, and options. Switching to **Attachments** clears existing cell values. If conversion would clear data or view filters, the plugin shows the affected counts and asks for confirmation.

Use **Display configuration** to drag fields into order and toggle visibility with the eye buttons. Column order is shared across views; visibility is saved per view. Drag column boundaries to resize them.

## Records and bulk operations

Use **Row** in the toolbar or **New row** at the bottom to add records. Current filters or collapsed groups may hide a new record.

Click a row's left grip or right-click the record to insert, copy, move, or delete. Drag the grip to reorder rows when sorting and grouping are off.

Choose **Select** to copy, duplicate, delete, or export records in bulk.

| Content | How to copy and paste |
| --- | --- |
| Cell | Select a cell and press `Cmd/Ctrl+C`, then select a same-type target and press `Cmd/Ctrl+V` to replace its value. |
| One row | Copy from its row menu, then right-click a target and choose **Paste row** to replace all its values. |
| Multiple rows | Select and copy records, then use **Paste N rows** in the toolbar to add copies. |
| External text | Paste into text, number, or link cells; numbers accept one valid value. Bulk pasting external rows and columns is currently unavailable. |

Copied cells take priority over selected rows. Shortcut pasting a copied single row asks for confirmation before replacing the current row; use **Paste N rows** for multiple rows. Copied records use the original attachments without duplicating files.

## Views, filters, sorting, and grouping

### Managing views

Click the leftmost toolbar button to switch, create, duplicate, or delete views.

Each view saves its own filters, sorting, grouping, and hidden fields. Views share records: cell edits affect other views, while deleting a view does not delete records.

The plugin remembers the last view on this device. View settings sync with the note; the last-view choice does not sync across devices.

### Filtering and sorting

![AND filter conditions with grouped results](images/filters-and-groups.png)

Choose **Filter → Add condition**, then select a field, operator, and value. Use **Meet all conditions** (AND) or **Meet any condition** (OR); nested groups are not supported. **Clear filters** removes all conditions in the current view.

For text, numbers, and dates, press Enter or click elsewhere to apply. Choosing options or switching AND/OR applies immediately.

A few conditions need clarification:

- **Equals and Contains**: Single-select **Contains** matches any chosen option. Multi-select **Equals** requires an identical set; **Contains** matches any chosen option, and **Does not contain** matches none. To require both A and B, add two Contains conditions under AND.
- **Between**: Includes both endpoints and requires both bounds.
- **Dates**: Compare calendar days, date-times compare minutes, and time-only fields compare hours/minutes. Other display formats still use full dates.
- **Text and attachments**: Text comparisons use case-insensitive Markdown source. Attachment **Is empty** checks references, not whether files exist.

Choose **Sort ascending** or **Sort descending** in a column menu. **Clear sort** restores manual row order. Each view supports one sort field.

### Grouping

Choose **Group**, then select a field and direction. Remove grouping with the minus-in-a-circle button at the end of the condition row. Click group headings to collapse or expand them. Each view supports one grouping field; records within groups follow the current sort order.

Multi-select values group by option combination: `A + B` and `B + A` share a group, and each record appears once.

## Import and export

### Importing existing tables

| Source | Action |
| --- | --- |
| Smart Table | Place the cursor inside a `smart-table` block and run **Super Table: Import Smart Table block**. |
| Markdown table | Place the cursor inside a Markdown table and run **Super Table: Convert Markdown table to Super Table**. |

Review the preview and conversion notices before confirming. The new table is inserted below the source, which is kept. If a Markdown row has nonempty cells beyond its header's column count, correct the reported line and retry.

Smart Table import is one-way, with status columns converted to single select. If filters cannot be fully converted, all filters in the imported view are cleared with a notice; records are retained. Converting back to Smart Table is not guaranteed to restore settings.

### Exporting as Markdown

Choose **Export → Export Markdown** to save a file or copy to the clipboard:

- **Current view**: Visible fields and filtered records in the current sort and group order.
- **All fields and records**: Every field and record in stored order, independent of the current view.

Attachments become vault wikilinks, which may not open outside the vault.

To convert within a note, place the cursor inside the Super Table block, run **Super Table: Convert Super Table to Markdown**, and confirm the preview. By default, the original stays and the result is inserted below it. Choosing **Replace original Super Table** removes field types, option definitions, and view settings.

When upgrading from 1.0.3 or earlier to 1.0.4 or later, reassign any custom hotkey for this command in Obsidian's hotkey settings. External command references must use its new ID, `super-table:convert-to-markdown`.

### Exporting CSV

Choose **Export → Export CSV**, using the same scopes as Markdown. In row selection mode, **Export** includes only selected records and currently visible fields. Attachments use JSON path arrays, such as `["Attachments/image.png","Attachments/notes.pdf"]`.

## Interface language

Find **Language** in Obsidian's settings, choose English or Simplified Chinese, and restart as prompted. Other languages fall back to English; existing field names, options, and records are not translated.

## Touch controls and wide tables

Use row and column menus on touch devices. Wide tables support horizontal scrolling, including a floating scrollbar at the pane's bottom edge.

## Editing note files with AI

Before AI edits a table directly, provide the [Super Table editing skill](../SKILL.md) as an attachment, pasted text, or a skill installed in your AI tool. Installing the Obsidian plugin does not install the skill in your AI tool.

The skill provides format and validation rules. Direct file edits bypass the plugin's save-conflict checks; review the results.

## Saving, compatibility, and troubleshooting

Table data and view settings stay in the current note and save automatically after edits. See the [skill](../SKILL.md) for data format and compatibility rules.

| Problem | What to do |
| --- | --- |
| Save conflict | If another app, device, or pane changes the same table, conflicting writes stop. Reload and check the latest data before editing again; the plugin does not merge automatically. |
| Invalid structure or cell values | Editing is disabled and the original data is kept. Follow the notice to inspect Source mode or the raw data, then repair it after checking the content. Old filter formats are not migrated automatically. |
| Duplicate IDs | Duplicate internal IDs prevent loading or saving. Check copied content and use the skill to verify references before repairing them. Matching display names do not mean matching IDs. |
