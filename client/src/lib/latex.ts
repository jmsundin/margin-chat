import katex from "katex";
import { Marked, type TokenizerAndRendererExtension } from "marked";

export type LatexToken = {
  raw: string;
  latex: string;
  displayMode: boolean;
  delimiter: "$" | "$$" | "\\(" | "\\[";
};

function escapedAt(source: string, index: number) {
  let slashes = 0;
  while (index > 0 && source[--index] === "\\") slashes += 1;
  return slashes % 2 === 1;
}

/** Parse a delimited formula at the current Markdown cursor, preserving its source. */
export function readLatexAtStart(source: string, displayMode?: boolean): LatexToken | null {
  const delimiter = source.startsWith("$$") ? "$$"
    : source.startsWith("\\[") ? "\\["
    : source.startsWith("\\(") ? "\\("
    : source.startsWith("$") ? "$" : null;
  if (!delimiter) return null;
  const display = delimiter === "$$" || delimiter === "\\[";
  if (displayMode !== undefined && displayMode !== display) return null;
  if (delimiter === "$" && /\s/.test(source[1] ?? "")) return null;
  const closer = delimiter === "\\[" ? "\\]" : delimiter === "\\(" ? "\\)" : delimiter;
  let end = delimiter.length;
  while ((end = source.indexOf(closer, end)) !== -1) {
    if (escapedAt(source, end)) { end += closer.length; continue; }
    const latex = source.slice(delimiter.length, end);
    if (!latex.trim() || !display && /[\r\n]/.test(latex)) return null;
    // "\[\[Title\]\]" is an escaped wiki link that older document saves wrote, not an equation.
    if (delimiter === "\\[" && /^\\?\[/.test(latex)) return null;
    // Do not turn prices such as "$5 and $10" into a formula, or jump over
    // another dollar sign looking for a later, unrelated equation's closer.
    if (delimiter === "$" && (/\s/.test(source[end - 1]) || /\d/.test(source[end + 1] ?? "") || source[end + 1] === "$")) return null;
    return { raw: source.slice(0, end + closer.length), latex, displayMode: display, delimiter };
  }
  return null;
}

/**
 * Inline math inside a line. "\[" only opens display math at the start of a
 * line (see readBlockLatex): mid-line it is an escaped bracket, as in "\[1\]".
 */
export function readInlineLatexAtStart(source: string, displayMode?: boolean): LatexToken | null {
  const math = readLatexAtStart(source, displayMode);
  return math?.delimiter === "\\[" ? null : math;
}

/** Marked handles code spans/fences first; this locates unescaped inline math in its text. */
export function findLatexStart(source: string, displayMode?: boolean): number {
  for (let index = source.search(/[$\\]/); index !== -1 && index < source.length; index += 1) {
    if ((source[index] === "$" || source[index] === "\\") && !escapedAt(source, index) && readInlineLatexAtStart(source.slice(index), displayMode)) return index;
  }
  return -1;
}

/** Display math that starts a line and ends its line, as Marked block extensions need. */
export function readBlockLatex(source: string): (LatexToken & { indent: string; trailing: string }) | null {
  const indent = /^ {0,3}/.exec(source)![0];
  const math = readLatexAtStart(source.slice(indent.length), true);
  if (!math) return null;
  const trailing = /^[ \t]*(?:\r?\n|$)/.exec(source.slice(indent.length + math.raw.length));
  return trailing ? { ...math, indent, trailing: trailing[0] } : null;
}

/** Only line starts can open block math, so a paragraph is never split mid-line. */
export function findBlockLatexStart(source: string): number | undefined {
  for (const match of source.matchAll(/(?:^|\n) {0,3}(?:\$\$|\\\[)/g)) {
    const start = match.index! + (match[0].startsWith("\n") ? 1 : 0);
    if (readBlockLatex(source.slice(start))) return start;
  }
  return undefined;
}

function escapeHtml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;").replaceAll("'", "&#39;");
}

/** Untrusted equations cannot enable HTML, external resources, or shared macros. */
export function renderLatexToHtml(latex: string, displayMode = false, source?: string): string {
  const className = displayMode ? "document-math-display" : "document-math-inline";
  try {
    const html = katex.renderToString(latex, {
      displayMode, output: "htmlAndMathml", trust: false, throwOnError: true,
      strict: "ignore", maxExpand: 1000, maxSize: 50,
    });
    return `<span class="${className}" data-latex="${escapeHtml(latex)}">${html}</span>`;
  } catch {
    return `<span class="${className} document-math-error" data-latex="${escapeHtml(latex)}">${escapeHtml(source ?? (displayMode ? `$$${latex}$$` : `$${latex}$`))}</span>`;
  }
}

export const latexMarkedExtensions: TokenizerAndRendererExtension[] = [
  {
    name: "latexBlock", level: "block",
    start(source) { return findBlockLatexStart(source); },
    tokenizer(source) {
      const math = readBlockLatex(source);
      if (!math) return undefined;
      const { indent, trailing, ...token } = math;
      return { ...token, type: "latexBlock", raw: indent + math.raw + trailing };
    },
    renderer(token) { return `${renderLatexToHtml(token.latex, true, token.raw)}\n`; },
  },
  {
    name: "latexInline", level: "inline",
    start(source) { return findLatexStart(source); },
    tokenizer(source) {
      const math = readInlineLatexAtStart(source);
      return math ? { ...math, type: "latexInline" } : undefined;
    },
    renderer(token) { return renderLatexToHtml(token.latex, token.displayMode, token.raw); },
  },
];

/** Shared lexer prevents display formulas with blank lines from being split apart. */
export const latexMarkdownLexer = new Marked({ gfm: true, extensions: latexMarkedExtensions });
