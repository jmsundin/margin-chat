import type { AISettings, BackendServiceId } from "../types";
import { ApiError } from "./apiError";

export interface TopicExpansionNode {
  id: string;
  /** Null attaches this note to the selected topic; other values name another draft node. */
  parentId: string | null;
  title: string;
  content: string;
}
export interface TopicExpansion { nodes: TopicExpansionNode[] }
export interface TopicExpansionRequest {
  topic: { id: string; label: string; description: string; wikidataUrl?: string };
  noteContent: string;
  existingTitles: string[];
  serviceId?: BackendServiceId;
  modelId?: string;
  ai?: AISettings;
  expectedUserId: string;
  signal: AbortSignal;
  onProgress?: (message: string) => void;
}

const invalidMessage = "The AI returned an invalid topic expansion. Try again.";
const identifier = /^[a-zA-Z0-9_-]{1,48}$/u;
const unsafeText = /(?:[a-z][a-z\d+.-]*:\/\/|\bwww\.|\b(?:javascript|data|file|mailto):|<[^>]*>|`|~~~|\[[^\]\n]*\]\s*(?:\(|\[)|^\s*\[[^\]\n]+\]:|[\u0000-\u0008\u000b\u000c\u000e-\u001f])/imu;
const titleKey = (value: string) => value.normalize("NFKC").replace(/\s+/gu, " ").trim().toLocaleLowerCase("en-US");
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);

/** Validate again at the workspace boundary, including ancestry and bounded plain text. */
export function isTopicExpansion(value: unknown): value is TopicExpansion {
  if (!record(value) || !Array.isArray(value.nodes) || value.nodes.length < 2 || value.nodes.length > 6) return false;
  const nodes = new Map<string, TopicExpansionNode>(), titles = new Set<string>();
  let total = 0;
  for (const node of value.nodes) {
    if (!record(node) || typeof node.id !== "string" || !identifier.test(node.id) || nodes.has(node.id)
      || !(node.parentId === null || (typeof node.parentId === "string" && identifier.test(node.parentId)))
      || typeof node.title !== "string" || !node.title.trim() || node.title.length > 100 || unsafeText.test(node.title)
      || typeof node.content !== "string" || !node.content.trim() || node.content.length > 900 || unsafeText.test(node.content)) return false;
    const key = titleKey(node.title);
    if (titles.has(key)) return false;
    titles.add(key); nodes.set(node.id, node as unknown as TopicExpansionNode);
    total += node.title.length + node.content.length;
    if (total > 5000) return false;
  }
  for (const node of nodes.values()) {
    let current = node, depth = 1;
    const visited = new Set([node.id]);
    while (current.parentId !== null) {
      if (++depth > 2 || !nodes.has(current.parentId) || visited.has(current.parentId)) return false;
      visited.add(current.parentId); current = nodes.get(current.parentId)!;
    }
  }
  return true;
}

/** Returns drafts only. The caller owns the single atomic workspace update. */
export async function requestTopicExpansion(args: TopicExpansionRequest): Promise<TopicExpansion> {
  const { topic, noteContent, existingTitles, serviceId, modelId, ai, expectedUserId, signal, onProgress } = args;
  signal.throwIfAborted();
  const response = await fetch("/api/graph/topic", {
    method: "POST", credentials: "same-origin", signal,
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson", "X-Margin-Vault-User": expectedUserId },
    body: JSON.stringify({ topic, noteContent, existingTitles, serviceId, modelId, ai }),
  });
  if (!response.ok) {
    const body = await response.json().catch(() => null);
    signal.throwIfAborted();
    throw new ApiError(response.status, typeof body?.error === "string" ? body.error.slice(0, 500) : "The topic could not be expanded. Try again.");
  }
  if (!response.body) throw new Error("The topic expansion response was empty. Try again.");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  const abort = () => { void reader.cancel(signal.reason).catch(() => {}); };
  signal.addEventListener("abort", abort, { once: true });
  let pending = "", total = 0, progressCount = 0, result: TopicExpansion | null = null;
  function event(line: string) {
    if (!line.trim()) return;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(invalidMessage); }
    if (!record(value)) throw new Error(invalidMessage);
    if (value.type === "error") throw new ApiError(typeof value.statusCode === "number" ? value.statusCode : 502, typeof value.error === "string" ? value.error.slice(0, 500) : "The topic could not be expanded.");
    if (result) throw new Error(invalidMessage);
    if (value.type === "progress") {
      if (typeof value.message !== "string" || value.message.length > 200 || ++progressCount > 10) throw new Error(invalidMessage);
      onProgress?.(value.message);
    } else if (value.type === "done") {
      if (!isTopicExpansion(value.expansion)) throw new Error(invalidMessage);
      const forbiddenTitles = new Set([topic.label, ...existingTitles].map(titleKey));
      if (value.expansion.nodes.some((node) => forbiddenTitles.has(titleKey(node.title)))) throw new Error(invalidMessage);
      result = { nodes: value.expansion.nodes.map(({ id, parentId, title, content }) => ({ id, parentId, title: title.trim(), content: content.trim() })) };
    } else throw new Error(invalidMessage);
  }
  try {
    while (true) {
      signal.throwIfAborted();
      const { done, value } = await reader.read();
      signal.throwIfAborted();
      total += value?.length ?? 0;
      if (total > 100_000) throw new Error(invalidMessage);
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = pending.split("\n"); pending = lines.pop() ?? "";
      for (const line of lines) event(line);
      if (done) { event(pending); break; }
    }
    signal.throwIfAborted();
    if (!result) throw new Error("The connection ended before the topic expansion was complete. Try again.");
    return result;
  } finally {
    signal.removeEventListener("abort", abort);
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
