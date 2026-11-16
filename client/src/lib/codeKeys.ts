import type { CodeLanguage } from "./codeRunner/languages";

/** A key on the row above the phone keyboard while a code block has the caret. */
export type CodeKey = { kind: "tab" } | { kind: "text"; text: string };

/** The attribute a code editor carries so the row knows it holds the caret, and in which language. */
export const CODE_KEYS_ATTRIBUTE = "data-code-keys";

const BRACES = ["{", "}", "(", ")", ";", "=", "\"", "[", "]", "<", ">", "'", ":", ",", ".", "!", "&", "|", "+", "-", "*", "/", "_"];
const SYMBOLS: Record<CodeLanguage, string[]> = {
  java: BRACES,
  javascript: BRACES,
  typescript: BRACES,
  python: [":", "(", ")", "[", "]", "{", "}", "=", "\"", "'", "_", "#", ",", ".", "<", ">", "+", "-", "*", "/", "%"],
  sql: ["*", ",", "(", ")", "'", "=", ";", "<", ">", ".", "%", "_", "\"", "!", "+", "-"],
  html: ["<", ">", "/", "=", "\"", "'", "-", "!", "&", ";", "#", "."],
  css: ["{", "}", ":", ";", ".", "#", "(", ")", "-", ",", "%", ">", "\"", "*"],
};

/** Words a SQL block offers above its symbols. Other languages have no word row. */
const SQL_WORDS = ["SELECT", "FROM", "WHERE", "JOIN", "GROUP BY", "ORDER BY", "LEFT JOIN", "ON", "AND", "OR", "AS", "COUNT", "SUM", "AVG", "DISTINCT", "HAVING", "LIMIT", "DESC", "IN", "NOT", "NULL", "LIKE", "INSERT INTO", "VALUES", "UPDATE", "SET", "DELETE", "CREATE TABLE"];

export function codeKeyRows(language: string | null | undefined): { words: string[]; symbols: string[] } {
  const symbols = SYMBOLS[language as CodeLanguage] ?? BRACES;
  return { words: language === "sql" ? SQL_WORDS : [], symbols };
}

/** What a word key types: the word and a space, with a space before it when it would touch the text ahead of the caret. */
export function codeWordInsert(word: string, before: string) {
  return `${before && !/[\s(,]$/u.test(before) ? " " : ""}${word} `;
}

const CODE_KEY_EVENT = "margin-code-key";

/** Lets a code editor answer the key row. */
export function listenForCodeKeys(element: HTMLElement, press: (key: CodeKey) => void) {
  const listener = (event: Event) => press((event as CustomEvent<CodeKey>).detail);
  element.addEventListener(CODE_KEY_EVENT, listener);
  return () => element.removeEventListener(CODE_KEY_EVENT, listener);
}

export function sendCodeKey(element: HTMLElement, key: CodeKey) {
  element.dispatchEvent(new CustomEvent<CodeKey>(CODE_KEY_EVENT, { detail: key }));
}
