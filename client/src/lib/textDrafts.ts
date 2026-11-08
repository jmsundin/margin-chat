/**
 * Text typed into a box that isn't part of a document yet (a question for the AI, say) is kept
 * on this device until it is sent or cleared, so a reload or a closed tab doesn't throw it away.
 */
const PREFIX = "margin-chat:text-draft:";
/** Drafts left alone this long are forgotten. */
export const TEXT_DRAFT_MAX_AGE_MS = 14 * 24 * 60 * 60_000;

export function loadTextDraft(key: string, now = Date.now()): string {
  try {
    const parsed = JSON.parse(window.localStorage.getItem(PREFIX + key) ?? "null") as { text?: unknown; savedAt?: unknown } | null;
    if (!parsed || typeof parsed.text !== "string" || typeof parsed.savedAt !== "number") return "";
    if (now - parsed.savedAt > TEXT_DRAFT_MAX_AGE_MS) { window.localStorage.removeItem(PREFIX + key); return ""; }
    return parsed.text;
  } catch {
    return "";
  }
}

export function saveTextDraft(key: string, text: string, now = Date.now()): void {
  try {
    if (text.trim()) window.localStorage.setItem(PREFIX + key, JSON.stringify({ text, savedAt: now }));
    else window.localStorage.removeItem(PREFIX + key);
  } catch {
    // Storage refused (private window, full): the box still works for this visit.
  }
}
