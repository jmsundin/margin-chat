import type { Conversation } from "../types";
import { getDocumentSourceText, getEditableDocument, getEditableDocumentText } from "./editableDocument";
import { getStandaloneNote, getStandaloneNoteContextMessageId } from "./standaloneNotes";

export interface PrimaryDocumentSource {
  sourceKind: "message" | "standalone-note" | "document";
  messageId?: string;
  noteId?: string;
  sourceBlockId?: string;
  content: string;
  role: "user" | "assistant";
  updatedAt: string;
}

/** Current editable blocks replace history for readers; annotations stay separate. */
export function getPrimaryDocumentSources(conversation: Conversation): PrimaryDocumentSource[] {
  if (conversation.document) return getEditableDocument(conversation).blocks.map((block) => ({
    sourceKind: "document", sourceBlockId: block.id,
    messageId: block.sourceMessageId ?? `document:${block.id}`, content: block.content,
    role: conversation.messages.find((message) => message.id === block.sourceMessageId)?.role === "assistant" ? "assistant" : "user",
    updatedAt: block.updatedAt,
  }));
  const note = getStandaloneNote(conversation);
  if (conversation.kind === "note") return note ? [{ sourceKind: "standalone-note", noteId: note.id, content: note.content, role: "user", updatedAt: note.updatedAt }] : [];
  return conversation.messages.filter((message) => (message.role === "user" || message.role === "assistant") && !message.id.startsWith(getStandaloneNoteContextMessageId("")))
    .map((message) => ({ sourceKind: "message", messageId: message.id, content: message.content, role: message.role as "user" | "assistant", updatedAt: message.createdAt }));
}

export function getCurrentDocumentText(conversation: Conversation): string {
  return conversation.document ? getEditableDocumentText(conversation) : getPrimaryDocumentSources(conversation).map((source) => source.content).join("\n\n");
}

/** Legacy references resolve against surviving blocks, never deleted history. */
export function resolvePrimaryDocumentSource(conversation: Conversation, source: {
  sourceKind: "conversation" | "message" | "standalone-note" | "document";
  messageId?: string;
  noteId?: string;
  sourceBlockId?: string;
}): string | undefined {
  if (source.sourceKind === "conversation") return conversation.title;
  if (source.sourceKind === "document") {
    const block = getEditableDocument(conversation).blocks.find((item) => item.id === source.sourceBlockId);
    if (!block) return undefined;
    return getDocumentSourceText(conversation, source.messageId ?? block.sourceMessageId ?? `document:${block.id}`, block.id);
  }
  if (source.sourceKind === "standalone-note") {
    const note = getStandaloneNote(conversation);
    if (!note || note.id !== source.noteId) return undefined;
    return conversation.document ? getEditableDocumentText(conversation) : note.content;
  }
  if (conversation.document) return source.messageId ? getDocumentSourceText(conversation, source.messageId, source.sourceBlockId) : undefined;
  const note = getStandaloneNote(conversation);
  if (note && source.messageId === getStandaloneNoteContextMessageId(note.id)) return note.content;
  return getPrimaryDocumentSources(conversation).find((item) => item.sourceKind === "message" && item.messageId === source.messageId)?.content;
}
