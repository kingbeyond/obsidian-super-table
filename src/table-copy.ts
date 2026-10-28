import { makeId, TableDocument } from "./model";
import { readTable, readTableId, TABLE_CODE_BLOCK_LANGUAGE } from "./storage";

function freshTableId(used: Set<string>): string {
  let id: string;
  do { id = makeId("table"); } while (used.has(id));
  used.add(id);
  return id;
}

export function copyTableDocument(table: TableDocument, viewId: string): TableDocument {
  const copy = JSON.parse(JSON.stringify(table)) as TableDocument;
  copy.tableId = freshTableId(new Set([table.tableId]));
  if (copy.views.some((view) => view.id === viewId)) copy.defaultViewId = viewId;
  return copy;
}

function lineOffsets(text: string): number[] {
  const offsets = [0];
  for (let index = 0; index < text.length; index++) if (text[index] === "\n") offsets.push(index + 1);
  return offsets;
}

interface PasteFence { start: number; end: number; bodyStart: number; body: string; language: string; closed: boolean }

// Include unclosed outer fences so their contents can never be mistaken for
// standalone pasted tables. Keep physical offsets to change only the ID token.
function pasteFences(text: string): PasteFence[] {
  const offsets = lineOffsets(text);
  const lines = text.split(/\r?\n/);
  const blocks: PasteFence[] = [];
  for (let line = 0; line < lines.length; line++) {
    const opening = lines[line].match(/^\s*(`{3,}|~{3,})\s*([\w-]+)?[^\r\n]*$/);
    if (!opening) continue;
    const marker = opening[1];
    let end = line + 1;
    while (end < lines.length && !new RegExp(`^\\s*${marker[0]}{${marker.length},}\\s*$`).test(lines[end])) end++;
    const closed = end < lines.length;
    const bodyStart = offsets[line + 1] ?? text.length;
    blocks.push({ start: offsets[line], end: closed ? offsets[end] + lines[end].length : text.length + 1,
      bodyStart, body: text.slice(bodyStart, closed ? offsets[end] : text.length), language: (opening[2] ?? "").toLowerCase(), closed });
    line = end;
  }
  return blocks;
}

function tableIdSpan(body: string): { from: number; to: number } | null {
  const tokens = /"(?:[^"\\]|\\.)*"|[{}[\]]/g;
  let depth = 0;
  const matches: Array<{ from: number; to: number }> = [];
  for (let token = tokens.exec(body); token; token = tokens.exec(body)) {
    const value = token[0];
    if (value === "{" || value === "[") depth++;
    else if (value === "}" || value === "]") depth--;
    else if (depth === 1 && JSON.parse(value) === "tableId") {
      const property = body.slice(tokens.lastIndex).match(/^\s*:\s*("(?:[^"\\]|\\.)*")/);
      if (property) {
        const to = tokens.lastIndex + property[0].length;
        matches.push({ from: to - property[1].length, to });
      }
    }
  }
  return matches.length === 1 ? matches[0] : null;
}

/** Return changed clipboard text only when a new, valid table would collide. */
export function prepareTablePaste(note: string, clipboard: string, from: number, to: number): string | null {
  if (from < 0 || to < from || to > note.length) return null;
  if (!/super-table/i.test(clipboard)) return null;
  const noteBlocks = pasteFences(note);
  if (noteBlocks.some((block) => {
    const overlaps = from === to ? from >= block.start && from <= block.end : from < block.end && to > block.start;
    return overlaps && !(from < to && from <= block.start && to >= block.end);
  })) return null;
  const used = new Set<string>();
  for (const block of noteBlocks) {
    if (block.language !== TABLE_CODE_BLOCK_LANGUAGE) continue;
    if (from < to && from <= block.start && to >= block.end) continue;
    const id = readTableId(block.body);
    if (id) used.add(id);
  }
  const pastedBlocks = pasteFences(clipboard);
  const candidates = pastedBlocks.flatMap((block) => {
    if (!block.closed || block.language !== TABLE_CODE_BLOCK_LANGUAGE) return [];
    const { bodyStart, body } = block;
    try {
      const table = readTable(body);
      const span = tableIdSpan(body);
      return span ? [{ id: table.tableId, blockStart: block.start, from: bodyStart + span.from, to: bodyStart + span.to }] : [];
    } catch { return []; }
  });
  // Reserve IDs from invalid blocks too, without attempting to repair their data.
  const reserved = new Set(used);
  for (const block of pastedBlocks) {
    if (block.language === TABLE_CODE_BLOCK_LANGUAGE) {
      const id = readTableId(block.body);
      if (id) {
        reserved.add(id);
        if (!candidates.some((candidate) => candidate.blockStart === block.start)) used.add(id);
      }
    }
  }
  const changes: Array<{ from: number; to: number; insert: string }> = [];
  for (const candidate of candidates) {
    if (used.has(candidate.id)) changes.push({ ...candidate, insert: JSON.stringify(freshTableId(reserved)) });
    else used.add(candidate.id);
  }
  if (!changes.length) return null;
  let result = clipboard;
  for (const change of changes.reverse()) result = result.slice(0, change.from) + change.insert + result.slice(change.to);
  return result;
}
