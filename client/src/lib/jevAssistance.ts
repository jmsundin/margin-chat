import { normalizeAISettings } from "@margin-chat/workspace-contracts";
import type { AISettings, Conversation, ConversationGroup, ThreadCategoryId, ThreadSummary } from "../types";
import { getStandaloneNote } from "./standaloneNotes";
import { THREAD_CATEGORY_DEFINITIONS, getThreadCategoryLabel } from "./threadCategories";
import { getCurrentDocumentText } from "./documentSources";

export interface JevWorkspaceItem {
  id: string;
  title: string;
  kind: "chat" | "note";
  content: string;
}

export interface JevWorkspaceSnapshot {
  items: JevWorkspaceItem[];
  current: Pick<JevWorkspaceItem, "id" | "title" | "content">;
  groups?: Array<{ id: string; name: string; memberTitles: string[] }>;
}

export type JevGroupSuggestions = Record<string, { groupId: string; confidence: number }>;

export interface JevWorkspaceResult {
  available: boolean;
  categories: Array<{ id: string; categoryId: ThreadCategoryId; confidence: number }>;
  /** Includes valid uncertain judgments so they need not be requested repeatedly. */
  evaluatedCategoryIds?: string[];
  groupSuggestions: Array<{ id: string; groupId: string; confidence: number }>;
  related: Array<{ id: string; score: number }>;
  model?: string;
  warning?: string;
}

export type JevStatus = "off" | "checking" | "unconfigured" | "loading" | "ready" | "unavailable" | "paused";
export const JEV_DISCLOSURE = "TypeSafe analyzes permitted chat context, search queries, workspace chat and note excerpts, group names, and member titles for automatic organization, passage ranking, and suggestions. Private margin and side notes are excluded.";

export function getJevPreferenceKey(userId: string) {
  return `margin-chat-jev-assistance:${encodeURIComponent(userId)}`;
}

export function loadJevPreference(userId: string): boolean {
  try { return localStorage.getItem(getJevPreferenceKey(userId)) !== "false"; }
  catch { return true; }
}

export function saveJevPreference(userId: string, enabled: boolean) {
  try { localStorage.setItem(getJevPreferenceKey(userId), String(enabled)); }
  catch { /* The preference still applies for this open session. */ }
}

/** Imported conversation preferences never override consent on this device. */
export function withJevConsent(settings: AISettings | undefined, enabled: boolean): AISettings {
  const { jevEnabled: _previous, ...ai } = normalizeAISettings(settings);
  return enabled ? { ...ai, jevEnabled: true } : ai;
}

function visibleContent(conversation: Conversation, limit = 1600) {
  if (conversation.document) return getCurrentDocumentText(conversation).slice(0, limit);
  if (conversation.kind === "note") return (getStandaloneNote(conversation)?.content ?? "").slice(0, limit);
  return conversation.messages
    .filter((message) => (message.role === "user" || message.role === "assistant") && message.content.trim())
    .slice(-8)
    .map(({ role, content }) => `${role}: ${content.slice(-limit)}`)
    .join("\n").slice(-limit);
}

/** Deliberately constructs a whitelist: no notes array, receipts, attachments or system messages. */
export function buildJevWorkspaceSnapshot(conversations: Record<string, Conversation>, currentId: string, groups: Record<string, ConversationGroup> = {}): JevWorkspaceSnapshot | null {
  const current = conversations[currentId];
  if (!current) return null;
  const assignedIds = new Set(Object.values(groups).flatMap((group) => group.conversationIds));
  const needsOrganization = (conversation: Conversation) => !assignedIds.has(conversation.id) && conversation.grouping !== "manual" && Boolean(visibleContent(conversation).trim());
  const candidates = Object.values(conversations).sort((a, b) =>
    Number(b.id === currentId) - Number(a.id === currentId) || Number(needsOrganization(b)) - Number(needsOrganization(a)) || b.updatedAt.localeCompare(a.updatedAt) || a.id.localeCompare(b.id),
  ).slice(0, 40);
  // Preserve detailed excerpts for small workspaces without expanding the total allowance.
  const itemLimit = Math.min(1600, Math.floor(16_000 / Math.max(1, candidates.length)));
  const items: JevWorkspaceItem[] = candidates.map((conversation) => ({
    id: conversation.id, title: conversation.title.slice(0, 200),
    kind: conversation.kind === "note" ? "note" : "chat",
    content: visibleContent(conversation, itemLimit),
  }));
  // Stable ordering avoids repeating a request when an annotation changes updatedAt.
  items.sort((a, b) => a.id.localeCompare(b.id));
  const groupCandidates = Object.values(groups).sort((a, b) => a.id.localeCompare(b.id)).slice(0, 20).map((group) => ({
    id: group.id, name: group.name.trim().slice(0, 80),
    memberTitles: [...group.conversationIds].sort().map((id) => conversations[id]).filter((item): item is Conversation => Boolean(item))
      .slice(0, 2).map((item) => item.title.slice(0, 80)),
  }));
  return { items, current: { id: current.id, title: current.title.slice(0, 200), content: visibleContent(current) }, ...(groupCandidates.length ? { groups: groupCandidates } : {}) };
}

export function jevItemFingerprint(item: JevWorkspaceItem) {
  return JSON.stringify([item.id, item.kind, item.title, item.content]);
}

export function parseJevWorkspaceResult(value: unknown, snapshot: JevWorkspaceSnapshot): JevWorkspaceResult {
  if (!value || typeof value !== "object" || typeof (value as JevWorkspaceResult).available !== "boolean") throw new Error("Jev returned an invalid response.");
  const payload = value as JevWorkspaceResult;
  const ids = new Set(snapshot.items.map((item) => item.id));
  const categoryIds = new Set<string>(THREAD_CATEGORY_DEFINITIONS.map((category) => category.id));
  const probability = (value: unknown): value is number => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;
  const categories = new Map<string, JevWorkspaceResult["categories"][number]>();
  const related = new Map<string, JevWorkspaceResult["related"][number]>();
  const groupSuggestions = new Map<string, JevWorkspaceResult["groupSuggestions"][number]>();
  const groupIds = new Set(snapshot.groups?.map((group) => group.id) ?? []);
  if (payload.available && (!Array.isArray(payload.categories) || !Array.isArray(payload.related))) throw new Error("Jev returned an invalid response.");
  for (const item of payload.available ? payload.categories : []) {
    if (item && ids.has(item.id) && categoryIds.has(item.categoryId) && probability(item.confidence) && item.confidence >= 0.55) categories.set(item.id, { id: item.id, categoryId: item.categoryId, confidence: item.confidence });
  }
  for (const item of payload.available ? payload.related : []) {
    if (item && item.id !== snapshot.current.id && ids.has(item.id) && probability(item.score) && item.score >= 0.5) related.set(item.id, { id: item.id, score: item.score });
  }
  if (payload.available && payload.groupSuggestions !== undefined && !Array.isArray(payload.groupSuggestions)) throw new Error("Jev returned invalid group suggestions.");
  if (payload.available && payload.evaluatedCategoryIds !== undefined && !Array.isArray(payload.evaluatedCategoryIds)) throw new Error("Jev returned invalid category coverage.");
  for (const item of payload.available ? payload.groupSuggestions ?? [] : []) {
    if (item && ids.has(item.id) && groupIds.has(item.groupId) && probability(item.confidence) && item.confidence >= 0.75) groupSuggestions.set(item.id, { id: item.id, groupId: item.groupId, confidence: item.confidence });
  }
  return {
    available: payload.available,
    categories: [...categories.values()],
    ...(payload.available && payload.evaluatedCategoryIds !== undefined ? {
      evaluatedCategoryIds: [...new Set(payload.evaluatedCategoryIds.filter((id) => typeof id === "string" && ids.has(id)))],
    } : {}),
    groupSuggestions: [...groupSuggestions.values()],
    related: [...related.values()].sort((a, b) => b.score - a.score).slice(0, 5),
    ...(typeof payload.model === "string" ? { model: payload.model.slice(0, 100) } : {}),
    ...(typeof payload.warning === "string" ? { warning: payload.warning.slice(0, 240) } : {}),
  };
}

export function applyJevCategories(threads: ThreadSummary[], categories: Record<string, ThreadCategoryId>) {
  return threads.map((thread) => {
    const categoryId = Object.hasOwn(categories, thread.id) ? categories[thread.id] : undefined;
    return categoryId ? { ...thread, categoryId, categoryLabel: getThreadCategoryLabel(categoryId) } : thread;
  });
}

export async function requestJevStatus(userId: string, signal: AbortSignal): Promise<boolean> {
  const response = await fetch("/api/jev/status", { credentials: "same-origin", cache: "no-store", headers: { "X-Margin-Vault-User": userId }, signal });
  if (!response.ok) throw new Error("Jev is temporarily unavailable.");
  const value = await response.json();
  if (typeof value?.configured !== "boolean") throw new Error("Jev returned an invalid status.");
  return value.configured;
}

export async function requestJevWorkspace(userId: string, snapshot: JevWorkspaceSnapshot, categories: boolean | readonly string[], signal: AbortSignal): Promise<JevWorkspaceResult> {
  const response = await fetch("/api/jev/workspace", {
    credentials: "same-origin", method: "POST", signal,
    headers: { "Content-Type": "application/json", "X-Margin-Vault-User": userId },
    body: JSON.stringify({ enabled: true, ...snapshot,
      categories: typeof categories === "boolean" ? categories : categories.length > 0,
      ...(typeof categories !== "boolean" ? { categoryIds: categories } : {}), related: true }),
  });
  if (!response.ok) throw new Error("Jev is temporarily unavailable.");
  return parseJevWorkspaceResult(await response.json(), snapshot);
}
