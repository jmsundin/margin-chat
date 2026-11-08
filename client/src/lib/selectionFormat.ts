/**
 * Formatting the selected text from the selection toolbar writes Markdown into the block, the same
 * way typing it would: `**bold**`, `# Heading`, `- item` and so on. Each one toggles: applied to text
 * that already has it, it takes it off.
 */

export type InlineFormat = "bold" | "italic" | "strike" | "code";
export type LineFormat = "text" | "h1" | "h2" | "h3" | "bullets" | "numbers" | "quote";
export type SelectionFormat = InlineFormat | LineFormat;

const INLINE_MARKS: Record<InlineFormat, string> = { bold: "**", italic: "*", strike: "~~", code: "`" };
const LINE_PREFIX = /^(\s*)(?:#{1,6}[ \t]+|[-*+][ \t]+(?:\[[ xX]\][ \t]+)?|\d+[.)][ \t]+|>[ \t]?)?/;

export function isInlineFormat(format: SelectionFormat): format is InlineFormat {
  return format in INLINE_MARKS;
}

/** The passage without the spaces a drag often picks up at either end. */
function trimRange(content: string, from: number, to: number) {
  while (from < to && /\s/.test(content[from]!)) from += 1;
  while (to > from && /\s/.test(content[to - 1]!)) to -= 1;
  return to > from ? { from, to } : null;
}

function wrapped(content: string, from: number, to: number, mark: string) {
  if (content.slice(from - mark.length, from) !== mark || content.slice(to, to + mark.length) !== mark) return false;
  // `*` inside `**` is bold, not italic.
  if (mark === "*" && (content[from - 2] === "*" && content[to + 1] === "*") && !(content[from - 3] === "*" && content[to + 2] === "*")) return false;
  return true;
}

/** The selection itself starts and ends with the mark, as a triple-click on a bold line selects it. */
function inside(content: string, from: number, to: number, mark: string) {
  if (to - from <= mark.length * 2) return false;
  if (content.slice(from, from + mark.length) !== mark || content.slice(to - mark.length, to) !== mark) return false;
  // `**bold**` is not italic, though it starts with `*`.
  if (mark === "*" && content[from + 1] === "*" && content[from + 2] !== "*") return false;
  return true;
}

function lineRange(content: string, from: number, to: number) {
  const start = content.lastIndexOf("\n", from - 1) + 1;
  const newline = content.indexOf("\n", Math.max(from, to - 1));
  return { start, end: newline < 0 ? content.length : newline };
}

function linePrefix(format: LineFormat, index: number) {
  switch (format) {
    case "h1": return "# ";
    case "h2": return "## ";
    case "h3": return "### ";
    case "bullets": return "- ";
    case "numbers": return `${index + 1}. `;
    case "quote": return "> ";
    default: return "";
  }
}

function hasLineFormat(line: string, format: LineFormat) {
  const text = line.trimStart();
  switch (format) {
    case "h1": return /^#[ \t]/.test(text);
    case "h2": return /^##[ \t]/.test(text);
    case "h3": return /^###[ \t]/.test(text);
    case "bullets": return /^[-*+][ \t]/.test(text);
    case "numbers": return /^\d+[.)][ \t]/.test(text);
    case "quote": return /^>/.test(text);
    default: return !LINE_PREFIX.exec(line)?.[0].trim();
  }
}

/** True when the whole selection already has this format, so its button shows pressed. */
export function hasSelectionFormat(content: string, from: number, to: number, format: SelectionFormat): boolean {
  if (isInlineFormat(format)) {
    const range = trimRange(content, from, to);
    return Boolean(range && (wrapped(content, range.from, range.to, INLINE_MARKS[format]) || inside(content, range.from, range.to, INLINE_MARKS[format])));
  }
  if (from < 0 || to > content.length || to < from) return false;
  const { start, end } = lineRange(content, from, to);
  const lines = content.slice(start, end).split("\n").filter((line) => line.trim());
  return lines.length > 0 && lines.every((line) => hasLineFormat(line, format));
}

/**
 * The block's Markdown with the format put on (or taken off) the selection: inline marks wrap each
 * selected line's words; line formats change every line the selection touches. Null when there is
 * nothing to format.
 */
export function applySelectionFormat(content: string, from: number, to: number, format: SelectionFormat): string | null {
  if (from < 0 || to > content.length || to < from) return null;
  if (isInlineFormat(format)) {
    const range = trimRange(content, from, to);
    if (!range) return null;
    const mark = INLINE_MARKS[format];
    if (wrapped(content, range.from, range.to, mark)) {
      return content.slice(0, range.from - mark.length) + content.slice(range.from, range.to) + content.slice(range.to + mark.length);
    }
    if (inside(content, range.from, range.to, mark)) {
      return content.slice(0, range.from) + content.slice(range.from + mark.length, range.to - mark.length) + content.slice(range.to);
    }
    const marked = content.slice(range.from, range.to).split("\n").map((line) => {
      const lead = line.length - line.trimStart().length;
      const text = line.trim();
      return text ? `${line.slice(0, lead)}${mark}${text}${mark}${line.slice(lead + text.length)}` : line;
    }).join("\n");
    return content.slice(0, range.from) + marked + content.slice(range.to);
  }
  const { start, end } = lineRange(content, from, to);
  const target: LineFormat = format !== "text" && hasSelectionFormat(content, from, to, format) ? "text" : format;
  let index = 0;
  const lines = content.slice(start, end).split("\n").map((line) => {
    if (!line.trim()) return line;
    const match = LINE_PREFIX.exec(line);
    const indent = match?.[1] ?? "";
    const rest = line.slice(match?.[0].length ?? 0);
    return `${indent}${linePrefix(target, index++)}${rest}`;
  });
  const next = content.slice(0, start) + lines.join("\n") + content.slice(end);
  return next === content ? null : next;
}
