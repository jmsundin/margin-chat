import { apiFetch } from "./apiTransport";
import { ApiError } from "./apiError";
import type { AISettings, BackendServiceId } from "../types";

export interface PublicAnswerTopic {
  id: string;
  label: string;
  description: string;
  relation: string;
}

/** An AI answer a member shared; every signed-in member can read it. */
export interface PublicAnswer {
  id: string;
  topicId: string;
  topicLabel: string;
  question: string;
  answer: string;
  related: PublicAnswerTopic[];
  createdAt: string;
  mine: boolean;
}

export interface SavedPublicMap {
  state: unknown;
  revision: number;
  updatedAt: string | null;
}

export interface PublicMapAIOptions {
  serviceId?: BackendServiceId;
  modelId?: string;
  ai?: AISettings;
}

const QID = /^Q[1-9]\d*$/u;
const record = (value: unknown): value is Record<string, unknown> => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value: unknown, maximum: number) => typeof value === "string" && value.length <= maximum;

async function failure(response: Response, fallback: string): Promise<ApiError> {
  const body = await response.json().catch(() => null);
  return new ApiError(response.status, typeof body?.error === "string" ? body.error.slice(0, 500) : fallback);
}

export function isPublicAnswer(value: unknown): value is PublicAnswer {
  if (!record(value) || !text(value.id, 64) || !text(value.topicId, 20) || !QID.test(value.topicId as string)
    || !text(value.topicLabel, 200) || !text(value.question, 500) || !text(value.answer, 3000)
    || !text(value.createdAt, 64) || typeof value.mine !== "boolean" || !Array.isArray(value.related) || value.related.length > 6) return false;
  return value.related.every((topic) => record(topic) && text(topic.id, 20) && QID.test(topic.id as string)
    && text(topic.label, 200) && text(topic.description, 500) && text(topic.relation, 60));
}

export async function readPublicMap(userId: string, signal?: AbortSignal): Promise<SavedPublicMap> {
  const response = await apiFetch("/api/public-map/state", { credentials: "same-origin", signal, headers: { Accept: "application/json", "X-Margin-Vault-User": userId } });
  if (!response.ok) throw await failure(response, "Your saved public map could not be loaded.");
  const body = await response.json();
  return { state: body?.state ?? null, revision: Number(body?.revision) || 0, updatedAt: typeof body?.updatedAt === "string" ? body.updatedAt : null };
}

export async function savePublicMap(userId: string, state: unknown, signal?: AbortSignal): Promise<void> {
  const response = await apiFetch("/api/public-map/state", {
    method: "PUT", credentials: "same-origin", signal,
    headers: { "Content-Type": "application/json", Accept: "application/json", "X-Margin-Vault-User": userId },
    body: JSON.stringify({ state }),
  });
  if (!response.ok) throw await failure(response, "Your public map could not be saved.");
}

/** Without topics, this returns the newest answers across the whole public map. */
export async function listPublicAnswers(userId: string, { topicIds = [], limit = 20, signal }: { topicIds?: string[]; limit?: number; signal?: AbortSignal } = {}): Promise<PublicAnswer[]> {
  const query = new URLSearchParams({ limit: String(limit) });
  for (const id of topicIds) query.append("topic", id);
  const response = await apiFetch(`/api/public-map/answers?${query}`, { credentials: "same-origin", signal, headers: { Accept: "application/json", "X-Margin-Vault-User": userId } });
  if (!response.ok) throw await failure(response, "Shared answers could not be loaded.");
  const body = await response.json();
  return Array.isArray(body?.answers) ? body.answers.filter(isPublicAnswer) : [];
}

export async function deletePublicAnswer(userId: string, id: string): Promise<void> {
  const response = await apiFetch(`/api/public-map/answers/${encodeURIComponent(id)}`, {
    method: "DELETE", credentials: "same-origin", headers: { Accept: "application/json", "X-Margin-Vault-User": userId },
  });
  if (!response.ok) throw await failure(response, "This answer could not be deleted.");
}

export async function askPublicMap(args: {
  userId: string;
  topic: { id: string; label: string; description: string };
  question: string;
  options?: PublicMapAIOptions;
  signal: AbortSignal;
  onProgress?: (message: string) => void;
}): Promise<PublicAnswer> {
  const { userId, topic, question, options, signal, onProgress } = args;
  const response = await apiFetch("/api/public-map/ask", {
    method: "POST", credentials: "same-origin", signal,
    headers: { "Content-Type": "application/json", Accept: "application/x-ndjson", "X-Margin-Vault-User": userId },
    body: JSON.stringify({ topic, question, serviceId: options?.serviceId, modelId: options?.modelId, ai: options?.ai ? { ...options.ai, contextScope: "conversation", selectedConversationIds: [] } : undefined }),
  });
  if (!response.ok) throw await failure(response, "Your question could not be answered. Try again.");
  if (!response.body) throw new Error("The answer was empty. Try again.");
  const reader = response.body.getReader(), decoder = new TextDecoder();
  let pending = "", total = 0, answer: PublicAnswer | null = null;
  const invalid = "The answer could not be read. Try again.";
  function event(line: string) {
    if (!line.trim()) return;
    let value: unknown;
    try { value = JSON.parse(line); } catch { throw new Error(invalid); }
    if (!record(value)) throw new Error(invalid);
    if (value.type === "error") throw new ApiError(typeof value.statusCode === "number" ? value.statusCode : 502, typeof value.error === "string" ? value.error.slice(0, 500) : "Your question could not be answered.");
    if (value.type === "progress" && text(value.message, 200)) onProgress?.(value.message as string);
    else if (value.type === "done" && isPublicAnswer(value.answer)) answer = value.answer;
    else throw new Error(invalid);
  }
  try {
    while (true) {
      const { done, value } = await reader.read();
      total += value?.length ?? 0;
      if (total > 100_000) throw new Error(invalid);
      pending += done ? decoder.decode() : decoder.decode(value, { stream: true });
      const lines = pending.split("\n"); pending = lines.pop() ?? "";
      for (const line of lines) event(line);
      if (done) { event(pending); break; }
    }
    if (!answer) throw new Error("The connection ended before the answer was complete. Try again.");
    return answer;
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
