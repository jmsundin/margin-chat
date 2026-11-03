import katex from "katex";
import { Marked } from "marked";
import { createLatexMarkedExtensions } from "./latexSyntax";

export * from "./latexSyntax";

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

export const latexMarkedExtensions = createLatexMarkedExtensions(renderLatexToHtml);

/** The shared lexer, rendering formulas with KaTeX when it parses. */
export const latexMarkdownLexer = new Marked({ gfm: true, extensions: latexMarkedExtensions });
