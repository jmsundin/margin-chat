import type { AppState, BranchAnchor, Conversation } from "../types";
import type { ImportedWebDocument } from "./chatStream";
import type { DocumentBlock, EditableDocument } from "./editableDocument";
import { getEditableDocument, splitDocumentMarkdown } from "./editableDocument";
import { addChildConversation } from "./workspaceCommands";
import { closeDocument } from "./documentWorkspace";

const SOURCE_LINE = /^Source: <(https?:\/\/[^>\s]+)>/u;

/** The address an imported page came from, read from the "Source: <…>" line it starts with. */
export function importedSourceUrl(conversation: Conversation): string | null {
  return SOURCE_LINE.exec(conversation.document?.blocks[0]?.content ?? "")?.[1] ?? null;
}

function importedDocument(markdown: string, createdAt: string, idBase: string): EditableDocument {
  let offset = 0;
  const blocks = splitDocumentMarkdown(markdown).map((part, index): DocumentBlock => {
    const block: DocumentBlock = { id: index ? `${idBase}:part:${offset}` : idBase, kind: "markdown", content: part, createdAt, updatedAt: createdAt, authorship: "user" };
    offset += part.length;
    return block;
  });
  return { schemaVersion: 1, blocks, prompts: [], generations: [] };
}

/** Where the parent links to a page: its link text, else its address, else the parent's opening line. */
function linkPassage(parent: Conversation, document: ImportedWebDocument) {
  const blocks = getEditableDocument(parent).blocks;
  const addresses = [document.url, `${document.url}/`];
  for (const block of blocks) {
    for (const address of addresses) {
      const link = block.content.indexOf(`](${address})`);
      if (link < 0) continue;
      const open = block.content.lastIndexOf("[", link);
      if (open >= 0 && block.content.slice(open + 1, link).trim()) return { block, from: open + 1, to: link };
    }
  }
  for (const block of blocks) {
    const at = document.title ? block.content.indexOf(document.title) : -1;
    if (at >= 0) return { block, from: at, to: at + document.title.length };
  }
  const block = blocks[0];
  return block ? { block, from: 0, to: Math.min(block.content.length, 80) } : null;
}

/**
 * Create the pages agent mode imported. The first page becomes a side document of
 * the document the user asked from, and stays open; every linked page becomes a
 * child of the page that links to it, anchored to that link and left closed. A page
 * already imported anywhere in the workspace is reused, so going a level deeper
 * adds only the new pages under the ones saved before.
 */
export function addImportedWebDocuments(state: AppState, parentId: string, documents: ImportedWebDocument[], options: {
  createId: (prefix: string) => string;
  now?: string;
}): { state: AppState; createdIds: string[] } {
  if (!state.conversations[parentId]) return { state, createdIds: [] };
  const now = options.now ?? new Date().toISOString();
  const byUrl = new Map<string, string>();
  for (const conversation of Object.values(state.conversations)) {
    const url = importedSourceUrl(conversation);
    if (url && !byUrl.has(url)) byUrl.set(url, conversation.id);
  }
  const createdIds: string[] = [];
  let next = state;
  for (const document of documents) {
    if (byUrl.has(document.url)) continue;
    const parent = next.conversations[document.parentUrl ? byUrl.get(document.parentUrl) ?? "" : parentId];
    if (!parent) continue;
    const id = options.createId("conversation");
    const passage = document.parentUrl ? linkPassage(parent, document) : null;
    const branchAnchor: BranchAnchor | null = passage ? {
      id: options.createId("anchor"), sourceConversationId: parent.id,
      sourceMessageId: passage.block.sourceMessageId ?? `document:${passage.block.id}`, sourceBlockId: passage.block.id,
      startOffset: passage.from, endOffset: passage.to, quote: passage.block.content.slice(passage.from, passage.to),
      prompt: "Imported linked page", createdAt: now,
    } : null;
    const child: Conversation = {
      id, kind: "chat", title: document.title, parentId: parent.id,
      serviceId: parent.serviceId, modelId: parent.modelId, ...(parent.ai ? { ai: structuredClone(parent.ai) } : {}),
      branchAnchor, childIds: [], documents: [], messages: [], notes: [], createdAt: now, updatedAt: now,
      document: importedDocument(document.markdown, now, options.createId("block")),
    };
    next = addChildConversation(next, child);
    if (!next.conversations[id]) continue;
    if (document.parentUrl) next = closeDocument(next, id);
    byUrl.set(document.url, id);
    createdIds.push(id);
  }
  return { state: next, createdIds };
}
