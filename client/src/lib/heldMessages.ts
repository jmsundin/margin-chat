/**
 * Send when…: a question held until something is true, then asked once. Held messages are kept on this
 * device and are checked while Margin Chat is open; one whose time passed while it was closed is asked
 * the next time it opens.
 */
export type HoldCondition =
  /** At or after this moment. */
  | { kind: "time"; at: string }
  /** When AI has finished writing in the message's document. */
  | { kind: "idle" }
  /** When this device and the cloud vault hold the same thing. */
  | { kind: "synced" };

export interface HeldMessage {
  id: string;
  conversationId: string;
  prompt: string;
  condition: HoldCondition;
  createdAt: string;
}

export const MAX_HELD_MESSAGES = 20;
export const MAX_HELD_PROMPT = 4000;
const key = (userId: string) => `margin-chat:held-messages:${userId}`;

function parseCondition(value: unknown): HoldCondition | null {
  if (!value || typeof value !== "object") return null;
  const { kind, at } = value as Record<string, unknown>;
  if (kind === "idle" || kind === "synced") return { kind };
  if (kind === "time" && typeof at === "string" && !Number.isNaN(Date.parse(at))) return { kind, at };
  return null;
}

export function parseHeldMessages(raw: string | null): HeldMessage[] {
  let value: unknown = null;
  try { value = raw ? JSON.parse(raw) : null; } catch { value = null; }
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  return value.flatMap((item): HeldMessage[] => {
    if (!item || typeof item !== "object") return [];
    const { id, conversationId, prompt, createdAt } = item as Record<string, unknown>;
    const condition = parseCondition((item as Record<string, unknown>).condition);
    if (typeof id !== "string" || !id || seen.has(id) || typeof conversationId !== "string" || !conversationId
      || typeof prompt !== "string" || !prompt.trim() || !condition) return [];
    seen.add(id);
    return [{ id, conversationId, prompt: prompt.slice(0, MAX_HELD_PROMPT), condition, createdAt: typeof createdAt === "string" ? createdAt : new Date(0).toISOString() }];
  }).slice(0, MAX_HELD_MESSAGES);
}

export function readHeldMessages(userId: string): HeldMessage[] {
  try { return parseHeldMessages(localStorage.getItem(key(userId))); } catch { return []; }
}

/** Returns false when this device couldn't keep them, so the caller can say the message won't survive a restart. */
export function saveHeldMessages(userId: string, messages: readonly HeldMessage[]): boolean {
  try { localStorage.setItem(key(userId), JSON.stringify(messages)); return true; } catch { return false; }
}

/** What the checker knows about the app right now. */
export interface HoldFacts {
  now: number;
  /** Documents that still exist. */
  hasDocument: (conversationId: string) => boolean;
  /** AI is writing in this document, or about to. */
  isBusy: (conversationId: string) => boolean;
  /** Null when this vault doesn't sync to the cloud, so "when synced" has nothing to wait for. */
  synced: boolean | null;
}

/**
 * Splits held messages into those to ask now, those whose document is gone, and the rest. At most one
 * message per document is released at a time, oldest first, so two never write into a document at once.
 */
export function dueHeldMessages(messages: readonly HeldMessage[], facts: HoldFacts): { send: HeldMessage[]; orphaned: HeldMessage[]; keep: HeldMessage[] } {
  const send: HeldMessage[] = [], orphaned: HeldMessage[] = [], keep: HeldMessage[] = [];
  const releasing = new Set<string>();
  for (const message of [...messages].sort((left, right) => left.createdAt.localeCompare(right.createdAt))) {
    if (!facts.hasDocument(message.conversationId)) { orphaned.push(message); continue; }
    const met = message.condition.kind === "time" ? facts.now >= Date.parse(message.condition.at)
      : message.condition.kind === "synced" ? facts.synced !== false
      : true;
    if (met && !facts.isBusy(message.conversationId) && !releasing.has(message.conversationId)) { releasing.add(message.conversationId); send.push(message); }
    else keep.push(message);
  }
  return { send, orphaned, keep };
}

export function describeHold(condition: HoldCondition): string {
  if (condition.kind === "idle") return "When AI finishes in this document";
  if (condition.kind === "synced") return "When sync finishes";
  const date = new Date(condition.at);
  return `At ${date.toLocaleString(undefined, { month: "short", day: "numeric", hour: "numeric", minute: "2-digit" })}`;
}
