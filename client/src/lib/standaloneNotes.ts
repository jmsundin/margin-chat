import type { Conversation, ConversationNote, Message } from "../types";

const STANDALONE_NOTE_CONTEXT_MESSAGE_PREFIX = "standalone-note-context-";

export function getStandaloneNote(
  conversation: Conversation,
): ConversationNote | null {
  if (conversation.kind !== "note") {
    return null;
  }

  return (
    (conversation.notes ?? []).find((note) => note.kind === "standalone") ??
    null
  );
}

export function isStandaloneNoteConversation(conversation: Conversation) {
  return conversation.kind === "note";
}

export function getStandaloneNoteContextMessageId(noteId: string) {
  return `${STANDALONE_NOTE_CONTEXT_MESSAGE_PREFIX}${noteId}`;
}

export function upsertStandaloneNoteContextMessage(
  messages: Message[],
  note: ConversationNote,
  createdAt: string,
): Message[] {
  const contextMessageId = getStandaloneNoteContextMessageId(note.id);
  const existingMessage = messages.find(
    (message) => message.id === contextMessageId,
  );
  const contextMessage: Message = {
    content: note.content.trim()
      ? note.content
      : "(This standalone note is currently empty.)",
    createdAt: existingMessage?.createdAt ?? createdAt,
    id: contextMessageId,
    role: "user",
  };

  return existingMessage
    ? messages.map((message) =>
        message.id === contextMessageId ? contextMessage : message,
      )
    : [...messages, contextMessage];
}
