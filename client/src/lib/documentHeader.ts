const STORAGE_KEY = "margin-chat:document-header-open";

/** Whether the path and views row under the tabs is shown on a computer; it starts shown. */
export function loadDocumentHeaderOpen(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) !== "false"; } catch { return true; }
}

export function saveDocumentHeaderOpen(open: boolean) {
  try { localStorage.setItem(STORAGE_KEY, String(open)); } catch { /* Best effort. */ }
}
