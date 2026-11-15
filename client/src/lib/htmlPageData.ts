import { MAX_HTML_STORAGE_CHARS } from "./htmlDocuments";

/**
 * What an HTML page keeps in its `localStorage` (a game's progress, a quiz's answers) is saved with
 * the vault, in a small file beside the vault's other housekeeping, so it follows the person to every
 * device and survives a cleared browser. This device also keeps a copy to open the page at once and
 * to work offline; whichever copy was saved last is the one the page opens with.
 */
export interface HtmlPageData { savedAt: number; data: Record<string, string> }

/** Where a page's saved data lives in the vault. It follows the page's path, so every device finds the same file. */
export function htmlPageDataPath(pagePath: string) {
  return `.margin-chat/page-data/${pagePath.normalize("NFC")}.json`;
}

export function encodeHtmlPageData(value: HtmlPageData) {
  return JSON.stringify({ version: 1, savedAt: value.savedAt, data: value.data });
}

/** Reads a saved copy; anything malformed or too large is treated as no copy. A bare map is the form this device kept before pages synced. */
export function decodeHtmlPageData(text: string | null | undefined): HtmlPageData | null {
  if (!text) return null;
  let parsed: unknown;
  try { parsed = JSON.parse(text); } catch { return null; }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const wrapped = (parsed as { version?: unknown }).version === 1 && typeof (parsed as { data?: unknown }).data === "object";
  const raw = wrapped ? (parsed as { data: unknown }).data : parsed;
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return null;
  const data: Record<string, string> = {};
  let size = 0;
  for (const [key, item] of Object.entries(raw)) {
    if (typeof item !== "string") return null;
    size += key.length + item.length;
    if (size > MAX_HTML_STORAGE_CHARS) return null;
    data[key] = item;
  }
  const savedAt = wrapped ? Number((parsed as { savedAt?: unknown }).savedAt) : 0;
  return { savedAt: Number.isFinite(savedAt) && savedAt > 0 ? savedAt : 0, data };
}

/** The copy saved last; this device's own wins a tie, since it is what the person last saw here. */
export function newerHtmlPageData(local: HtmlPageData | null, vault: HtmlPageData | null): HtmlPageData | null {
  if (!local) return vault;
  if (!vault) return local;
  return vault.savedAt > local.savedAt ? vault : local;
}

export function sameHtmlPageData(a: Record<string, string>, b: Record<string, string>) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((key) => a[key] === b[key]);
}

/** Where this device keeps what a page saved in its localStorage, per page document. */
const htmlStorageKey = (documentId: string) => `margin-chat:html-page-storage:${documentId}`;

/** This device's copy of what a page saved: read at once when the page opens, and the copy that works offline. */
export function loadHtmlStorage(documentId: string): HtmlPageData | null {
  try { return decodeHtmlPageData(localStorage.getItem(htmlStorageKey(documentId))); } catch { return null; }
}

export function saveHtmlStorage(documentId: string, value: HtmlPageData) {
  try { localStorage.setItem(htmlStorageKey(documentId), encodeHtmlPageData(value)); }
  catch { /* Without room here the vault's copy still holds it. */ }
}
