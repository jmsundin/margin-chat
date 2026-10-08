import type { Conversation, ConversationGroup, ThreadCategoryId } from "../types";
import { buildSearchExploration, type SearchEvidenceRef } from "./searchExploration";
import { getConversationRootId } from "./tree";
import { searchVaultIndex } from "./vaultHydration";
import type { VaultIndexEntry, VaultSearchEvent, VaultSearchPassage } from "./vaultTypes";

/** Narrows one search; "family" means the focused document's root and everything under it. */
export type VaultSearchScope = "all" | "family" | "documents" | "notes" | "recent";

export type VaultSearchTarget =
  | { kind: "loaded"; conversationId: string }
  | { kind: "cloud"; path: string };

export interface VaultSearchDocumentHit {
  key: string;
  title: string;
  kindLabel: string;
  /** The family's root title when the document is not itself a root. */
  familyTitle?: string;
  updatedAt?: string;
  target: VaultSearchTarget;
}

export interface VaultSearchPassageHit {
  key: string;
  conversationId: string;
  title: string;
  kindLabel: string;
  familyTitle?: string;
  matchLabel: string;
  preview: string;
  passage: string;
  updatedAt: string;
  evidence: SearchEvidenceRef;
  /** Private notes: searchable here, never sent to a model. */
  localOnly: boolean;
  /** Set when the document is still in the cloud; opening downloads it first. */
  cloudPath?: string;
}

export interface VaultSearchRequest {
  query: string;
  scope: VaultSearchScope;
  /** The focused document, used by the family scope. */
  currentConversationId?: string;
}

export interface VaultSearchResults {
  query: string;
  scope: VaultSearchScope;
  /** Title matches; empty query lists recent documents instead. */
  documents: VaultSearchDocumentHit[];
  passages: VaultSearchPassageHit[];
  /** False while a provider is still sending passages for this request. */
  complete: boolean;
  /** Why some results may be missing, when the server could not finish. */
  notice?: string;
}

/** Where search results come from. Today it is the device plus the cloud title index;
 * a server index can replace it later by streaming passages through `emit`. */
export interface VaultSearchProvider {
  search(request: VaultSearchRequest, emit: (results: VaultSearchResults) => void): () => void;
}

export interface LocalVaultSearchInput {
  conversations: Record<string, Conversation>;
  cloudDocuments?: VaultIndexEntry[];
  groups?: Record<string, ConversationGroup>;
  categories?: Record<string, ThreadCategoryId>;
  /** For the "recent" scope; tests pass a fixed clock. */
  now?: number;
}

const RECENT_LIMIT = 8;
const YEAR_MS = 365 * 24 * 60 * 60 * 1000;

const fold = (value: string) => value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase();

export function vaultSearchTerms(query: string) {
  return fold(query).split(/\s+/u).filter(Boolean);
}

function kindLabel(conversation: Conversation) {
  if (conversation.document?.marginNote) return "Margin note";
  if (conversation.document) return conversation.parentId ? "Side document" : "Document";
  if (conversation.kind === "note") return "Note";
  return conversation.parentId ? "Branch chat" : "Chat";
}

function isNote(conversation: Conversation) {
  return conversation.kind === "note" || !!conversation.document?.marginNote;
}

function inScope(conversation: Conversation, request: VaultSearchRequest, familyRootId: string | null, conversations: Record<string, Conversation>, now: number) {
  switch (request.scope) {
    case "family": return !!familyRootId && getConversationRootId(conversations, conversation.id) === familyRootId;
    case "documents": return !isNote(conversation);
    case "notes": return isNote(conversation);
    case "recent": return now - Date.parse(conversation.updatedAt) <= YEAR_MS;
    default: return true;
  }
}

function cloudInScope(entry: VaultIndexEntry, scope: VaultSearchScope, now: number) {
  switch (scope) {
    // Cloud entries carry no family until downloaded, so the family scope stays on this device.
    case "family": return false;
    case "documents": return entry.kind !== "note";
    case "notes": return entry.kind === "note";
    case "recent": return now - Date.parse(entry.updated ?? entry.created ?? "") <= YEAR_MS;
    default: return true;
  }
}

function familyTitle(conversations: Record<string, Conversation>, conversation: Conversation) {
  const rootId = getConversationRootId(conversations, conversation.id);
  return rootId && rootId !== conversation.id ? conversations[rootId]?.title : undefined;
}

const newestFirst = (left?: string, right?: string) => (right ?? "").localeCompare(left ?? "");

/** One search over the documents on this device and the titles of those still in the cloud. */
export function searchLocalVault(request: VaultSearchRequest, input: LocalVaultSearchInput): VaultSearchResults {
  const { conversations, cloudDocuments = [], groups, categories } = input;
  const now = input.now ?? Date.now();
  const terms = vaultSearchTerms(request.query);
  const familyRootId = request.currentConversationId ? getConversationRootId(conversations, request.currentConversationId) : null;
  const scoped = Object.values(conversations).filter((conversation) => inScope(conversation, request, familyRootId, conversations, now));
  const loadedHit = (conversation: Conversation): VaultSearchDocumentHit => ({
    key: `loaded:${conversation.id}`, title: conversation.title, kindLabel: kindLabel(conversation),
    familyTitle: familyTitle(conversations, conversation), updatedAt: conversation.updatedAt,
    target: { kind: "loaded", conversationId: conversation.id },
  });

  if (!terms.length) {
    const documents = scoped.filter((conversation) => !conversation.document?.marginNote)
      .sort((left, right) => newestFirst(left.updatedAt, right.updatedAt)).slice(0, RECENT_LIMIT).map(loadedHit);
    return { query: request.query, scope: request.scope, documents, passages: [], complete: true };
  }

  const loadedDocuments = scoped.filter((conversation) => {
    const title = fold(conversation.title);
    return terms.every((term) => title.includes(term));
  }).map(loadedHit);
  const cloud = searchVaultIndex(cloudDocuments.filter((entry) => cloudInScope(entry, request.scope, now)), request.query)
    .map((entry): VaultSearchDocumentHit => ({
      key: `cloud:${entry.path}`, title: entry.title, kindLabel: entry.kind === "note" ? "Note" : "Document",
      updatedAt: entry.updated ?? entry.created, target: { kind: "cloud", path: entry.path },
    }));
  const documents = [...loadedDocuments, ...cloud].sort((left, right) => newestFirst(left.updatedAt, right.updatedAt));

  const allowed = new Set(scoped.map((conversation) => conversation.id));
  const exploration = buildSearchExploration({ conversations, groups, categories, query: request.query });
  const passages = exploration.results
    // Titles are already listed under documents.
    .filter((result) => result.evidence.sourceKind !== "conversation" && allowed.has(result.conversationId))
    .map((result): VaultSearchPassageHit => {
      const conversation = conversations[result.conversationId];
      return {
        key: `passage:${result.id}`, conversationId: result.conversationId, title: result.title,
        kindLabel: conversation ? kindLabel(conversation) : result.locationLabel,
        familyTitle: conversation ? familyTitle(conversations, conversation) : undefined,
        matchLabel: result.matchLabel, preview: result.preview, passage: result.passage,
        updatedAt: result.updatedAt, evidence: result.evidence, localOnly: result.localOnly,
      };
    });
  return { query: request.query, scope: request.scope, documents, passages, complete: true };
}

/** The search available today. It answers at once; a server provider would emit more than once. */
export function createLocalVaultSearchProvider(getInput: () => LocalVaultSearchInput): VaultSearchProvider {
  return {
    search(request, emit) {
      emit(searchLocalVault(request, getInput()));
      return () => undefined;
    },
  };
}

/** `useMarkdownVault().searchCloud`: streams the server's titles, then passages. */
export type VaultCloudSearch = (query: string, options: { limit?: number; signal?: AbortSignal }, onEvent: (event: VaultSearchEvent) => void) => Promise<void>;

const CLOUD_LIMIT = 50;
const CLOUD_DELAY_MS = 150;
const SOURCE_LABELS: Record<VaultSearchPassage["source"], string> = { document: "Document text", message: "Message", note: "Private note" };

function cloudEvidence(passage: VaultSearchPassage): SearchEvidenceRef {
  const quote = passage.snippet.slice(passage.match.start, passage.match.end);
  const range = { quote, startOffset: passage.position.start, endOffset: passage.position.end };
  if (passage.source === "message") return { conversationId: passage.id, sourceKind: "message", messageId: passage.position.messageId, ...range };
  if (passage.source === "note") return { conversationId: passage.id, sourceKind: "annotation", noteId: passage.position.noteId, ...range };
  return { conversationId: passage.id, sourceKind: "document", sourceBlockId: passage.position.blockId, ...range };
}

/**
 * Searches this device at once, then adds what the server finds in the rest of
 * the vault. Documents already on this device are answered locally, so unsynced
 * edits are found and nothing is listed twice. Without `searchCloud`, or for
 * the family scope (which only this device knows), it is the local search.
 */
export function createVaultSearchProvider(getInput: () => LocalVaultSearchInput, searchCloud?: VaultCloudSearch): VaultSearchProvider {
  return {
    search(request, emit) {
      const input = getInput();
      const local = searchLocalVault(request, input);
      if (!searchCloud || !vaultSearchTerms(request.query).length || request.scope === "family") {
        emit(local);
        return () => undefined;
      }
      const now = input.now ?? Date.now();
      const indexById = new Map((input.cloudDocuments ?? []).map((entry) => [entry.id, entry]));
      const known = (id: string) => Object.hasOwn(input.conversations, id);
      const passageInScope = (passage: VaultSearchPassage) => {
        const entry = indexById.get(passage.id);
        if (request.scope === "notes") return entry?.kind === "note";
        if (request.scope === "documents") return entry?.kind !== "note";
        if (request.scope === "recent") return now - Date.parse(passage.updated ?? entry?.updated ?? "") <= YEAR_MS;
        return true;
      };
      let documents = local.documents;
      const passages = [...local.passages];
      const seenPassages = new Set(passages.map((hit) => hit.key));
      let notice: string | undefined;
      let finished = false;
      const send = (complete: boolean) => emit({ ...local, documents, passages: [...passages], complete, ...(notice ? { notice } : {}) });
      send(false);

      const controller = new AbortController();
      const timer = setTimeout(() => {
        void searchCloud(request.query, { limit: CLOUD_LIMIT, signal: controller.signal }, (event) => {
          if (controller.signal.aborted || finished) return;
          if (event.type === "documents") {
            const listed = new Set(documents.map((hit) => hit.target.kind === "cloud" ? hit.target.path : `id:${hit.target.conversationId}`));
            const found = event.results.filter((entry) => !known(entry.id) && !listed.has(entry.path) && cloudInScope(entry, request.scope, now))
              .map((entry): VaultSearchDocumentHit => ({
                key: `cloud:${entry.path}`, title: entry.title, kindLabel: entry.kind === "note" ? "Note" : "Document",
                updatedAt: entry.updated ?? entry.created, target: { kind: "cloud", path: entry.path },
              }));
            if (found.length) documents = [...documents, ...found].sort((left, right) => newestFirst(left.updatedAt, right.updatedAt));
            send(false);
          } else if (event.type === "passages") {
            if (event.error) notice = event.error;
            for (const passage of event.results) {
              const key = `cloud-passage:${passage.id}:${passage.source}:${passage.position.blockId ?? passage.position.messageId ?? passage.position.noteId ?? ""}:${passage.position.start}`;
              if (known(passage.id) || seenPassages.has(key) || !passageInScope(passage)) continue;
              seenPassages.add(key);
              const path = passage.path ?? indexById.get(passage.id)?.path;
              passages.push({
                key, conversationId: passage.id, title: passage.title, kindLabel: indexById.get(passage.id)?.kind === "note" ? "Note" : "Document",
                matchLabel: SOURCE_LABELS[passage.source], preview: passage.snippet, passage: passage.snippet,
                updatedAt: passage.updated ?? "", evidence: cloudEvidence(passage), localOnly: passage.source === "note",
                ...(path ? { cloudPath: path } : {}),
              });
            }
            passages.sort((left, right) => newestFirst(left.updatedAt, right.updatedAt));
            send(false);
          } else if (event.type === "done") {
            finished = true;
            send(true);
          } else {
            finished = true;
            notice = "The cloud search stopped early. Results from this device are complete.";
            send(true);
          }
        }).then(() => {
          // A stream that ends without "done" was cut off.
          if (controller.signal.aborted || finished) return;
          finished = true;
          notice ??= "The cloud search stopped early. Results from this device are complete.";
          send(true);
        }, () => {
          if (controller.signal.aborted || finished) return;
          finished = true;
          // Older servers cannot search; this device's results stand on their own.
          send(true);
        });
      }, CLOUD_DELAY_MS);
      return () => { clearTimeout(timer); controller.abort(); };
    },
  };
}

/**
 * Remembers recent finished searches, so local edits that refresh the results
 * (which happen on every keystroke while results stay open) reuse the server's
 * answer instead of asking again.
 */
export function cacheVaultCloudSearch(search: VaultCloudSearch, { maxAgeMs = 60_000, size = 20, now = Date.now } = {}): VaultCloudSearch {
  const finished = new Map<string, { at: number; events: VaultSearchEvent[] }>();
  return async (query, options, onEvent) => {
    const key = JSON.stringify([query.trim(), options.limit]);
    const cached = finished.get(key);
    if (cached && now() - cached.at <= maxAgeMs) {
      for (const event of cached.events) onEvent(event);
      return;
    }
    finished.delete(key);
    const events: VaultSearchEvent[] = [];
    await search(query, options, (event) => { events.push(event); onEvent(event); });
    const complete = events.at(-1)?.type === "done" && !events.some((event) => event.type === "passages" && event.error);
    if (complete && !options.signal?.aborted) {
      finished.set(key, { at: now(), events });
      if (finished.size > size) finished.delete(finished.keys().next().value!);
    }
  };
}
