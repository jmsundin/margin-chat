import { decodeReadableMarkdown, readDocumentGraphProperties, readFrontmatterValues } from "@margin-chat/workspace-contracts";
import { PASSAGE_SOURCES, likePatterns, passageSnippet, titleMatcher, vaultSearchTerms } from "../../vault/search.mjs";

const SEARCH_RESULTS = 8;
const TITLE_SCAN_LIMIT = 100;
const RELATED_RESULTS = 20;
const MESSAGES_READ = 12;
const MESSAGE_CHARACTERS = 700;

const documentId = { document_id: { type: "string", description: "Exact document ID from search_vault or list_related." } };

/** Tools over the user's saved cloud vault, offered only within the AI context the user allowed. */
export const VAULT_TOOL_DEFINITIONS = [
  {
    name: "search_vault",
    description: "Search the titles and text of the user's saved documents, notes and chats in their cloud vault: title matches first, then text matches, each newest first. Every word must appear, so use one to three distinctive keywords. Private margin comments are never searched.",
    parameters: { type: "object", properties: { query: { type: "string", description: "One to three keywords." } }, required: ["query"], additionalProperties: false },
  },
  {
    name: "read_document",
    description: "Read one saved document, note or chat by ID. Long text is shortened; a chat returns its newest messages.",
    parameters: { type: "object", properties: documentId, required: ["document_id"], additionalProperties: false },
  },
  {
    name: "list_related",
    description: "List what one document is connected to on the user's map: its parent, its children, typed relations it declares (such as supports, cites or part-of), and plain links in either direction.",
    parameters: { type: "object", properties: documentId, required: ["document_id"], additionalProperties: false },
  },
];

const VAULT_TOOL_NAMES = new Set(VAULT_TOOL_DEFINITIONS.map((tool) => tool.name));

/**
 * Which documents the vault tools may reach: all of them when the user lets AI
 * search their workspace, only the chosen material (plus this conversation and
 * its ancestors) when they picked it, and none otherwise. Null means no vault tools.
 */
export function vaultToolAccess(chatRequest, workspace) {
  if (!workspace?.userId || !workspace.vault?.configured) return null;
  const ai = chatRequest.ai ?? {};
  if (ai.contextScope === "workspace") return () => true;
  if (ai.contextScope !== "selected") return null;
  const allowed = new Set([chatRequest.conversation.id, ...(ai.selectedConversationIds ?? []),
    ...(chatRequest.conversation.ancestorContext ?? []).map((item) => item.id)]);
  return (id) => allowed.has(id);
}

const clip = (text, maximum) => text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
const isoDate = (value) => {
  const date = value ? new Date(value) : null;
  return date && !Number.isNaN(date.getTime()) ? date.toISOString() : null;
};

/** The passage around a match; for a document, from the block holding every term if one does. */
function snippetFor(row, terms) {
  if (!Array.isArray(row.contents)) return passageSnippet(row.content, terms)?.snippet;
  const blocks = row.contents.filter((value) => typeof value === "string");
  const block = blocks.find((content) => terms.every((term) => content.toLocaleLowerCase().includes(term)))
    ?? blocks.find((content) => passageSnippet(content, terms));
  return block ? passageSnippet(block, terms)?.snippet : undefined;
}

function linkAliases(path) {
  const withoutExtension = path.replace(/\.md$/iu, "");
  return [path, withoutExtension, withoutExtension.slice(withoutExtension.lastIndexOf("/") + 1)];
}

/**
 * `snapshots` is the request's local snapshot, preferred for reading because it
 * carries edits that may not be saved yet. `readCharacters` caps one document's text.
 */
export function createVaultTools({ chatRequest, workspace, snapshots, readCharacters }) {
  const permits = vaultToolAccess(chatRequest, workspace);
  if (!permits) return null;
  const { userId, vault, database } = workspace;
  let indexed;
  // Margin comments are their own files in the vault; only documents, notes and chats are listed.
  const entries = () => (indexed ??= vault.index(userId).then((index) => index.entries.filter((entry) => entry.type === "conversation")));
  const summary = (entry, extra) => ({ document_id: entry.id, title: entry.title, kind: entry.kind, updated_at: entry.updated ?? entry.created ?? null, ...extra });

  async function search(args) {
    const query = String(args.query ?? "").trim();
    const terms = vaultSearchTerms(query);
    if (!terms.length) return { query, results: [], total_matches: 0, truncated: false };
    const listed = await entries();
    const hits = new Map();
    let truncated = false;
    const matchesTitle = titleMatcher(terms);
    for (const entry of listed) {
      if (!permits(entry.id) || !matchesTitle(entry.title)) continue;
      if (hits.size >= TITLE_SCAN_LIMIT) { truncated = true; break; }
      hits.set(entry.id, summary(entry, { matched: "title" }));
    }
    let textSearchFailed = !database?.searchAgentPassages;
    const rows = textSearchFailed ? [] : (await Promise.all(PASSAGE_SOURCES.map((source) =>
      database.searchAgentPassages({ userId, source, patterns: likePatterns(terms), limit: 20 }).catch((error) => {
        console.error("Agent vault passage search failed", error);
        textSearchFailed = true;
        return [];
      })))).flat();
    rows.sort((left, right) => (isoDate(right.updated_at) ?? "").localeCompare(isoDate(left.updated_at) ?? ""));
    const wanted = new Set(rows.map((row) => row.conversation_id).filter((id) => !hits.has(id)));
    const entryById = new Map(wanted.size ? listed.filter((entry) => wanted.has(entry.id)).map((entry) => [entry.id, entry]) : []);
    for (const row of rows) {
      const id = row.conversation_id;
      if (!permits(id)) continue;
      const snippet = snippetFor(row, terms);
      const hit = hits.get(id);
      if (hit) { if (snippet && !hit.snippet) hit.snippet = snippet; continue; }
      const entry = entryById.get(id);
      hits.set(id, { ...(entry ? summary(entry) : { document_id: id, title: row.title, updated_at: isoDate(row.updated_at) }),
        matched: "text", ...(snippet ? { snippet } : {}) });
    }
    const results = [...hits.values()];
    return {
      query, results: results.slice(0, SEARCH_RESULTS), total_matches: results.length, truncated: truncated || results.length > SEARCH_RESULTS,
      ...(textSearchFailed ? { warning: "Only titles were searched; document text could not be searched." } : {}),
    };
  }

  function outside(id) {
    return { document_id: id, found: false, error: "This document is outside the context the user allowed for AI." };
  }

  async function read(args) {
    const id = String(args.document_id ?? "");
    if (!permits(id)) return outside(id);
    const local = snapshots.get(id);
    const stored = local ? null : await database?.readAgentConversation?.({ userId, conversationId: id, messageLimit: MESSAGES_READ });
    const item = local
      ? { id, title: local.title, kind: local.kind, parentId: local.parentId, updatedAt: local.updatedAt,
        ...(local.kind === "note" ? { text: local.messages[0]?.content ?? "" } : { messages: local.messages.slice(-MESSAGES_READ), messageCount: local.messages.length }) }
      : stored;
    if (!item) return { document_id: id, found: false };
    const base = { document_id: id, title: item.title, kind: item.kind, parent_id: item.parentId ?? null, updated_at: item.updatedAt ?? null };
    if (typeof item.text === "string") {
      const text = clip(item.text, readCharacters);
      return { found: true, document: { ...base, text, truncated: text.length < item.text.length } };
    }
    const messages = item.messages.map((message) => ({ role: message.role, content: clip(message.content, MESSAGE_CHARACTERS) }));
    const truncated = item.messageCount > messages.length || item.messages.some((message) => message.content.length > MESSAGE_CHARACTERS);
    return { found: true, document: { ...base, messages, message_count: item.messageCount, truncated } };
  }

  async function typedRelations(entry) {
    try {
      const { bytes } = await vault.readFile({ userId, path: entry.path, revision: entry.revision });
      return readDocumentGraphProperties(readFrontmatterValues(decodeReadableMarkdown(bytes.toString("utf8")))).relationTargets;
    } catch {
      // Without the file the document's links are still listed, just without their types.
      return [];
    }
  }

  async function related(args) {
    const id = String(args.document_id ?? "");
    if (!permits(id)) return outside(id);
    const listed = await entries();
    const entry = listed.find((candidate) => candidate.id === id);
    if (!entry) return { document_id: id, found: false };
    const byPath = (path) => path ? listed.find((candidate) => candidate.path === path) : undefined;
    const byTarget = (target) => {
      const normalized = target.replace(/^\.\//u, "").replace(/\.md$/iu, "");
      return listed.find((candidate) => linkAliases(candidate.path).includes(normalized))
        ?? listed.find((candidate) => linkAliases(candidate.path).at(-1) === normalized.split("/").at(-1));
    };
    const connections = new Map();
    const add = (other, relation) => {
      if (other && other.id !== id && permits(other.id) && !connections.has(other.id)) connections.set(other.id, summary(other, { relation }));
    };
    add(byPath(entry.parentPath), "parent");
    for (const { type, target } of await typedRelations(entry)) add(byTarget(target), type);
    const linkedFrom = [];
    for (const other of listed) {
      if (other.parentPath === entry.path) add(other, "child");
      else if (other.linkedPaths?.includes(entry.path)) linkedFrom.push(other);
    }
    for (const path of entry.linkedPaths ?? []) add(byPath(path), "links to");
    for (const other of linkedFrom) add(other, "linked from");
    const all = [...connections.values()];
    return { found: true, document: { document_id: id, title: entry.title }, related: all.slice(0, RELATED_RESULTS),
      total_related: all.length, truncated: all.length > RELATED_RESULTS };
  }

  const handlers = { search_vault: search, read_document: read, list_related: related };
  return {
    has: (name) => VAULT_TOOL_NAMES.has(name),
    async run(name, args) {
      try {
        return await handlers[name](args);
      } catch (error) {
        console.error("Agent vault tool failed", error);
        return { ok: false, error: "The saved vault couldn't be read just now. Answer from what you already have." };
      }
    },
  };
}
