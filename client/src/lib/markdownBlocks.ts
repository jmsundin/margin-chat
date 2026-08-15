export type MarkdownBlockKind =
  | "blank"
  | "blockquote"
  | "fenced-code"
  | "hard-break-paragraph"
  | "indented-code"
  | "line"
  | "list"
  | "setext-heading"
  | "table";

export type MarkdownBlock = {
  end: number;
  kind: MarkdownBlockKind;
  start: number;
  value: string;
};

type SourceLine = { end: number; start: number; value: string };

function sourceLines(value: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let start = 0;
  for (let index = 0; index <= value.length; index += 1) {
    if (index !== value.length && value[index] !== "\n") continue;
    lines.push({ end: index, start, value: value.slice(start, index) });
    start = index + 1;
  }
  return lines;
}

function block(
  value: string,
  lines: SourceLine[],
  startIndex: number,
  endIndex: number,
  kind: MarkdownBlockKind,
): MarkdownBlock {
  const start = lines[startIndex].start;
  const end = lines[endIndex].end;
  return { end, kind, start, value: value.slice(start, end) };
}

function fenceMarker(line: string) {
  return line.match(/^ {0,3}(`{3,}|~{3,})/)?.[1] ?? null;
}

function closesFence(line: string, marker: string) {
  const trimmed = line.trim();
  return trimmed.length >= marker.length && [...trimmed].every((character) => character === marker[0]);
}

function isList(line: string) {
  return /^(\s*)([-+*]|\d+[.)])(\s+)(\[[ xX]\](?:\s+|$))?/.test(line);
}

function isQuote(line: string) {
  return /^\s{0,3}(?:>\s*)+/.test(line);
}

function isIndentedCode(line: string) {
  return /^(?: {4}|\t)/.test(line);
}

function isTableDelimiter(line: string) {
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.length > 0 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell));
}

function isTableStart(lines: SourceLine[], index: number) {
  return Boolean(lines[index + 1]) && lines[index].value.includes("|") && isTableDelimiter(lines[index + 1].value);
}

function isSpecialStart(lines: SourceLine[], index: number) {
  const line = lines[index]?.value ?? "";
  return (
    !line.trim() ||
    Boolean(fenceMarker(line)) ||
    isQuote(line) ||
    isList(line) ||
    isIndentedCode(line) ||
    isTableStart(lines, index)
  );
}

function canContinueHardBreak(lines: SourceLine[], index: number) {
  const line = lines[index];
  if (!line) return false;
  if (!line.value.trim()) return index === lines.length - 1;
  return !isSpecialStart(lines, index);
}

export function parseMarkdownBlocks(value: string): MarkdownBlock[] {
  const lines = sourceLines(value);
  const blocks: MarkdownBlock[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index].value;

    if (!line.length) {
      blocks.push(block(value, lines, index, index, "blank"));
      continue;
    }

    const marker = fenceMarker(line);
    if (marker) {
      let endIndex = index;
      while (endIndex + 1 < lines.length) {
        endIndex += 1;
        if (closesFence(lines[endIndex].value, marker)) break;
      }
      blocks.push(block(value, lines, index, endIndex, "fenced-code"));
      index = endIndex;
      continue;
    }

    if (isQuote(line)) {
      let endIndex = index;
      while (isQuote(lines[endIndex + 1]?.value ?? "")) endIndex += 1;
      blocks.push(block(value, lines, index, endIndex, "blockquote"));
      index = endIndex;
      continue;
    }

    if (isList(line)) {
      let endIndex = index;
      while (endIndex + 1 < lines.length) {
        const next = lines[endIndex + 1].value;
        const afterNext = lines[endIndex + 2]?.value ?? "";
        if (isList(next) || /^(?: {2,}|\t)\S/.test(next)) {
          endIndex += 1;
        } else if (!next.trim() && (isList(afterNext) || /^(?: {2,}|\t)\S/.test(afterNext))) {
          endIndex += 1;
        } else {
          break;
        }
      }
      blocks.push(block(value, lines, index, endIndex, "list"));
      index = endIndex;
      continue;
    }

    if (isTableStart(lines, index)) {
      let endIndex = index + 1;
      while (lines[endIndex + 1]?.value.trim() && lines[endIndex + 1].value.includes("|")) endIndex += 1;
      blocks.push(block(value, lines, index, endIndex, "table"));
      index = endIndex;
      continue;
    }

    if (isIndentedCode(line)) {
      let endIndex = index;
      while (endIndex + 1 < lines.length) {
        const next = lines[endIndex + 1].value;
        if (isIndentedCode(next)) {
          endIndex += 1;
        } else if (!next && isIndentedCode(lines[endIndex + 2]?.value ?? "")) {
          endIndex += 1;
        } else {
          break;
        }
      }
      blocks.push(block(value, lines, index, endIndex, "indented-code"));
      index = endIndex;
      continue;
    }

    if (lines[index + 1] && line.trim() && /^ {0,3}(?:=+|-+)\s*$/.test(lines[index + 1].value)) {
      blocks.push(block(value, lines, index, index + 1, "setext-heading"));
      index += 1;
      continue;
    }

    if (/ {2,}$|\\$/.test(line) && canContinueHardBreak(lines, index + 1)) {
      let endIndex = index + 1;
      while (/ {2,}$|\\$/.test(lines[endIndex].value) && canContinueHardBreak(lines, endIndex + 1)) {
        endIndex += 1;
      }
      blocks.push(block(value, lines, index, endIndex, "hard-break-paragraph"));
      index = endIndex;
      continue;
    }

    blocks.push(block(value, lines, index, index, "line"));
  }

  return blocks;
}
