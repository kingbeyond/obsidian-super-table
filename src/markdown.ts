export interface MarkdownTaskMarker {
  line: number;
  checked: boolean;
  start: number;
  end: number;
}

const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "avif", "bmp", "svg"]);

/** Fast-path plain text, including explicit line breaks; render plausible Markdown as formatted content. */
export function needsMarkdownRendering(source: string): boolean {
  return /!\[\[|\[\[|!\[[^\]]*\]\(|\[[^\]]+\]\(|`|(\*\*|__|~~|\*|_)\S[^\r\n]*?\1|\b(?:https?:\/\/|www\.)[^\s<]+/i.test(source)
    || /^ {0,3}(?:#{1,6}\s|>|[-+*]\s|\d+[.)]\s)/m.test(source)
    || /^ {0,3}(?:---|\*\*\*|___)\s*$/m.test(source)
    || /<\/?[A-Za-z][^>]*>/.test(source);
}

function fenceLine(line: string): { marker: string; length: number } | null {
  const withoutQuotes = line.replace(/^(?:[ \t]{0,3}>[ \t]?)+/, "");
  const match = withoutQuotes.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
  if (!match || (match[1][0] === "`" && match[2].includes("`"))) return null;
  return { marker: match[1][0], length: match[1].length };
}

function closesFence(line: string, fence: { marker: string; length: number }): boolean {
  const withoutQuotes = line.replace(/^(?:[ \t]{0,3}>[ \t]?)+/, "");
  const closing = withoutQuotes.match(/^[ \t]{0,3}(`{3,}|~{3,})[ \t]*$/);
  return !!closing && closing[1][0] === fence.marker && closing[1].length >= fence.length;
}

/** Find Markdown task markers while ignoring fenced code blocks. Offsets include only the checkbox state character. */
export function findMarkdownTaskMarkers(markdown: string): MarkdownTaskMarker[] {
  const tasks: MarkdownTaskMarker[] = [];
  let fence: { marker: string; length: number } | null = null;
  let offset = 0;
  markdown.split("\n").forEach((line, index) => {
    const lineWithoutCR = line.endsWith("\r") ? line.slice(0, -1) : line;
    if (fence) {
      if (closesFence(lineWithoutCR, fence)) fence = null;
    } else {
      const candidate = fenceLine(lineWithoutCR);
      if (candidate) fence = candidate;
      else {
        const quotePrefix = lineWithoutCR.match(/^(?:[ \t]{0,3}>[ \t]?)+/)?.[0] ?? "";
        const listLine = lineWithoutCR.slice(quotePrefix.length);
        // Four-space indentation is ambiguous with an indented code block. Leave
        // those controls unmapped; the renderer will fail closed if it shows one.
        if (!/^[ \t]{4,}/.test(listLine)) {
          const task = listLine.match(/^([ \t]{0,3}(?:[-+*]|\d+[.)])[ \t]+\[)([ xX])(\](?:[ \t].*)?)$/);
          if (task) {
            const start = offset + quotePrefix.length + task[1].length;
            tasks.push({ line: index, checked: task[2].toLowerCase() === "x", start, end: start + 1 });
          }
        }
      }
    }
    offset += line.length + 1;
  });
  return tasks;
}

/** Toggle exactly one mapped task marker in the source. */
export function setMarkdownTaskState(markdown: string, marker: MarkdownTaskMarker, checked: boolean): string {
  const current = markdown.slice(marker.start, marker.end);
  if (!/^[ xX]$/.test(current)) return markdown;
  const replacement = checked ? "x" : " ";
  return markdown.slice(0, marker.start) + replacement + markdown.slice(marker.end);
}

/** Keep non-image Obsidian embeds and raw HTML media from opening inside a table cell. */
export function safeMarkdownEmbeds(markdown: string): string {
  const lines = markdown.split("\n");
  const offsets: number[] = [];
  const protectedLines = new Set<number>();
  let fence: { marker: string; length: number } | null = null;
  let offset = 0;
  lines.forEach((line, index) => {
    offsets.push(offset);
    const codeLine = line.replace(/^(?:[ \t]{0,3}>[ \t]?)+/, "");
    const marker = codeLine.match(/^[ \t]{0,3}(`{3,}|~{3,})(.*)$/);
    if (fence) {
      protectedLines.add(index);
      if (marker && marker[1][0] === fence.marker && marker[1].length >= fence.length && /^[ \t]*$/.test(marker[2])) fence = null;
    } else if (marker) {
      protectedLines.add(index);
      if (!(marker[1][0] === "`" && marker[2].includes("`"))) fence = { marker: marker[1][0], length: marker[1].length };
    } else if (/^[ \t]{4,}/.test(codeLine)) protectedLines.add(index);
    offset += line.length + 1;
  });

  // Pair backtick runs before transforming embeds so matched spans, including
  // multiline code spans, are copied byte-for-byte. Unmatched runs stay literal.
  const runs: Array<{ start: number; end: number; line: number; length: number }> = [];
  lines.forEach((line, lineIndex) => {
    if (protectedLines.has(lineIndex)) return;
    for (let index = 0; index < line.length;) {
      if (line[index] !== "`") { index++; continue; }
      let end = index + 1;
      while (line[end] === "`") end++;
      runs.push({ start: offsets[lineIndex] + index, end: offsets[lineIndex] + end, line: lineIndex, length: end - index });
      index = end;
    }
  });
  const codeSpans: Array<{ start: number; end: number }> = [];
  for (let index = 0; index < runs.length;) {
    const open = runs[index];
    const closeIndex = runs.findIndex((candidate, candidateIndex) => candidateIndex > index && candidate.length === open.length
      && !lines.slice(open.line + 1, candidate.line).some((_, lineIndex) => protectedLines.has(open.line + 1 + lineIndex)));
    if (closeIndex < 0) { index++; continue; }
    const close = runs[closeIndex];
    codeSpans.push({ start: open.start, end: close.end });
    index = closeIndex + 1;
  }

  let spanIndex = 0;
  const output = lines.map((line, lineIndex) => {
    if (protectedLines.has(lineIndex)) return line;
    const lineStart = offsets[lineIndex];
    let result = "";
    for (let index = 0; index < line.length;) {
      const absolute = lineStart + index;
      while (spanIndex < codeSpans.length && codeSpans[spanIndex].end <= absolute) spanIndex++;
      const span = codeSpans[spanIndex];
      if (span && absolute >= span.start && absolute < span.end) {
        const end = Math.min(line.length, span.end - lineStart);
        result += line.slice(index, end); index = end; continue;
      }
      if (line.startsWith("![[", index)) {
        const end = line.indexOf("]]", index + 3);
        if (end >= 0) {
          const embed = line.slice(index, end + 2);
          const raw = line.slice(index + 3, end);
          const path = raw.split(/[|#]/, 1)[0].trim();
          const extension = path.split(".").at(-1)?.toLowerCase() ?? "";
          result += IMAGE_EXTENSIONS.has(extension) ? embed : embed.slice(1);
          index = end + 2; continue;
        }
      }
      if (line[index] === "<") {
        const tag = line.slice(index).match(/^<(\/?(?:audio|video|iframe|object|embed)\b[^>]*)>/i)?.[0];
        if (tag) { result += `&lt;${tag.slice(1, -1)}&gt;`; index += tag.length; continue; }
      }
      result += line[index++];
    }
    return result;
  });
  return output.join("\n");
}

