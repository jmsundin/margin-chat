/**
 * The quiet page: the document with as little around it as possible. One line
 * above the page, no frame around a lone document, and controls that show on
 * hover or from ⋮. On by default; Settings → Editor & look turns it off. Saved
 * per device.
 */
const QUIET_KEY = "margin-chat:quiet-page";
/** The quiet page starts with the sidebar closed, so it keeps its own open/closed memory. */
export const QUIET_SIDEBAR_KEY = "margin-chat:quiet-page-sidebar-open";
const listeners = new Set<() => void>();

export function readQuietPage(): boolean {
  try { return localStorage.getItem(QUIET_KEY) !== "false"; }
  catch { return true; }
}

export function saveQuietPage(quiet: boolean) {
  try { localStorage.setItem(QUIET_KEY, String(quiet)); }
  catch { /* Private windows keep the default. */ }
  listeners.forEach((listener) => listener());
}

export function subscribeQuietPage(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** Tabs show only when there's a choice to make: two or more documents, or a space you're in. */
export function showsQuietTabs(tabCount: number, inSpace: boolean): boolean {
  return inSpace || tabCount > 1;
}
