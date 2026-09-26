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
    // Do not turn prices such as "$5 and $10" into a formula, or jump over
    // another dollar sign looking for a later, unrelated equation's closer.
    if (delimiter === "$" && (/\s/.test(source[end - 1]) || /\d/.test(source[end + 1] ?? "") || source[end + 1] === "$")) return null;
    return { raw: source.slice(0, end + closer.length), latex, displayMode: display, delimiter };
  }
  return null;
}

/** Marked handles code spans/fences first; this locates unescaped math in its text. */
export function findLatexStart(source: string, displayMode?: boolean): number {
  for (let index = 0; index < source.length; index += 1) {
    if ((source[index] === "$" || source[index] === "\\") && !escapedAt(source, index) && readLatexAtStart(source.slice(index), displayMode)) return index;
  }
  return -1;
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
    start(source) {
      const candidate = /(?:^|\n) {0,3}(?:\$\$|\\\[)/g;
      for (const match of source.matchAll(candidate)) {
        const start = match.index! + (match[0].startsWith("\n") ? 1 : 0);
        if (readLatexAtStart(source.slice(start).replace(/^ {0,3}/, ""), true)) return start;
      }
      return undefined;
    },
    tokenizer(source) {
      const indent = /^ {0,3}/.exec(source)![0];
      const math = readLatexAtStart(source.slice(indent.length), true);
      if (!math) return undefined;
      const trailing = /^[ \t]*(?:\r?\n|$)/.exec(source.slice(indent.length + math.raw.length));
      if (!trailing) return undefined;
      return { ...math, type: "latexBlock", raw: indent + math.raw + trailing[0] };
    },
    renderer(token) { return `${renderLatexToHtml(token.latex, true, token.raw)}\n`; },
  },
  {
    name: "latexInline", level: "inline",
    start(source) { return findLatexStart(source); },
    tokenizer(source) {
      const math = readLatexAtStart(source);
      return math ? { ...math, type: "latexInline" } : undefined;
    },
    renderer(token) { return renderLatexToHtml(token.latex, token.displayMode, token.raw); },
  },
];

/** Shared lexer prevents display formulas with blank lines from being split apart. */
export const latexMarkdownLexer = new Marked({ gfm: true, extensions: latexMarkedExtensions });
