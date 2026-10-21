/**
 * Highlighting a selected passage writes Obsidian's `==text==` mark into the block's Markdown,
 * which Live Preview and Reading already draw as a highlight.
 */

const MARK = "==";

/** True when the passage sits directly inside a `==…==` mark. */
export function isMarkdownHighlighted(content: string, from: number, to: number): boolean {
  const range = trimRange(content, from, to);
  if (!range) return false;
  return content.slice(range.from - MARK.length, range.from) === MARK && content.slice(range.to, range.to + MARK.length) === MARK;
}

/**
 * Wrap the passage in `==…==`, or remove the mark when it is already highlighted.
 * Each line is marked on its own, since a mark can't span lines. Null when there is nothing to mark.
 */
export function toggleMarkdownHighlight(content: string, from: number, to: number): string | null {
  if (from < 0 || to > content.length || to <= from) return null;
  const range = trimRange(content, from, to);
  if (!range) return null;
  if (isMarkdownHighlighted(content, range.from, range.to)) {
    return content.slice(0, range.from - MARK.length) + content.slice(range.from, range.to) + content.slice(range.to + MARK.length);
  }
  const marked = content.slice(range.from, range.to).split("\n").map((line) => {
    const lead = line.length - line.trimStart().length;
    const text = line.trim();
    return text ? `${line.slice(0, lead)}${MARK}${text}${MARK}${line.slice(lead + text.length)}` : line;
  }).join("\n");
  return content.slice(0, range.from) + marked + content.slice(range.to);
}

/** The passage without the spaces a drag often picks up at either end; a mark can't start or end on one. */
function trimRange(content: string, from: number, to: number) {
  while (from < to && /\s/.test(content[from]!)) from += 1;
  while (to > from && /\s/.test(content[to - 1]!)) to -= 1;
  return to > from ? { from, to } : null;
}
