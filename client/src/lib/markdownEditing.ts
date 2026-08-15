export type MarkdownEdit = {
  from: number;
  insert: string;
  selection: number;
  to: number;
};

type LineContext = {
  end: number;
  start: number;
  value: string;
};

const LIST_PATTERN = /^(\s*)([-+*]|\d+[.)])(\s+)(\[[ xX]\](?:\s+|$))?(.*)$/;
const QUOTE_PATTERN = /^(\s{0,3}(?:>\s*)+)(.*)$/;
const FENCE_PATTERN = /^(\s{0,3})(`{3,}|~{3,})([^`]*)$/;

function getLineContext(value: string, cursor: number): LineContext {
  const safeCursor = Math.max(0, Math.min(cursor, value.length));
  const start = value.lastIndexOf("\n", Math.max(0, safeCursor - 1)) + 1;
  const nextNewline = value.indexOf("\n", safeCursor);
  const end = nextNewline === -1 ? value.length : nextNewline;

  return { end, start, value: value.slice(start, end) };
}

function isFenceClose(line: string, marker: string) {
  const trimmed = line.trim();
  return (
    trimmed.length >= marker.length &&
    [...trimmed].every((character) => character === marker[0])
  );
}

function isInsideFenceBefore(value: string, lineStart: number) {
  const precedingLines = value.slice(0, lineStart).split("\n");
  let openMarker: string | null = null;

  for (const line of precedingLines) {
    if (openMarker) {
      if (isFenceClose(line, openMarker)) openMarker = null;
      continue;
    }

    openMarker = line.match(FENCE_PATTERN)?.[2] ?? null;
  }

  return Boolean(openMarker);
}

function hasClosingFence(value: string, lineEnd: number, marker: string) {
  return value
    .slice(lineEnd)
    .split("\n")
    .slice(1)
    .some((line) => isFenceClose(line, marker));
}

function getNextListMarker(marker: string) {
  const ordered = marker.match(/^(\d+)([.)])$/);
  return ordered ? `${Number(ordered[1]) + 1}${ordered[2]}` : marker;
}

function isTableDelimiter(line: string) {
  const cells = line.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
  return cells.length > 0 && cells.every((cell) => /^\s*:?-{3,}:?\s*$/.test(cell));
}

function isTableLine(value: string, line: LineContext) {
  if (!line.value.includes("|")) return false;
  const previousStart = value.lastIndexOf("\n", Math.max(0, line.start - 2)) + 1;
  const previous = value.slice(previousStart, Math.max(previousStart, line.start - 1));
  const nextEnd = value.indexOf("\n", line.end + 1);
  const next = value.slice(line.end + 1, nextEnd === -1 ? value.length : nextEnd);
  return isTableDelimiter(previous) || isTableDelimiter(next) || isTableDelimiter(line.value);
}

/** Returns the Markdown-aware edit for Enter, or null to use CodeMirror's default. */
export function getMarkdownEnterEdit(value: string, cursor: number): MarkdownEdit | null {
  const line = getLineContext(value, cursor);
  const beforeCursor = line.value.slice(0, cursor - line.start);
  const afterCursor = line.value.slice(cursor - line.start);
  const fence = line.value.match(FENCE_PATTERN);

  if (
    fence &&
    cursor === line.end &&
    !isInsideFenceBefore(value, line.start) &&
    !hasClosingFence(value, line.end, fence[2])
  ) {
    const insert = `\n\n${fence[1]}${fence[2]}`;
    return { from: cursor, insert, selection: cursor + 1, to: cursor };
  }

  // Inside a fence, Enter is deliberately ordinary editor behavior.
  if (isInsideFenceBefore(value, line.start)) return null;

  const list = line.value.match(LIST_PATTERN);
  if (list && cursor >= line.start + line.value.length - list[5].length) {
    const prefixLength = list[1].length + list[2].length + list[3].length + (list[4]?.length ?? 0);
    if (!list[5].trim() && !afterCursor.trim()) {
      return {
        from: line.start,
        insert: "",
        selection: line.start,
        to: line.start + prefixLength,
      };
    }

    const nextPrefix = `${list[1]}${getNextListMarker(list[2])}${list[3]}${list[4] ? "[ ] " : ""}`;
    const insert = `\n${nextPrefix}`;
    return { from: cursor, insert, selection: cursor + insert.length, to: cursor };
  }

  const quote = line.value.match(QUOTE_PATTERN);
  if (quote && cursor >= line.start + quote[1].length) {
    if (!quote[2].trim() && !afterCursor.trim()) {
      const segments = [...quote[1].matchAll(/>\s*/g)];
      const lastSegment = segments.at(-1);
      if (!lastSegment || lastSegment.index === undefined) return null;
      return {
        from: line.start + lastSegment.index,
        insert: "",
        selection: line.start + lastSegment.index,
        to: line.start + quote[1].length,
      };
    }

    const insert = `\n${quote[1]}`;
    return { from: cursor, insert, selection: cursor + insert.length, to: cursor };
  }

  if (cursor === line.end && isTableLine(value, line)) {
    const cells = line.value.trim().replace(/^\|/, "").replace(/\|$/, "").split("|");
    if (cells.every((cell) => !cell.trim())) {
      return {
        from: line.start,
        insert: "",
        selection: line.start,
        to: line.end,
      };
    }
    const columnCount = Math.max(
      cells.length,
      1,
    );
    const emptyRow = `| ${Array.from({ length: columnCount }, () => "").join(" | ")} |`;
    const insert = `\n${emptyRow}`;
    return { from: cursor, insert, selection: cursor + 3, to: cursor };
  }

  // Keep the exact text before the cursor observable for future block rules.
  void beforeCursor;
  return null;
}

/** Removes an empty Markdown continuation marker before normal Backspace behavior. */
export function getMarkdownBackspaceEdit(value: string, cursor: number): MarkdownEdit | null {
  const line = getLineContext(value, cursor);
  const list = line.value.match(LIST_PATTERN);

  if (list && !list[5].trim()) {
    const prefixLength = list[1].length + list[2].length + list[3].length + (list[4]?.length ?? 0);
    if (cursor === line.start + prefixLength) {
      return {
        from: line.start,
        insert: "",
        selection: line.start,
        to: line.start + prefixLength,
      };
    }
  }

  const quote = line.value.match(QUOTE_PATTERN);
  if (quote && !quote[2].trim() && cursor === line.start + quote[1].length) {
    const segments = [...quote[1].matchAll(/>\s*/g)];
    const lastSegment = segments.at(-1);
    if (!lastSegment || lastSegment.index === undefined) return null;
    return {
      from: line.start + lastSegment.index,
      insert: "",
      selection: line.start + lastSegment.index,
      to: line.start + quote[1].length,
    };
  }

  return null;
}
