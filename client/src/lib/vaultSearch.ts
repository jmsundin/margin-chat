import type { Conversation, ConversationGroup, ThreadCategoryId } from "../types";
import { buildSearchExploration, type SearchEvidenceRef } from "./searchExploration";
import { getConversationRootId } from "./tree";
import { searchVaultIndex } from "./vaultHydration";
import type { VaultIndexEntry } from "./vaultTypes";

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
