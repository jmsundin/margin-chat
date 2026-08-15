export type ObsidianInlineToken = {
  contentFrom: number;
  contentTo: number;
  from: number;
  kind: "comment" | "embed" | "highlight" | "wikilink";
  labelFrom?: number;
  labelTo?: number;
  target?: string;
  to: number;
};

export type ObsidianCalloutBlock = {
  fold: "+" | "-" | null;
  from: number;
  headerLineFrom: number;
  lineFroms: number[];
  markerFrom: number;
  markerTo: number;
  title: string;
  titleFrom: number | null;
  to: number;
  type: string;
};

type SourceLine = {
  from: number;
  text: string;
  to: number;
};

type SourceRange = { from: number; to: number };

function getSourceLines(value: string): SourceLine[] {
  const lines: SourceLine[] = [];
  let from = 0;

  while (from <= value.length) {
    const newline = value.indexOf("\n", from);
    const to = newline === -1 ? value.length : newline;
    lines.push({ from, text: value.slice(from, to), to });
    if (newline === -1) break;
    from = newline + 1;
  }

  return lines;
}

function getCodeRanges(value: string, lines: SourceLine[]) {
  const ranges: SourceRange[] = [];
  let fence: { character: string; count: number; from: number } | null = null;

  for (const line of lines) {
    const fenceMatch = /^( {0,3})(`{3,}|~{3,})(.*)$/.exec(line.text);

    if (fence) {
      if (
        fenceMatch &&
        fenceMatch[2][0] === fence.character &&
        fenceMatch[2].length >= fence.count &&
        fenceMatch[3].trim() === ""
      ) {
        ranges.push({ from: fence.from, to: line.to });
        fence = null;
      }
      continue;
    }

    if (fenceMatch) {
      fence = {
        character: fenceMatch[2][0],
        count: fenceMatch[2].length,
        from: line.from,
      };
      continue;
    }

    for (let index = 0; index < line.text.length;) {
      if (line.text[index] !== "`") {
        index += 1;
        continue;
      }

      let markerTo = index + 1;
      while (line.text[markerTo] === "`") markerTo += 1;
      const marker = line.text.slice(index, markerTo);
      const close = line.text.indexOf(marker, markerTo);
      if (close === -1) {
        index = markerTo;
        continue;
      }

      ranges.push({
        from: line.from + index,
        to: line.from + close + marker.length,
      });
      index = close + marker.length;
    }
  }

  if (fence) ranges.push({ from: fence.from, to: value.length });
  return ranges;
}

function overlaps(ranges: SourceRange[], from: number, to: number) {
  return ranges.some((range) => from < range.to && to > range.from);
}

export function findObsidianInlineTokens(value: string): ObsidianInlineToken[] {
  const protectedRanges = getCodeRanges(value, getSourceLines(value));
  const tokens: ObsidianInlineToken[] = [];

  function addMatches(
    pattern: RegExp,
    create: (match: RegExpExecArray) => ObsidianInlineToken,
  ) {
    for (const match of value.matchAll(pattern)) {
      if (match.index === undefined) continue;
      const token = create(match);
      if (
        !overlaps(protectedRanges, token.from, token.to) &&
        !overlaps(tokens, token.from, token.to)
      ) {
        tokens.push(token);
      }
    }
  }

  addMatches(/%%[\s\S]*?%%/g, (match) => ({
    contentFrom: match.index! + 2,
    contentTo: match.index! + match[0].length - 2,
    from: match.index!,
    kind: "comment",
    to: match.index! + match[0].length,
  }));

  addMatches(/!?\[\[([^\]\n]+)\]\]/g, (match) => {
    const from = match.index!;
    const embedded = match[0].startsWith("!");
    const contentFrom = from + (embedded ? 3 : 2);
    const separator = match[1].indexOf("|");
    const labelFrom = separator === -1 ? contentFrom : contentFrom + separator + 1;
    const labelTo = from + match[0].length - 2;

    return {
      contentFrom,
      contentTo: labelTo,
      from,
      kind: embedded ? "embed" : "wikilink",
      labelFrom,
      labelTo,
      target: separator === -1 ? match[1] : match[1].slice(0, separator),
      to: from + match[0].length,
    };
  });

  addMatches(/==(?=\S)([^\n]*?\S)==/g, (match) => ({
    contentFrom: match.index! + 2,
    contentTo: match.index! + match[0].length - 2,
    from: match.index!,
    kind: "highlight",
    to: match.index! + match[0].length,
  }));

  return tokens.sort((left, right) => left.from - right.from || left.to - right.to);
}

export function getObsidianCalloutFamily(type: string) {
  const normalized = type.toLowerCase();
  if (["abstract", "summary", "tldr"].includes(normalized)) return "abstract";
  if (["todo"].includes(normalized)) return "todo";
  if (["tip", "hint", "important"].includes(normalized)) return "tip";
  if (["success", "check", "done"].includes(normalized)) return "success";
  if (["question", "help", "faq"].includes(normalized)) return "question";
  if (["warning", "caution", "attention"].includes(normalized)) return "warning";
  if (["failure", "fail", "missing"].includes(normalized)) return "failure";
  if (["danger", "error"].includes(normalized)) return "danger";
  if (["bug"].includes(normalized)) return "bug";
  if (["example"].includes(normalized)) return "example";
  if (["quote", "cite"].includes(normalized)) return "quote";
  if (["info"].includes(normalized)) return "info";
  return "note";
}

export function findObsidianCalloutBlocks(value: string): ObsidianCalloutBlock[] {
  const lines = getSourceLines(value);
  const callouts: ObsidianCalloutBlock[] = [];

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const match = /^(\s*(?:>\s*)+)\[!([a-zA-Z0-9_-]+)\]([+-])?(?:[ \t]+(.*))?$/.exec(
      line.text,
    );
    if (!match) continue;

    const lineFroms = [line.from];
    let finalLine = line;
    for (let nextIndex = index + 1; nextIndex < lines.length; nextIndex += 1) {
      const nextLine = lines[nextIndex];
      if (!/^\s*>/.test(nextLine.text)) break;
      lineFroms.push(nextLine.from);
      finalLine = nextLine;
    }

    const markerFrom = line.from + match[1].length;
    const markerTo = markerFrom + match[2].length + 3 + (match[3]?.length ?? 0);
    const rawTitle = match[4] ?? "";
    const title = rawTitle.trim();
    const rawTitleOffset = rawTitle ? line.text.lastIndexOf(rawTitle) : -1;

    callouts.push({
      fold: match[3] === "+" || match[3] === "-" ? match[3] : null,
      from: line.from,
      headerLineFrom: line.from,
      lineFroms,
      markerFrom,
      markerTo,
      title,
      titleFrom: rawTitleOffset === -1 ? null : line.from + rawTitleOffset,
      to: finalLine.to,
      type: match[2].toLowerCase(),
    });
  }

  return callouts;
}
