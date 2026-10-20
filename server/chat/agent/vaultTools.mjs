import { decodeReadableMarkdown, readDocumentGraphProperties, readFrontmatterValues } from "@margin-chat/workspace-contracts";
import { PASSAGE_SOURCES, likePatterns, passageSnippet, titleMatcher, vaultSearchTerms } from "../../vault/search.mjs";

const SEARCH_RESULTS = 8;
const INDEX_RESULTS = 20;
const TITLE_SCAN_LIMIT = 100;
const RELATED_RESULTS = 20;
const MESSAGES_READ = 12;
const MESSAGE_CHARACTERS = 700;

const documentId = { document_id: { type: "string", description: "Exact document ID from search_vault or list_related." } };

/** Tools over the user's saved cloud vault, offered only within the AI context the user allowed. */
export const VAULT_TOOL_DEFINITIONS = [
  {
    name: "search_vault",
    description: "Search the user's saved documents, notes, chats, uploaded files and PDFs in their cloud vault, by keyword and, when available, by meaning: title matches first, then the passages that best match, each with the section it sits under and a snippet. A short phrase describing what you want works as well as keywords. Private margin comments and documents the user hid from AI are never searched.",
    parameters: { type: "object", properties: { query: { type: "string", description: "A few keywords or a short phrase." } }, required: ["query"], additionalProperties: false },
  },
  {
    name: "read_document",
    description: "Read one saved document, note, chat or uploaded file by ID. Long text is shortened; a chat returns its newest messages.",
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
 * Which documents the vault tools may reach, from the request's agent scope: the
 * whole vault by default, only the chosen material (plus this conversation and
 * its ancestors) when the user limits it to that, and none when they limit it to
 * this conversation. Null means no vault tools.
 */
export function vaultToolAccess(chatRequest, workspace) {
  if (!workspace?.userId || !workspace.vault?.configured) return null;
  const ai = chatRequest.ai ?? {};
  const scope = ai.agentScope ?? "workspace";
  if (scope === "workspace") return () => true;
  if (scope !== "selected") return null;
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
  const allowed = vaultToolAccess(chatRequest, workspace);
  if (!allowed) return null;
  const { userId, vault, database } = workspace;
  let indexed;
  // Margin comments are their own files in the vault; only documents, notes and chats are listed.
  const entries = () => (indexed ??= vault.index(userId).then((index) => index.entries.filter((entry) => entry.type === "conversation")));
  // Documents the user hid from AI, by their file's frontmatter and by the saved
  // copy, so a document just hidden on another device is left out either way.
  let hiddenIds = new Set();
  let hiddenLoaded;
  const loadHidden = () => (hiddenLoaded ??= Promise.all([
    entries().then((listed) => listed.filter((entry) => entry.hiddenFromAI).map((entry) => entry.id)),
    database?.listAIHiddenIds ? database.listAIHiddenIds({ userId }) : [],
  ]).then(([listed, stored]) => { hiddenIds = new Set([...listed, ...stored]); }));
  const permits = (id) => allowed(id) && !hiddenIds.has(id);
  const summary = (entry, extra) => ({ document_id: entry.id, title: entry.title, kind: entry.kind, updated_at: entry.updated ?? entry.created ?? null, ...extra });

  /** The vault's passage index, best passage per document; null when it can't be searched. */
  async function indexHits(query) {
    if (!workspace.passages) return null;
    try {
      const found = await workspace.passages.search(query, { limit: INDEX_RESULTS });
      const best = new Map();
      for (const hit of found.results) {
        if (!permits(hit.id) || best.has(hit.id)) continue;
        best.set(hit.id, hit);
      }
      return { hits: [...best.values()], warning: found.warning };
    } catch (error) {
      console.error("Agent vault index search failed", error);
      return null;
    }
  }

  async function search(args) {
    await loadHidden();
    const query = String(args.query ?? "").trim();
    const terms = vaultSearchTerms(query);
    if (!terms.length) return { query, results: [], total_matches: 0, truncated: false };
    const indexed = indexHits(query);
    const listed = await entries();
    const hits = new Map();
    let truncated = false;
    const matchesTitle = titleMatcher(terms);
    for (const entry of listed) {
      if (!permits(entry.id) || !matchesTitle(entry.title)) continue;
      if (hits.size >= TITLE_SCAN_LIMIT) { truncated = true; break; }
      hits.set(entry.id, summary(entry, { matched: "title" }));
    }
    const index = await indexed;
    for (const hit of index?.hits ?? []) {
      const section = { ...(hit.heading ? { section: hit.heading } : {}), ...(hit.pageNumber ? { page: hit.pageNumber } : {}), snippet: hit.snippet };
      const existing = hits.get(hit.id);
      if (existing) { if (!existing.snippet) Object.assign(existing, section); continue; }
      const entry = hit.sourceKind === "conversation" ? listed.find((candidate) => candidate.id === hit.id) : null;
      hits.set(hit.id, { ...(entry ? summary(entry) : { document_id: hit.id, title: hit.title, kind: hit.kind, updated_at: hit.updatedAt ?? null }),
        matched: hit.matched === "meaning" ? "meaning" : "text", ...section });
    }
    // Word-part matches the index misses (such as "auth" in "authentication") follow.
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
    const warning = textSearchFailed && !index ? "Only titles were searched; document text could not be searched." : index?.warning;
    return {
      query, results: results.slice(0, SEARCH_RESULTS), total_matches: results.length, truncated: truncated || results.length > SEARCH_RESULTS,
      ...(warning ? { warning } : {}),
    };
  }

  function outside(id) {
    return { document_id: id, found: false, error: "This document is outside the context the user allowed for AI." };
  }

  async function read(args) {
    await loadHidden();
    const id = String(args.document_id ?? "");
    if (!permits(id)) return outside(id);
    const local = snapshots.get(id);
    const stored = local ? null : await database?.readAgentConversation?.({ userId, conversationId: id, messageLimit: MESSAGES_READ });
    const item = local
      ? { id, title: local.title, kind: local.kind, parentId: local.parentId, updatedAt: local.updatedAt,
        ...(local.kind === "note" ? { text: local.messages[0]?.content ?? "" } : { messages: local.messages.slice(-MESSAGES_READ), messageCount: local.messages.length }) }
      : stored;
    if (!item) return workspace.passages ? readFile(id) : { document_id: id, found: false };
    const base = { document_id: id, title: item.title, kind: item.kind, parent_id: item.parentId ?? null, updated_at: item.updatedAt ?? null };
    if (typeof item.text === "string") {
      const text = clip(item.text, readCharacters);
      return { found: true, document: { ...base, text, truncated: text.length < item.text.length } };
    }
    const messages = item.messages.map((message) => ({ role: message.role, content: clip(message.content, MESSAGE_CHARACTERS) }));
    const truncated = item.messageCount > messages.length || item.messages.some((message) => message.content.length > MESSAGE_CHARACTERS);
    // A PDF's document holds its notes and chat; the PDF's own text is in the vault index.
    const file = workspace.passages ? await fileText(id).catch(() => null) : null;
    return { found: true, document: { ...base, messages, message_count: item.messageCount, truncated,
      ...(file?.text ? { file_text: file.text, file_text_truncated: file.truncated } : {}) } };
  }

  /** A file's text as the vault index extracted it, page by page; null when it isn't indexed. */
  async function fileText(id) {
    const file = await workspace.passages.readFile(id);
    if (!file) return null;
    const full = file.passages.map((passage) => passage.pageNumber ? `[Page ${passage.pageNumber}]\n${passage.content}` : passage.content).join("\n\n");
    const text = clip(full, readCharacters);
    return { file, text, truncated: text.length < full.length };
  }

  /** An uploaded file or a vault PDF, from the text the vault index extracted from it. */
  async function readFile(id) {
    const found = await fileText(id);
    if (!found) return { document_id: id, found: false };
    const { file, text, truncated } = found;
    const base = { document_id: id, title: file.title, kind: "file", updated_at: file.updatedAt };
    if (!file.passages.length) {
      return { found: true, document: { ...base, text: "", truncated: false, ...(file.error ? { error: "This file's text couldn't be read." } : {}) } };
    }
    return { found: true, document: { ...base, text, truncated } };
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
    await loadHidden();
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
