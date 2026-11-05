import { titleMarkdownPath } from "@margin-chat/workspace-contracts";
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

/** Who line authorship credits an imported page to: X for posts and threads, otherwise the site. */
function importOrigin(url: string): NonNullable<DocumentBlock["origin"]> {
  let host = "";
  try { host = new URL(url).hostname.replace(/^www\./u, ""); } catch { /* A page without an address is still an import. */ }
  const x = TWEET.test(host);
  return { type: "import", source: x ? "x" : "web", ...(host ? { label: (x ? "X" : host).slice(0, 120) } : {}) };
}

function importedDocument(markdown: string, createdAt: string, idBase: string, url: string): EditableDocument {
  let offset = 0;
  const origin = importOrigin(url);
  const blocks = splitDocumentMarkdown(markdown).map((part, index): DocumentBlock => {
    const block: DocumentBlock = { id: index ? `${idBase}:part:${offset}` : idBase, kind: "markdown", content: part, createdAt, updatedAt: createdAt, authorship: "user", origin };
    offset += part.length;
    return block;
  });
  return { schemaVersion: 1, blocks, prompts: [], generations: [] };
}

const MARKDOWN_LINK = /(?<!!)\[([^\]\n]*)\]\(\s*<?(https?:\/\/[^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/gu;
const TWEET = /^(?:www\.|mobile\.)?(?:x|twitter|fxtwitter|fixupx|vxtwitter|fixvx)\.com$/iu;

/** One key per page: X posts by their id, other pages without a fragment or trailing slash (as the server names them). */
export function importedPageKey(value: string): string | null {
  let url: URL;
  try { url = new URL(value); } catch { return null; }
  if (TWEET.test(url.hostname)) {
    const id = /\/status(?:es)?\/(\d{1,25})(?:\/|$)/u.exec(url.pathname)?.[1];
    if (id) return `x-post:${id}`;
  }
  url.hash = "";
  url.pathname = url.pathname.replace(/\/{2,}/gu, "/").replace(/(.)\/+$/u, "$1");
  return url.href;
}

/** A wiki link target that finds `conversation` in Margin Chat and in Obsidian: its file name, without .md. */
export function documentWikiTarget(conversation: Pick<Conversation, "id" | "title">) {
  return titleMarkdownPath("", conversation.title, conversation.id).replace(/\.md$/u, "");
}

const wikiLabel = (text: string) => text.replace(/[[\]|\n]/gu, " ").replace(/\s+/gu, " ").trim();

/**
 * Turn the parent's Markdown links to an imported page into wiki links to its
 * document, `[[File name|link text]]`, so they open the saved copy and show on the Map.
 */
function linkToImported(parent: Conversation, url: string, child: Pick<Conversation, "id" | "title">): Conversation {
  const key = importedPageKey(url);
  const document = parent.document;
  if (!key || !document) return parent;
  const target = documentWikiTarget(child);
  let changed = false;
  const blocks = document.blocks.map((block) => {
    const content = block.content.replace(MARKDOWN_LINK, (match, label: string, href: string) => {
      if (importedPageKey(href) !== key) return match;
      changed = true;
      const text = wikiLabel(label.replace(/[*_`]/gu, "")) || wikiLabel(child.title);
      return `[[${target}|${text}]]`;
    });
    return content === block.content ? block : { ...block, content };
  });
  return changed ? { ...parent, document: { ...document, blocks } } : parent;
}

/** Where the parent links to a page: its wiki link's text, else its title, else the parent's opening line. */
function linkPassage(parent: Conversation, child: Pick<Conversation, "id" | "title">) {
  const blocks = getEditableDocument(parent).blocks;
  const opening = `[[${documentWikiTarget(child)}|`;
  for (const block of blocks) {
    const at = block.content.indexOf(opening);
    if (at < 0) continue;
    const from = at + opening.length;
    const to = block.content.indexOf("]]", from);
    if (to > from) return { block, from, to };
  }
  for (const block of blocks) {
    const at = child.title ? block.content.indexOf(child.title) : -1;
    if (at >= 0) return { block, from: at, to: at + child.title.length };
  }
  const block = blocks[0];
  return block ? { block, from: 0, to: Math.min(block.content.length, 80) } : null;
}

/**
 * Create the pages agent mode imported. The first page becomes a side document of
 * the document the user asked from, and stays open; every linked page becomes a
 * child of the page that links to it, anchored to that link and left closed, and
 * the parent's link to it becomes a [[wiki link]] to the new document. A page
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
    const key = importedPageKey(importedSourceUrl(conversation) ?? "");
    if (key && !byUrl.has(key)) byUrl.set(key, conversation.id);
  }
  const createdIds: string[] = [];
  let next = state;
  const withConversation = (conversation: Conversation) => {
    next = { ...next, conversations: { ...next.conversations, [conversation.id]: conversation } };
  };
  for (const document of documents) {
    const key = importedPageKey(document.url);
    if (!key) continue;
    const parent = next.conversations[document.parentUrl ? byUrl.get(importedPageKey(document.parentUrl) ?? "") ?? "" : parentId];
    if (!parent) continue;
    const existing = next.conversations[byUrl.get(key) ?? ""];
    if (existing) {
      // Saved before: the parent still gets its wiki link to the saved copy.
      if (document.parentUrl && existing.id !== parent.id) {
        const linked = linkToImported(parent, document.url, existing);
        if (linked !== parent) withConversation({ ...linked, updatedAt: now });
      }
      continue;
    }
    const id = options.createId("conversation");
    const child = { id, title: document.title };
    let source = parent;
    if (document.parentUrl) {
      source = linkToImported(parent, document.url, child);
      if (source !== parent) withConversation({ ...source, updatedAt: now });
    }
    const passage = document.parentUrl ? linkPassage(source, child) : null;
    const branchAnchor: BranchAnchor | null = passage ? {
      id: options.createId("anchor"), sourceConversationId: source.id,
      sourceMessageId: passage.block.sourceMessageId ?? `document:${passage.block.id}`, sourceBlockId: passage.block.id,
      startOffset: passage.from, endOffset: passage.to, quote: passage.block.content.slice(passage.from, passage.to),
      prompt: "Imported linked page", createdAt: now,
    } : null;
    const conversation: Conversation = {
      id, kind: "chat", title: document.title, parentId: source.id,
      serviceId: source.serviceId, modelId: source.modelId, ...(source.ai ? { ai: structuredClone(source.ai) } : {}),
      branchAnchor, childIds: [], documents: [], messages: [], notes: [], createdAt: now, updatedAt: now,
      document: importedDocument(document.markdown, now, options.createId("block"), document.url),
    };
    next = addChildConversation(next, conversation);
    if (!next.conversations[id]) continue;
    if (document.parentUrl) next = closeDocument(next, id);
    byUrl.set(key, id);
    createdIds.push(id);
  }
  return { state: next, createdIds };
}
