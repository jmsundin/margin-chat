import { createContext, useContext, useEffect, useLayoutEffect, useRef, type RefObject } from "react";

/** Long enough to say what a document is about, short enough for a tab. */
export const MAX_SUGGESTED_TITLE_LENGTH = 60;

/** Inline Markdown removed, keeping the words a reader sees. Leaves no Markdown syntax behind. */
export function stripInlineMarkdown(text: string): string {
  return text
    .replace(/<!--[\s\S]*?-->/gu, " ")
    .replace(/!\[\[[^\]]*\]\]/gu, " ")
    .replace(/!\[[^\]]*\]\([^)]*\)/gu, " ")
    .replace(/\[\[([^\]|#]*)(?:#[^\]|]*)?(?:\|([^\]]*))?\]\]/gu, (_match, target: string, alias?: string) => alias || target)
    .replace(/\[\^[^\]]*\]/gu, "")
    .replace(/\[([^\]]*)\]\([^)]*\)/gu, "$1")
    .replace(/\[([^\]]*)\]\[[^\]]*\]/gu, "$1")
    .replace(/<(https?:\/\/[^>\s]+)>/gu, "$1")
    .replace(/<\/?[a-z][^>]*>/giu, " ")
    .replace(/\bhttps?:\/\/\S+/gu, " ")
    .replace(/\s\^[\w-]+\s*$/u, "")
    .replace(/(^|\s)#(?=[\p{L}\d])/gu, "$1")
    .replace(/\\([\\`*_{}[\]()#+\-.!|~=<>])/gu, "$1")
    .replace(/==|~~|\*+|`+|\$+/gu, "")
    .replace(/(^|[^\p{L}\d])_+|_+(?=$|[^\p{L}\d])/gu, "$1")
    .replace(/[_|[\]<>#\\]/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

/** A title made from plain words: no Markdown, one line, trimmed to a sensible length at a word. */
export function toPlainDocumentTitle(value: string, maxLength = MAX_SUGGESTED_TITLE_LENGTH): string {
  let title = stripInlineMarkdown(value.replace(/^\s*(?:#{1,6}\s+|>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)+/u, ""));
  title = title.replace(/^title\s*:\s*/iu, "").replace(/^["'“‘]+|["'”’]+$/gu, "").trim();
  if (title.length > maxLength) {
    const clipped = title.slice(0, maxLength + 1);
    const lastSpace = clipped.lastIndexOf(" ");
    title = lastSpace >= maxLength / 3 ? clipped.slice(0, lastSpace) : title.slice(0, maxLength);
  }
  return title.replace(/[\s.,;:\-–—(]+$/u, "").trim();
}

function firstSentence(text: string): string {
  const match = /^(.+?[.!?])(?:\s|$)/u.exec(text);
  // A very short first sentence ("Hi.") says little, so keep reading.
  return match && match[1].length >= 12 ? match[1].replace(/[.]$/u, "") : text;
}

/**
 * A quick title from a document's own Markdown, without AI: its first heading,
 * or else the first sentence of its first paragraph. Empty when there is nothing to name it from.
 */
export function suggestLocalDocumentTitle(markdown: string): string {
  const lines = markdown.replace(/\r\n?/gu, "\n").split("\n");
  let index = 0;
  if (lines[0]?.trim() === "---") {
    const end = lines.findIndex((line, lineIndex) => lineIndex > 0 && /^(?:---|\.\.\.)\s*$/u.test(line));
    if (end > 0) index = end + 1;
  }
  let fence: string | null = null;
  let firstText: string | null = null;
  let firstHeading: string | null = null;
  for (; index < lines.length; index += 1) {
    const line = lines[index].trim();
    const fenceMatch = /^(`{3,}|~{3,})/u.exec(line);
    if (fence) { if (fenceMatch && line.startsWith(fence)) fence = null; continue; }
    if (fenceMatch) { fence = fenceMatch[1]; continue; }
    if (!line || /^(?:[-*_]\s*){3,}$/u.test(line) || line.startsWith("|") || /^\$\$/u.test(line)) continue;
    const next = lines[index + 1]?.trim() ?? "";
    const heading = /^#{1,6}\s+(.+)$/u.exec(line)?.[1] ?? (/^(?:=+|-+)$/u.test(next) && firstText === null ? line : null);
    if (heading !== null) {
      const plain = toPlainDocumentTitle(heading);
      if (plain) {
        if (firstText === null) return plain;
        firstHeading ??= plain;
      }
      continue;
    }
    const plain = stripInlineMarkdown(line.replace(/^\s*(?:>\s*|[-*+]\s+(?:\[[ xX]\]\s+)?|\d+[.)]\s+)+/u, ""));
    if (plain && /[\p{L}\d]/u.test(plain)) firstText ??= plain;
    if (firstText !== null && index > 40) break;
  }
  if (firstText === null) return firstHeading ?? "";
  return toPlainDocumentTitle(firstSentence(firstText));
}

/** What the rename field can suggest for one document; null when it already has a name or nothing to name it from. */
export interface DocumentTitleSuggestion {
  /** Shown at once. */
  local: string;
  /** A better title from AI, when the document may be shared with AI. */
  ai: ((signal: AbortSignal) => Promise<string>) | null;
}

export type SuggestDocumentTitle = (conversationId: string) => DocumentTitleSuggestion | null;

/** Provided by the workspace; rename fields outside it make no suggestion. */
export const DocumentTitleSuggestionContext = createContext<SuggestDocumentTitle | null>(null);

/**
 * Fills a rename field with a suggested name when it opens for an untitled document, selected so typing
 * or Backspace replaces it. An AI title replaces the quick one only while the person hasn't typed.
 */
export function useSuggestedDocumentTitle(args: {
  conversationId: string | null;
  open: boolean;
  value: string;
  setValue: (value: string) => void;
  input: RefObject<HTMLInputElement | null>;
}): boolean {
  const suggest = useContext(DocumentTitleSuggestionContext);
  const suggestRef = useRef(suggest);
  const { conversationId, open, value, setValue, input } = args;
  suggestRef.current = suggest;
  const suggested = useRef<string | null>(null);
  const valueRef = useRef(value);
  valueRef.current = value;
  const reselect = useRef(false);
  const setValueRef = useRef(setValue);
  setValueRef.current = setValue;

  useEffect(() => {
    suggested.current = null;
    if (!open || !conversationId || !suggestRef.current) return;
    const suggestion = suggestRef.current(conversationId);
    if (!suggestion) return;
    if (suggestion.local) {
      suggested.current = suggestion.local;
      reselect.current = true;
      setValueRef.current(suggestion.local);
    }
    if (!suggestion.ai) return;
    const controller = new AbortController();
    suggestion.ai(controller.signal).then((title) => {
      const plain = toPlainDocumentTitle(title);
      if (controller.signal.aborted || !plain) return;
      // Never replace what the person typed.
      const untouched = suggested.current === null ? !valueRef.current.trim() || valueRef.current === suggestion.local
        : valueRef.current === suggested.current;
      if (!untouched || plain === valueRef.current) return;
      suggested.current = plain;
      reselect.current = document.activeElement === input.current && (input.current?.selectionStart ?? 0) === 0
        && input.current?.selectionEnd === valueRef.current.length;
      setValueRef.current(plain);
    }).catch(() => {
      // Keep the quick suggestion when AI is unavailable.
    });
    return () => controller.abort();
  }, [conversationId, input, open]);

  useLayoutEffect(() => {
    if (!reselect.current || !open) return;
    reselect.current = false;
    if (document.activeElement === input.current) input.current?.select();
  }, [input, open, value]);

  return open && suggested.current !== null && value === suggested.current;
}
