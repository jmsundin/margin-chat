/**
 * Code blocks that run inside documents: which fence languages run, and where
 * those fences sit in a block's Markdown so an edit in the code editor can be
 * written back to exactly one fence.
 */

export type CodeLanguage = "sql" | "python" | "javascript" | "typescript" | "java" | "html" | "css";

/** How a language shows its result: run on demand with output, or rendered live as a page. */
export type CodeCellKind = "run" | "preview";

const ALIASES: Record<string, CodeLanguage> = {
  sql: "sql", sqlite: "sql",
  python: "python", py: "python", python3: "python",
  javascript: "javascript", js: "javascript", mjs: "javascript",
  typescript: "typescript", ts: "typescript",
  java: "java",
  html: "html", htm: "html",
  css: "css",
};

export const CODE_LANGUAGE_LABELS: Record<CodeLanguage, string> = {
  sql: "SQL", python: "Python", javascript: "JavaScript", typescript: "TypeScript", java: "Java", html: "HTML", css: "CSS",
};

/** The runnable language a fence's info string names (its first word), or null. */
export function runnableLanguage(info: string | null | undefined): CodeLanguage | null {
  const word = (info ?? "").trim().split(/[\s{]/u)[0]?.toLowerCase() ?? "";
  return ALIASES[word] ?? null;
}

export function codeCellKind(language: CodeLanguage): CodeCellKind {
  return language === "html" || language === "css" ? "preview" : "run";
}

export interface RunnableFence {
  language: CodeLanguage;
  /** Where the fence starts (its opening line) and ends (after its closing line). */
  start: number;
  end: number;
  /** The code between the fence lines. */
  from: number;
  to: number;
  source: string;
}

const OPENING = /^([ \t]{0,3})(`{3,}|~{3,})([^\n`]*)\n/gmu;

/**
 * Every fenced code block in `markdown` whose language runs, in order. An
 * unclosed fence runs to the end, as Markdown reads it. Fences of other
 * languages are skipped whole, so code inside them is never mistaken for a fence.
 */
export function findRunnableFences(markdown: string): RunnableFence[] {
  const fences: RunnableFence[] = [];
  OPENING.lastIndex = 0;
  for (let match = OPENING.exec(markdown); match; match = OPENING.exec(markdown)) {
    const from = match.index + match[0].length;
    const marker = match[2];
    const closing = new RegExp(`^[ \\t]{0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`, "mu");
    const close = closing.exec(markdown.slice(from));
    const to = close ? from + close.index : markdown.length;
    const end = close ? to + close[0].length : markdown.length;
    const language = runnableLanguage(match[3]);
    if (language) fences.push({ language, start: match.index, end, from, to, source: markdown.slice(from, to).replace(/\n$/u, "") });
    OPENING.lastIndex = end;
  }
  return fences;
}

/** `markdown` with one fence's code swapped for `source`, keeping the fence lines as written. */
export function replaceFenceSource(markdown: string, fence: RunnableFence, source: string): string {
  const body = source.replace(/\n+$/u, "");
  const closed = fence.to < markdown.length || markdown.slice(fence.from, fence.to).endsWith("\n");
  return markdown.slice(0, fence.from) + body + (closed && body ? "\n" : "") + markdown.slice(fence.to);
}

/**
 * Writes a code editor's text back into a block: the `index`-th runnable fence
 * at or after `partFrom`, but only while that fence still holds `previous`.
 * Returns null when the block changed underneath (another device, the AI), so
 * the caller never overwrites text it has not seen.
 */
export function writeFenceSource(content: string, partFrom: number, index: number, previous: string, next: string): string | null {
  const fences = findRunnableFences(content).filter((fence) => fence.start >= partFrom);
  // Trailing blank lines aren't kept, so text that differs only there is the same code.
  const holds = (candidate: RunnableFence) => candidate.source.replace(/\n+$/u, "") === previous.replace(/\n+$/u, "");
  let fence: RunnableFence | undefined = fences[index];
  if (!fence || !holds(fence)) {
    const same = fences.filter(holds);
    fence = same.length === 1 ? same[0] : undefined;
  }
  if (!fence) return null;
  return replaceFenceSource(content, fence, next);
}

/** A document's runnable cells in reading order, as later cells see them. */
export interface CodeCellSibling { language: CodeLanguage; source: string }

const SAMPLE_PAGE = `<h1>Heading</h1>
<p>A paragraph with <a href="#">a link</a> and <strong>bold text</strong>.</p>
<ul><li>First item</li><li>Second item</li></ul>
<button type="button">A button</button>`;

/**
 * The page an HTML or CSS cell shows. A CSS cell styles the nearest HTML cell
 * above it, and an HTML cell takes every CSS cell between it and the next HTML
 * cell, so "HTML, then CSS" reads as one example. CSS with no HTML above it
 * styles a small sample page.
 */
export function previewPage(cells: ReadonlyArray<CodeCellSibling>, index: number): { html: string; css: string[]; htmlIndex: number | null } {
  let htmlIndex: number | null = null;
  if (cells[index]?.language === "html") htmlIndex = index;
  else for (let at = index - 1; at >= 0; at -= 1) if (cells[at].language === "html") { htmlIndex = at; break; }
  const css: string[] = [];
  for (let at = (htmlIndex ?? -1) + 1; at < cells.length && cells[at].language !== "html"; at += 1) {
    if (cells[at].language === "css" && (htmlIndex !== null || at <= index)) css.push(cells[at].source);
  }
  return { html: htmlIndex === null ? SAMPLE_PAGE : cells[htmlIndex].source, css, htmlIndex };
}

/** The SQL cells above `index` in a document, run first so later queries see their tables. */
export function sqlSetup(cells: ReadonlyArray<CodeCellSibling>, index: number): string[] {
  return cells.slice(0, Math.max(0, index)).filter((cell) => cell.language === "sql").map((cell) => cell.source);
}

/** A full HTML document for a preview frame. */
export function previewDocument(html: string, css: ReadonlyArray<string>, dark: boolean): string {
  const styles = css.map((sheet) => `<style>\n${sheet.replace(/<\/style/giu, "<\\/style")}\n</style>`).join("\n");
  const base = `<style>:root{color-scheme:${dark ? "dark" : "light"}}body{margin:12px;font:15px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif;${dark ? "background:#1b1d22;color:#e6e6e6" : "background:#fff;color:#1f2328"}}</style>`;
  if (/<html[\s>]/iu.test(html)) {
    const head = /<head[^>]*>/iu.exec(html);
    if (head) return html.slice(0, head.index + head[0].length) + base + html.slice(head.index + head[0].length).replace(/<\/head>/iu, `${styles}</head>`);
    return html.replace(/<html[^>]*>/iu, (tag) => `${tag}<head>${base}${styles}</head>`);
  }
  return `<!doctype html><html><head><meta charset="utf-8">${base}${styles}</head><body>\n${html}\n</body></html>`;
}

/** For Java snippets without a class: wraps statements in a main method so `System.out.println(1 + 2);` runs. */
export function javaProgram(source: string): string {
  if (/\bclass\s+\w+/u.test(source) || /\b(?:record|interface|enum)\s+\w+/u.test(source)) return source;
  const imports: string[] = [];
  const body = source.split("\n").filter((line) => {
    if (/^\s*import\s+[\w.*]+\s*;\s*$/u.test(line)) { imports.push(line.trim()); return false; }
    return true;
  });
  return [...new Set(["import java.util.*;", "import java.util.stream.*;", ...imports])].join("\n")
    + "\n\npublic class Main {\n    public static void main(String[] args) throws Exception {\n"
    + body.map((line) => (line.trim() ? `        ${line}` : "")).join("\n")
    + "\n    }\n}\n";
}
