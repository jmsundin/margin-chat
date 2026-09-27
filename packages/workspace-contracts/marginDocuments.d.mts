import type { Conversation, ConversationNote } from "./types.mjs";
export function createMarginDocument(parent: Conversation, note: ConversationNote, documentId?: string, options?: { legacy?: boolean }): Conversation;
export function migrateMarginNotes(conversations: Record<string, Conversation>): Record<string, Conversation>;
export function isCompactDocument(conversation: Conversation | undefined): boolean;
