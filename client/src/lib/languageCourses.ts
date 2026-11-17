import { apiFetch } from "./apiTransport";

/**
 * Language courses on the client: where the learner is in each lesson and what
 * they studied each day, sent to the account. Study events wait on this device
 * until the account has them, so a closed tab or a dropped connection loses none.
 */

export type StudyEventType = "words_read" | "words_known" | "meanings_saved" | "reader_seconds" | "lesson_completed" | "reviewed";
export interface StudyEvent { lang: string; type: StudyEventType; count: number; lessonId?: string | null; at?: string }

export interface LessonProgress {
  lessonId: string; lang: string; status: "not_started" | "in_progress" | "completed"; percent: number; lastTokenIndex: number;
  readCount: number; seconds: number; openedAt: string | null; completedAt: string | null; updatedAt: string | null;
}

type Storage = Pick<globalThis.Storage, "getItem" | "setItem">;
const QUEUE_KEY = (userId: string) => `margin-chat:study-events:${userId}`;
const MAX_QUEUED = 2000;

const jsonHeaders = (userId: string) => ({ "Content-Type": "application/json", "X-Margin-Vault-User": userId });

/** Study events kept until the account has them; same kinds of event on the same day and lesson are added together. */
export class StudyQueue {
  private events: StudyEvent[] = [];
  private sending: Promise<void> | null = null;
  private timer: ReturnType<typeof setTimeout> | null = null;

  constructor(readonly userId: string, private readonly storage: Storage | null = typeof localStorage === "undefined" ? null : localStorage,
    private readonly fetcher: typeof apiFetch = apiFetch, private readonly delayMs = 8000) {
    try {
      const saved = JSON.parse(storage?.getItem(QUEUE_KEY(userId)) ?? "[]");
      if (Array.isArray(saved)) this.events = saved.filter((event) => event && typeof event.type === "string" && typeof event.lang === "string").slice(-MAX_QUEUED);
    } catch { /* Start empty. */ }
  }

  get pending(): ReadonlyArray<StudyEvent> { return this.events; }

  private save() {
    try { this.storage?.setItem(QUEUE_KEY(this.userId), JSON.stringify(this.events)); } catch { /* Kept in memory until sent. */ }
  }

  add(event: StudyEvent, now = new Date()) {
    const amount = Math.round(event.count);
    if (!amount) return;
    const at = event.at ?? now.toISOString();
    const hour = at.slice(0, 13);
    const same = this.events.find((item) => item.type === event.type && item.lang === event.lang && (item.lessonId ?? null) === (event.lessonId ?? null) && (item.at ?? "").slice(0, 13) === hour);
    // An undo takes back from what's still waiting; what the account already has stays.
    if (same) { same.count = Math.max(0, same.count + amount); if (!same.count) this.events.splice(this.events.indexOf(same), 1); }
    else if (amount > 0) this.events.push({ ...event, count: amount, at });
    else return;
    if (this.events.length > MAX_QUEUED) this.events.splice(0, this.events.length - MAX_QUEUED);
    this.save();
    if (this.timer === null && this.delayMs >= 0) this.timer = setTimeout(() => { this.timer = null; void this.flush(); }, this.delayMs);
  }

  /** Sends what's waiting. Events added while sending wait for the next round. */
  flush(options: { keepalive?: boolean } = {}): Promise<void> {
    if (this.sending) return this.sending;
    const batch = this.events.slice(0, 200);
    if (!batch.length) return Promise.resolve();
    this.sending = this.fetcher("/api/learn/events", {
      method: "POST", credentials: "same-origin", cache: "no-store", keepalive: options.keepalive, headers: jsonHeaders(this.userId), body: JSON.stringify({ events: batch }),
    }).then((response) => {
      // A request the account refused for good (no account here, too large) isn't sent again and again.
      if (response.ok || [400, 401, 403, 404, 413].includes(response.status)) {
        this.events = this.events.filter((event) => !batch.includes(event));
        this.save();
      }
    }, () => undefined).finally(() => { this.sending = null; });
    return this.sending;
  }
}

const queues = new Map<string, StudyQueue>();
export function studyQueue(userId: string): StudyQueue {
  let queue = queues.get(userId);
  if (!queue) {
    queue = new StudyQueue(userId);
    queues.set(userId, queue);
    if (typeof document !== "undefined") {
      const send = () => { if (document.visibilityState === "hidden") void queue!.flush({ keepalive: true }); };
      document.addEventListener("visibilitychange", send);
      window.addEventListener("online", () => void queue!.flush());
      // Whatever an earlier visit left waiting goes up now.
      void queue.flush();
    }
  }
  return queue;
}

export interface ProgressUpdate { lang: string; percent: number; lastTokenIndex: number; seconds?: number; courseId?: string; complete?: boolean; events?: StudyEvent[] }

export async function saveLessonProgress(userId: string, lessonId: string, update: ProgressUpdate, fetcher: typeof apiFetch = apiFetch): Promise<LessonProgress | null> {
  const response = await fetcher(`/api/learn/lessons/${encodeURIComponent(lessonId)}/${update.complete ? "complete" : "progress"}`, {
    method: "POST", credentials: "same-origin", cache: "no-store", keepalive: !update.complete, headers: jsonHeaders(userId),
    body: JSON.stringify({ ...update, at: new Date().toISOString() }),
  });
  if (!response.ok) return null;
  return ((await response.json()) as { progress: LessonProgress }).progress;
}

export async function readLessonProgress(userId: string, lang: string, signal?: AbortSignal, fetcher: typeof apiFetch = apiFetch): Promise<LessonProgress[]> {
  const response = await fetcher(`/api/learn/${encodeURIComponent(lang)}/progress`, { credentials: "same-origin", cache: "no-store", headers: { "X-Margin-Vault-User": userId }, signal });
  if (!response.ok) throw new Error(response.status === 401 ? "Sign in to keep your place in lessons." : "Your lessons couldn't be loaded. Try again.");
  return ((await response.json()) as { progress: LessonProgress[] }).progress;
}

/** The first token of a sentence, as the server counts tokens, and back: how a lesson's place is kept. */
export function tokenIndexOfSentence(tokens: ReadonlyArray<{ i: number; sentence: number }>, sentence: number): number {
  return tokens.find((token) => token.sentence >= sentence)?.i ?? 0;
}
export function sentenceOfTokenIndex(tokens: ReadonlyArray<{ i: number; sentence: number }>, index: number): number {
  return tokens.find((token) => token.i >= index)?.sentence ?? 0;
}

const AUTO_KNOWN_KEY = "margin-chat:language-reader:auto-known" as const;
const AUTO_KNOWN_EXPLAINED_KEY = "margin-chat:language-reader:auto-known-explained" as const;
const read = (key: string) => { try { return localStorage.getItem(key); } catch { return null; } };
/** Whether turning a page marks the words still new on it as known. On unless turned off. */
export const autoMarkKnown = () => read(AUTO_KNOWN_KEY) !== "off";
export const autoKnownExplained = () => read(AUTO_KNOWN_EXPLAINED_KEY) === "1";
export { AUTO_KNOWN_KEY, AUTO_KNOWN_EXPLAINED_KEY };
