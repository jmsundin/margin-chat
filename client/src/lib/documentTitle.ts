import type { Conversation } from "../types";
import {
  DEFAULT_CHILD_CHAT_TITLE,
  DEFAULT_MAIN_CHAT_TITLE,
  DEFAULT_SIDE_CHAT_TITLE,
  DEFAULT_STANDALONE_NOTE_TITLE,
} from "../initialState";
import { getEditableDocumentText } from "./editableDocument";

/** Placeholder titles the app assigns; anything else was chosen by the user. */
const PLACEHOLDER_DOCUMENT_TITLES = new Set([
  "",
  DEFAULT_MAIN_CHAT_TITLE,
  DEFAULT_SIDE_CHAT_TITLE,
  DEFAULT_CHILD_CHAT_TITLE,
  DEFAULT_STANDALONE_NOTE_TITLE,
  "Side chat",
  "Untitled document",
  "New note",
]);

/** Enough text for a title to say something about the document. */
export const MIN_DOCUMENT_TITLE_CONTENT_LENGTH = 160;
/** Stays under the title endpoint's 8,000 character prompt limit. */
export const MAX_DOCUMENT_TITLE_CONTENT_LENGTH = 6_000;
/** Wait for typing to pause before asking for a title. */
export const DOCUMENT_TITLE_IDLE_MS = 2_500;

export function isPlaceholderDocumentTitle(title: string): boolean {
  return PLACEHOLDER_DOCUMENT_TITLES.has(title.trim());
}

/** The content to title a document from, or null when it should keep its title. */
export function getDocumentTitleSource(conversation: Conversation): string | null {
  if (!conversation.document || !isPlaceholderDocumentTitle(conversation.title)) return null;
  const text = getEditableDocumentText(conversation).replace(/\s+/gu, " ").trim();
  if (text.length < MIN_DOCUMENT_TITLE_CONTENT_LENGTH) return null;
  return text.slice(0, MAX_DOCUMENT_TITLE_CONTENT_LENGTH);
}
