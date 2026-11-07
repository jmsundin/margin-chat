/**
 * How the AI thinks with you, and where its questions and your notes show (the Customise
 * window). Saved per device, like the quiet page.
 *
 * - aiBehaviour "thinks": answers hand the thinking back with a follow-up question.
 *   "asks": the AI only answers what you ask.
 * - marginMode "right": notes sit in the right margin beside their passage.
 *   "marks": only a dot beside each passage; click it to open the note. Phones always use marks
 *   while the quiet page is on.
 * - proactive: the AI may post a question in the margin on its own after you pause (off until turned on).
 * - stance: how its questions lean: supportive, neutral or antagonistic.
 */
export type AIBehaviour = "thinks" | "asks";
export type MarginMode = "right" | "marks";
export type AIStance = "supportive" | "neutral" | "antagonistic";
export interface NotebookPrefs { aiBehaviour: AIBehaviour; marginMode: MarginMode; proactive: boolean; stance: AIStance }

const KEY = "margin-chat:notebook";
export const DEFAULT_NOTEBOOK_PREFS: NotebookPrefs = { aiBehaviour: "thinks", marginMode: "right", proactive: false, stance: "supportive" };
const listeners = new Set<() => void>();
let cached: { raw: string | null; prefs: NotebookPrefs } | null = null;

export function parseNotebookPrefs(raw: string | null): NotebookPrefs {
  let value: Partial<NotebookPrefs> = {};
  try { value = raw ? JSON.parse(raw) ?? {} : {}; } catch { value = {}; }
  return {
    aiBehaviour: value.aiBehaviour === "asks" ? "asks" : "thinks",
    marginMode: value.marginMode === "marks" ? "marks" : "right",
    proactive: value.proactive === true,
    stance: value.stance === "neutral" || value.stance === "antagonistic" ? value.stance : "supportive",
  };
}

/** The same object until the saved value changes, as useSyncExternalStore needs. */
export function readNotebookPrefs(): NotebookPrefs {
  let raw: string | null;
  try { raw = localStorage.getItem(KEY); }
  catch { return cached?.prefs ?? DEFAULT_NOTEBOOK_PREFS; }
  if (!cached || cached.raw !== raw) cached = { raw, prefs: parseNotebookPrefs(raw) };
  return cached.prefs;
}

export function saveNotebookPrefs(change: Partial<NotebookPrefs>) {
  const next = { ...readNotebookPrefs(), ...change };
  try { localStorage.setItem(KEY, JSON.stringify(next)); }
  catch { cached = { raw: JSON.stringify(next), prefs: next }; }
  listeners.forEach((listener) => listener());
}

export function subscribeNotebookPrefs(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}
