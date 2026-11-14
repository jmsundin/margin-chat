/**
 * AI code suggestions in code cells, as in VS Code: write a comment saying
 * what you want, and the code for it appears as faint text after it, put in
 * only when you press Tab. This file holds the plain-text parts: which lines
 * are comments in each language, what the model is shown, and how its answer
 * is shaped to fit where the cursor is.
 */

import { CODE_LANGUAGE_LABELS, type CodeCellSibling, type CodeLanguage } from "./languages";

/** Whole-line comments each language writes, as patterns that capture the comment's words. */
const LINE_COMMENTS: Record<CodeLanguage, RegExp[]> = {
  python: [/^#+\s*(.*)$/u],
  sql: [/^--+\s*(.*)$/u, /^\/\*+\s*(.*?)\s*\*+\/$/u],
  javascript: [/^\/\/+\s*(.*)$/u, /^\/\*+\s*(.*?)\s*\*+\/$/u],
  typescript: [/^\/\/+\s*(.*)$/u, /^\/\*+\s*(.*?)\s*\*+\/$/u],
  java: [/^\/\/+\s*(.*)$/u, /^\/\*+\s*(.*?)\s*\*+\/$/u],
  css: [/^\/\*+\s*(.*?)\s*\*+\/$/u],
  html: [/^<!--\s*(.*?)\s*-->$/u],
};

/** The words of a whole-line comment in `language`, or null when the line isn't one. */
export function commentText(language: CodeLanguage, line: string): string | null {
  const trimmed = line.trim();
  for (const pattern of LINE_COMMENTS[language]) {
    const match = pattern.exec(trimmed);
    if (match) return match[1].trim();
  }
  return null;
}

/** A comment is worth answering once it says something: a few letters, not a divider or a shebang. */
function asksForCode(comment: string): boolean {
  return (comment.match(/\p{L}/gu)?.length ?? 0) >= 3 && !comment.startsWith("!");
}

export interface SuggestionTrigger {
  /** What the comment asks for. */
  comment: string;
  /** Where the suggestion goes. */
  at: number;
  /** True when the cursor is at the end of the comment line, so the code starts on a new line. */
  newLine: boolean;
  /** The comment line's indentation, which the suggested code starts at. */
  indent: string;
  /** Names this comment, so the same one isn't asked about again after it was dismissed. */
  key: string;
}

/**
 * Whether the cursor sits where a suggestion belongs: at the end of a comment
 * line, or on an empty line right under one (after pressing Enter).
 */
export function findSuggestionTrigger(language: CodeLanguage, doc: string, cursor: number): SuggestionTrigger | null {
  const lineStart = doc.lastIndexOf("\n", cursor - 1) + 1;
  const nextBreak = doc.indexOf("\n", cursor);
  const lineEnd = nextBreak < 0 ? doc.length : nextBreak;
  if (doc.slice(cursor, lineEnd).trim()) return null;
  const line = doc.slice(lineStart, lineEnd);
  const indentOf = (text: string) => /^[ \t]*/u.exec(text)?.[0] ?? "";
  const own = commentText(language, line);
  if (own !== null) {
    if (!asksForCode(own)) return null;
    return { comment: own, at: lineEnd, newLine: true, indent: indentOf(line), key: `${own}\n${doc.slice(0, lineStart).split("\n").length}` };
  }
  if (line.trim() || lineStart === 0) return null;
  const aboveStart = doc.lastIndexOf("\n", lineStart - 2) + 1;
  const above = doc.slice(aboveStart, lineStart - 1);
  const comment = commentText(language, above);
  if (comment === null || !asksForCode(comment)) return null;
  return { comment, at: cursor, newLine: false, indent: indentOf(line), key: `${comment}\n${doc.slice(0, aboveStart).split("\n").length}` };
}

const BEFORE_LIMIT = 6_000;
const AFTER_LIMIT = 2_000;
const SIBLINGS_LIMIT = 3_000;

/** What the model is shown: the language, the document's other cells, and this cell with the cursor marked. */
export function buildSuggestionPrompt(args: { language: CodeLanguage; doc: string; at: number; siblings?: ReadonlyArray<CodeCellSibling>; own?: number }): string {
  const before = args.doc.slice(Math.max(0, args.at - BEFORE_LIMIT), args.at);
  const after = args.doc.slice(args.at, args.at + AFTER_LIMIT);
  let room = SIBLINGS_LIMIT;
  const others: string[] = [];
  for (const [index, cell] of (args.siblings ?? []).entries()) {
    if (index === args.own || !cell.source.trim() || room <= 0) continue;
    const source = cell.source.slice(0, room);
    room -= source.length;
    others.push(`[${CODE_LANGUAGE_LABELS[cell.language]} cell]\n${source}`);
  }
  return [
    `Language: ${CODE_LANGUAGE_LABELS[args.language]}`,
    ...(others.length ? ["", "Other code cells in this document:", ...others] : []),
    "",
    "The cell, with the cursor at <CURSOR>:",
    `${before}<CURSOR>${after}`,
  ].join("\n");
}

/**
 * The model's code shaped to go in at the cursor: indented like the comment,
 * starting on a new line when the cursor is at the end of the comment line,
 * and without a repeat of the comment itself.
 */
export function shapeSuggestion(code: string, trigger: SuggestionTrigger, language: CodeLanguage): string {
  const lines = code.replace(/\r\n?/gu, "\n").replace(/\t/gu, "    ").split("\n");
  while (lines.length && !lines[0].trim()) lines.shift();
  // Models often say the comment back before answering it.
  while (lines.length && commentText(language, lines[0]) === trigger.comment) lines.shift();
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  if (!lines.length) return "";
  const depth = Math.min(...lines.filter((line) => line.trim()).map((line) => /^ */u.exec(line)?.[0].length ?? 0));
  const indent = trigger.indent.replace(/\t/gu, "    ");
  const body = lines.map((line, index) => {
    if (!line.trim()) return "";
    const rest = line.slice(depth);
    return index === 0 && !trigger.newLine ? rest : indent + rest;
  });
  return (trigger.newLine ? "\n" : "") + body.join("\n");
}
