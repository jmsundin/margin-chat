import type { AppState, Conversation } from "../types";
import { isPlaceholderDocumentTitle } from "./documentTitle";
import { getEditableDocumentText } from "./editableDocument";

/**
 * A new document you leave without writing anything is removed after this long,
 * unless you come back to it first.
 */
export const EMPTY_DOCUMENT_CLEANUP_DELAY_MS = 5 * 60_000;
/** How often the workspace checks for documents whose wait is over. */
export const EMPTY_DOCUMENT_CLEANUP_CHECK_MS = 30_000;
const STORAGE_KEY = "margin-chat:left-empty-documents";

/** When each untouched new document was left, by id. Kept across reloads so a refresh doesn't strand them. */
export type LeftEmptyDocuments = Record<string, number>;

function referencesDocument(conversation: Conversation, id: string): boolean {
  return Boolean(
    conversation.linkedConversationIds?.includes(id) ||
    conversation.relations?.some((relation) => relation.targetConversationId === id) ||
    conversation.document?.links?.some((link) => link.targetConversationId === id),
  );
}

/**
 * True only for a document nobody has put anything into: the app's placeholder name,
 * no text, prompts, answers, notes, files, children, links, tags, groups or pins,
 * and no other document pointing at it.
 */
export function isUntouchedEmptyDocument(state: AppState, id: string, draft = ""): boolean {
  const conversation = state.conversations[id];
  if (!conversation) return false;
  if (!isPlaceholderDocumentTitle(conversation.title)) return false;
  if (draft.trim()) return false;
  if (conversation.messages.length) return false;
  if (conversation.childIds.length) return false;
  if (conversation.documents?.length) return false;
  if (conversation.vaultFile || conversation.publicTopic) return false;
  if (conversation.linkedConversationIds?.length || conversation.relations?.length) return false;
  if (conversation.tags?.length || conversation.nodeType || conversation.hiddenFromAI) return false;
  if (conversation.notes?.some((note) => note.content.trim() || note.kind !== "standalone")) return false;
  const document = conversation.document;
  if (document && (document.prompts.length || document.generations.length || document.links?.length || document.marginNote)) return false;
  if (getEditableDocumentText(conversation).trim()) return false;
  if (state.pinnedThreadIds.includes(id)) return false;
  if (Object.values(state.groups).some((group) => group.conversationIds.includes(id))) return false;
  for (const other of Object.values(state.conversations)) {
    if (other.id !== id && referencesDocument(other, id)) return false;
  }
  return true;
}

/**
 * Update the left list when focus moves from `previousId` to `activeId`.
 * Coming back to a document takes it off the list; leaving one made since
 * `createdSince` while it is still empty puts it on.
 */
export function noteDocumentFocusChange(
  left: LeftEmptyDocuments,
  state: AppState,
  previousId: string,
  activeId: string,
  { createdSince, now, draft }: { createdSince: number; now: number; draft?: string },
): LeftEmptyDocuments {
  let next = left;
  if (Object.hasOwn(next, activeId)) {
    next = { ...next };
    delete next[activeId];
  }
  const previous = state.conversations[previousId];
  if (previousId !== activeId && previous && Date.parse(previous.createdAt) >= createdSince &&
      isUntouchedEmptyDocument(state, previousId, draft)) {
    next = { ...next, [previousId]: now };
  }
  return next;
}

/**
 * Which left documents to remove now, and the list to keep. A document drops off the
 * list once it is gone or has anything in it; one still on screen waits.
 */
export function collectExpiredEmptyDocuments(
  left: LeftEmptyDocuments,
  state: AppState,
  { now, delayMs = EMPTY_DOCUMENT_CLEANUP_DELAY_MS, visibleIds, drafts = {} }: {
    now: number; delayMs?: number; visibleIds: ReadonlySet<string>; drafts?: Record<string, string>;
  },
): { remove: string[]; left: LeftEmptyDocuments } {
  const remove: string[] = [];
  const next: LeftEmptyDocuments = {};
  let documentCount = Object.keys(state.conversations).length;
  for (const [id, leftAt] of Object.entries(left)) {
    if (!isUntouchedEmptyDocument(state, id, drafts[id])) continue;
    if (id === state.activeConversationId || visibleIds.has(id) || now - leftAt < delayMs || documentCount <= 1) {
      next[id] = leftAt;
      continue;
    }
    remove.push(id);
    documentCount -= 1;
  }
  return { remove, left: next };
}

export function readLeftEmptyDocuments(): LeftEmptyDocuments {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {};
    return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [string, number] => typeof entry[1] === "number"));
  } catch {
    return {};
  }
}

export function writeLeftEmptyDocuments(left: LeftEmptyDocuments): void {
  try {
    if (Object.keys(left).length) window.localStorage.setItem(STORAGE_KEY, JSON.stringify(left));
    else window.localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Private windows can refuse storage; the in-memory list still works for this visit.
  }
}
