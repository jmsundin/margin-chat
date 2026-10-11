import type { Conversation, MessageAnchorLink } from "../types";
import { getConversationAnnotationPreview, summarizeAnnotationText } from "./annotationPreview";
import { getDocumentLinkTarget } from "./documentLinks";
import { getEditableDocumentText } from "./editableDocument";

/** The highlighted passages of a document: branches anchored in it and its links to other documents, by source message. */
export function getAnchorsByMessageId(
  conversations: Record<string, Conversation>,
  conversationId: string,
): Record<string, MessageAnchorLink[]> {
  const links: Record<string, MessageAnchorLink[]> = {};

  for (const conversation of Object.values(conversations)) {
    if (
      !conversation.branchAnchor ||
      conversation.branchAnchor.sourceConversationId !== conversationId
    ) {
      continue;
    }

    const messageId = conversation.branchAnchor.sourceMessageId;
    const bucket = links[messageId] ?? [];

    bucket.push({
      branchConversationId: conversation.id,
      title: conversation.title,
      anchor: conversation.branchAnchor,
      preview: getConversationAnnotationPreview(conversation),
    });

    links[messageId] = bucket;
  }

  for (const link of conversations[conversationId]?.document?.links ?? []) {
    const target = getDocumentLinkTarget(link, conversations);
    if (!target) continue;
    const bucket = links[link.sourceMessageId] ?? [];
    bucket.push({
      branchConversationId: link.id,
      kind: "document-link",
      targetBlockId: link.targetBlockId,
      title: target.conversation.title || "Untitled document",
      anchor: { ...link, sourceConversationId: conversationId, prompt: "" },
      preview: {
        kind: target.conversation.kind === "note" ? "note" : "chat",
        content: summarizeAnnotationText(target.block?.content ?? getEditableDocumentText(target.conversation)),
      },
    });
    links[link.sourceMessageId] = bucket;
  }

  return links;
}
