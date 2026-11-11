import { isHiddenFromAI } from "@margin-chat/workspace-contracts";
import type { Conversation } from "../types";
import { apiFetch } from "./apiTransport";
import { getEditableDocument } from "./editableDocument";
import { conversationTextLinks, createDocumentLinkResolver } from "./documentRelations";
import { searchSources, type RatchetClaim, type RatchetCorpus, type RatchetHit, type RatchetRun, type RatchetSource } from "./ratchet";
import type { VaultCloudSearch } from "./vaultSearch";

/** A document as Ratchet reads it, with the documents it links to or relates to. */
export function ratchetSource(conversation: Conversation, conversations: Record<string, Conversation>, resolve = createDocumentLinkResolver(conversations)): RatchetSource {
  const linked = new Set<string>();
  for (const relation of conversation.relations ?? []) if (relation.targetConversationId) linked.add(relation.targetConversationId);
  for (const id of conversation.linkedConversationIds ?? []) linked.add(id);
  for (const link of conversationTextLinks(conversation)) {
    const target = resolve(link.target);
    if (target) linked.add(target);
  }
  linked.delete(conversation.id);
  return {
    id: conversation.id, title: conversation.title || "Untitled", updatedAt: conversation.updatedAt,
    blocks: getEditableDocument(conversation).blocks.map((block) => ({ id: block.id, content: block.content })),
    linkedIds: [...linked],
  };
}

/** Documents the AI may read as evidence: not hidden from AI, and with text (a PDF viewer has none here). */
export function readableByRatchet(conversation: Conversation | undefined): conversation is Conversation {
  return !!conversation && !isHiddenFromAI(conversation) && !conversation.vaultFile;
}

/**
 * The vault as evidence for one check: the documents on this device the AI may
 * read, searched by their words, plus the cloud index's matches by meaning when
 * there is one. A cloud match in a document not on this device is skipped,
 * since its text can't be quoted and checked here.
 */
export function createRatchetCorpus({ conversations, searchCloud }: { conversations: Record<string, Conversation>; searchCloud?: VaultCloudSearch }): RatchetCorpus & { skippedCloudOnly: () => number } {
  const resolve = createDocumentLinkResolver(conversations);
  const sources = new Map<string, RatchetSource>();
  let skipped = 0;
  const get = (id: string) => {
    if (!Object.hasOwn(conversations, id)) return undefined;
    const conversation = conversations[id];
    if (!readableByRatchet(conversation)) return undefined;
    let source = sources.get(id);
    if (!source) { source = ratchetSource(conversation, conversations, resolve); sources.set(id, source); }
    return source;
  };
  const all = function* () { for (const id of Object.keys(conversations)) { const source = get(id); if (source) yield source; } };
  return {
    get,
    skippedCloudOnly: () => skipped,
    async search(query, { limit, signal }) {
      const local = searchSources(all(), query, limit);
      if (!searchCloud) return local;
      const meaning: RatchetHit[] = [];
      await searchCloud(query, { limit, signal }, (event) => {
        if (event.type !== "related") return;
        for (const passage of event.results) {
          if (passage.sourceKind !== "conversation") continue;
          if (!get(passage.id)) { if (!Object.hasOwn(conversations, passage.id)) skipped += 1; continue; }
          meaning.push({ documentId: passage.id, ...(passage.blockId ? { blockId: passage.blockId } : {}), text: passage.snippet });
        }
      });
      const seen = new Set(local.map((hit) => hit.documentId));
      return [...local, ...meaning.filter((hit) => !seen.has(hit.documentId) && seen.add(hit.documentId))].slice(0, limit * 2);
    },
  };
}

export interface SavedRatchetCheck { claims: RatchetClaim[]; run: RatchetRun | null }

export async function readRatchetCheck(userId: string, documentId: string, signal?: AbortSignal): Promise<SavedRatchetCheck> {
  const response = await apiFetch(`/api/ratchet/claims?${new URLSearchParams({ documentId })}`, {
    credentials: "same-origin", cache: "no-store", headers: { "X-Margin-Vault-User": userId }, signal,
  });
  if (!response.ok) throw new Error(response.status === 401 ? "Sign in again to see checked claims." : "Checked claims couldn't be loaded.");
  const body = await response.json() as SavedRatchetCheck;
  return { claims: Array.isArray(body.claims) ? body.claims : [], run: body.run ?? null };
}

export async function saveRatchetCheck(userId: string, documentId: string, check: { claims: RatchetClaim[]; run: RatchetRun }) {
  const response = await apiFetch("/api/ratchet/claims", {
    method: "PUT", credentials: "same-origin", cache: "no-store",
    headers: { "Content-Type": "application/json", "X-Margin-Vault-User": userId },
    body: JSON.stringify({ documentId, ...check }),
  });
  if (!response.ok) throw new Error("The checked claims couldn't be saved to your account. They show on this device until you close it.");
}
