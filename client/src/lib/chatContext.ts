import type {
  BranchAnchor,
  Conversation,
  ConversationDocument,
  Message,
} from "../types";
import {
  getStandaloneNote,
  getStandaloneNoteContextMessageId,
} from "./standaloneNotes";
import { getConversationPath } from "./tree";
import { getCurrentDocumentText } from "./documentSources";
import type { VaultFileContext } from "./vaultFileContext";
import { vaultFileTitle } from "./vaultFileDocuments";

export interface ConversationContext {
  ancestorContext: Array<{
    branchAnchor: BranchAnchor | null;
    id: string;
    messages: Message[];
    title: string;
  }>;
  branchAnchor: BranchAnchor | null;
  documents: ConversationDocument[];
  /** The PDF or image the conversation is about, added just before sending. */
  file?: VaultFileContext;
  id: string;
  parentId: string | null;
  title: string;
}

export function getConversationRequestPayload(
  conversations: Record<string, Conversation>,
  conversation: Conversation,
): ConversationContext {
  const contextPath = conversation.parentId
    ? [
        ...getConversationPath(conversations, conversation.parentId),
        conversation,
      ]
    : [conversation];
  const ancestorContext = contextPath.slice(0, -1).map((ancestor, index) => {
    const descendant = contextPath[index + 1];
    const sourceMessageId =
      descendant?.branchAnchor?.sourceConversationId === ancestor.id
        ? descendant.branchAnchor.sourceMessageId
        : null;
    const sourceMessageIndex = sourceMessageId
      ? ancestor.messages.findIndex((message) => message.id === sourceMessageId)
      : -1;
    const standaloneNote = getStandaloneNote(ancestor);

    return {
      branchAnchor: ancestor.branchAnchor,
      id: ancestor.id,
      messages: ancestor.document
        ? [{ content: documentContextText(ancestor), createdAt: ancestor.updatedAt, id: `document-context-${ancestor.id}`, role: "user" as const }]
        : standaloneNote?.content.trim()
        ? [
            {
              content: standaloneNote.content,
              createdAt: standaloneNote.updatedAt,
              id: getStandaloneNoteContextMessageId(standaloneNote.id),
              role: "user" as const,
            },
          ]
        : sourceMessageIndex >= 0
          ? ancestor.messages.slice(0, sourceMessageIndex + 1)
          : ancestor.messages,
      title: ancestor.title,
    };
  });

  return {
    ancestorContext,
    branchAnchor: conversation.branchAnchor,
    documents: conversation.documents ?? [],
    id: conversation.id,
    parentId: conversation.parentId,
    title: conversation.title,
  };
}

/** A document's text for its branches; a PDF or image is named, since its content travels separately. */
function documentContextText(conversation: Conversation) {
  const text = getCurrentDocumentText(conversation);
  if (!conversation.vaultFile) return text;
  const kind = conversation.vaultFile.kind === "pdf" ? "PDF" : "image";
  return [`The ${kind} “${vaultFileTitle(conversation.vaultFile.path)}”.`, text.trim() ? `The user's notes on it:\n${text}` : ""].filter(Boolean).join("\n\n");
}
