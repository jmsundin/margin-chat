import type { Conversation, DocumentBlock, DocumentLink } from "@margin-chat/workspace-contracts";
import { remapDocumentAnchor } from "./documentAnchors";
import { getDocumentSourceText, getEditableDocument } from "./editableDocument";

export interface DocumentLinkSelection {
  messageId: string;
  sourceBlockId?: string;
  startOffset: number;
  endOffset: number;
  quote: string;
}

/** Resolve against current authored blocks, never a removed block's historical message. */
export function getDocumentLinkTarget(link: DocumentLink, conversations: Record<string, Conversation>):
  { conversation: Conversation; block?: DocumentBlock } | null {
  const conversation = Object.hasOwn(conversations, link.targetConversationId) ? conversations[link.targetConversationId] : undefined;
  if (!conversation) return null;
  if (!link.targetBlockId) return { conversation };
  const block = getEditableDocument(conversation).blocks.find((candidate) => candidate.id === link.targetBlockId);
  return block ? { conversation, block } : null;
}

function hasCurrentSource(source: Conversation, link: Pick<DocumentLink, "sourceMessageId" | "sourceBlockId" | "startOffset" | "endOffset" | "quote">): boolean {
  if (!link.quote.trim() || !Number.isSafeInteger(link.startOffset) || !Number.isSafeInteger(link.endOffset) ||
      link.startOffset < 0 || link.endOffset <= link.startOffset) return false;
  const content = getDocumentSourceText(source, link.sourceMessageId, link.sourceBlockId);
  return content !== undefined && link.endOffset <= content.length && content.slice(link.startOffset, link.endOffset) === link.quote;
}

/** Validate again at confirmation time: a picker may outlive its selected passage or destination. */
export function createDocumentLink(
  source: Conversation,
  target: Conversation | undefined,
  selection: DocumentLinkSelection,
  targetBlockId?: string,
  options: { id?: string; createdAt?: string } = {},
): DocumentLink | null {
  if (!target || targetBlockId !== undefined && !getEditableDocument(target).blocks.some((block) => block.id === targetBlockId)) return null;
  const link: DocumentLink = {
    id: options.id ?? `document-link:${crypto.randomUUID()}`,
    sourceMessageId: selection.messageId,
    ...(selection.sourceBlockId ? { sourceBlockId: selection.sourceBlockId } : {}),
    startOffset: selection.startOffset,
    endOffset: selection.endOffset,
    quote: selection.quote,
    targetConversationId: target.id,
    ...(targetBlockId ? { targetBlockId } : {}),
    createdAt: options.createdAt ?? new Date().toISOString(),
  };
  return hasCurrentSource(source, link) ? link : null;
}

/** Persist in the source document's existing JSON payload, preserving its branch tree. */
export function addDocumentLink(source: Conversation, link: DocumentLink): Conversation {
  if (!hasCurrentSource(source, link)) return source;
  const document = getEditableDocument(source);
  const links = document.links ?? [];
  if (links.some((candidate) => candidate.id === link.id ||
      candidate.sourceMessageId === link.sourceMessageId && candidate.sourceBlockId === link.sourceBlockId &&
      candidate.startOffset === link.startOffset && candidate.endOffset === link.endOffset &&
      candidate.targetConversationId === link.targetConversationId && candidate.targetBlockId === link.targetBlockId)) return source;
  return { ...source, updatedAt: link.createdAt, document: { ...document, links: [...links, link] } };
}

export function removeDocumentLink(source: Conversation, linkId: string): Conversation {
  const document = source.document;
  if (!document?.links?.some((link) => link.id === linkId)) return source;
  return { ...source, updatedAt: new Date().toISOString(),
    document: { ...document, links: document.links.filter((link) => link.id !== linkId) } };
}

/** Follow untouched source text through edits/splits; removed passages retain a detached history. */
export function remapDocumentLinks(before: Conversation, after: Conversation): Conversation {
  if (before.id !== after.id || !after.document?.links?.length) return after;
  const links = after.document.links.map((link) => remapDocumentAnchor(link, before, after));
  if (links.every((link, index) => link === after.document!.links![index])) return after;
  return { ...after, document: { ...after.document, links } };
}
