/**
 * On phones the app's own selection bar replaces the system's Cut / Copy / Paste menu.
 * This holds the clipboard actions it offers and the per-platform tricks that keep the
 * system menu out of the way while the app owns the selection.
 */

/** Text whose selections open the app's selection bar. */
export const APP_SELECTION_SELECTOR = ".rich-document-editor, [data-message-bubble='true'], [data-selection-source='standalone-note']";
/** Long presses here keep the system menu: links, media and form fields have their own. */
const NATIVE_MENU_SELECTOR = "a[href], img, video, audio, input, textarea, select";
const SETTLE_MS = 300;
const RESELECT_GAP_MS = 4;
const RESELECT_QUIET_MS = 120;

let reselecting = false;
/** True while the selection is briefly removed and restored to dismiss the iOS menu. */
export function isReselectingSelection() { return reselecting; }

function elementOf(node: Node | null): Element | null {
  return node instanceof Element ? node : node?.parentElement ?? null;
}

function appSelection(): Range | null {
  const selection = window.getSelection();
  if (!selection?.rangeCount || selection.isCollapsed) return null;
  const range = selection.getRangeAt(0);
  return elementOf(range.commonAncestorContainer)?.closest(APP_SELECTION_SELECTOR) ? range : null;
}

/** The editable element holding the selection, when it can be cut from and pasted into. */
export function selectionEditingHost(): HTMLElement | null {
  const range = appSelection();
  const element = elementOf(range?.commonAncestorContainer ?? null);
  if (!(element instanceof HTMLElement) || !element.isContentEditable) return null;
  let host: HTMLElement = element;
  while (host.parentElement?.isContentEditable) host = host.parentElement;
  return host;
}

export function isIOS() {
  return /iP(hone|ad|od)/.test(navigator.userAgent) || (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);
}

/**
 * Keep the system selection menu hidden while the app shows its own.
 *
 * Android Chrome shows its menu from the long press's `contextmenu` event, so cancelling that
 * event hides it and keeps the selection. iOS Safari has no web API for its edit menu; it does
 * drop the menu when the selection is removed and put back by script, so that is done once the
 * finger lifts and the selection settles.
 */
export function hideNativeSelectionMenu(): () => void {
  const ios = isIOS();
  let touching = false;
  let timer = 0;

  const onContextMenu = (event: Event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target?.closest(APP_SELECTION_SELECTOR) || target.closest(NATIVE_MENU_SELECTOR)) return;
    event.preventDefault();
  };

  const reselect = () => {
    timer = 0;
    const range = touching || reselecting ? null : appSelection();
    const selection = window.getSelection();
    if (!range || !selection) return;
    const saved = range.cloneRange();
    reselecting = true;
    selection.removeAllRanges();
    window.setTimeout(() => {
      // Put it back only if nothing else selected in the meantime.
      if (!selection.rangeCount) selection.addRange(saved);
      window.setTimeout(() => { reselecting = false; }, RESELECT_QUIET_MS);
    }, RESELECT_GAP_MS);
  };
  const schedule = () => {
    if (touching || reselecting) return;
    window.clearTimeout(timer);
    timer = window.setTimeout(reselect, SETTLE_MS);
  };
  const onTouchStart = () => { touching = true; window.clearTimeout(timer); timer = 0; };
  const onTouchEnd = (event: TouchEvent) => { if (!event.touches.length) { touching = false; schedule(); } };

  document.addEventListener("contextmenu", onContextMenu);
  if (ios) {
    document.addEventListener("touchstart", onTouchStart, { passive: true });
    document.addEventListener("touchend", onTouchEnd, { passive: true });
    document.addEventListener("touchcancel", onTouchEnd, { passive: true });
    document.addEventListener("selectionchange", schedule);
  }
  return () => {
    window.clearTimeout(timer);
    document.removeEventListener("contextmenu", onContextMenu);
    document.removeEventListener("touchstart", onTouchStart);
    document.removeEventListener("touchend", onTouchEnd);
    document.removeEventListener("touchcancel", onTouchEnd);
    document.removeEventListener("selectionchange", schedule);
  };
}

/** Copy the selection the way the system menu would, keeping rich text where the editor provides it. */
export async function copySelection(): Promise<boolean> {
  const range = appSelection();
  if (!range) return false;
  try { if (document.execCommand("copy")) return true; } catch { /* fall back to the async clipboard */ }
  try { await navigator.clipboard.writeText(range.toString()); return true; } catch { return false; }
}

export async function cutSelection(): Promise<boolean> {
  const host = selectionEditingHost();
  const range = appSelection();
  if (!host || !range) return false;
  try { if (document.execCommand("cut")) return true; } catch { /* fall back below */ }
  try { await navigator.clipboard.writeText(range.toString()); } catch { return false; }
  return document.execCommand("delete");
}

/**
 * Paste over the selection. The editor gets a real paste event first so Markdown and links
 * paste as they do from the keyboard; plain text is inserted when nothing handles it.
 */
export async function pasteIntoSelection(): Promise<boolean> {
  const host = selectionEditingHost();
  if (!host) return false;
  const range = appSelection()?.cloneRange();
  let text: string;
  try { text = await navigator.clipboard.readText(); } catch { return false; }
  if (!text) return false;
  // Reading the clipboard can show a system prompt; put the selection back if it moved.
  const selection = window.getSelection();
  if (range && selection && (!selection.rangeCount || selection.isCollapsed)) { selection.removeAllRanges(); selection.addRange(range); }
  if (typeof DataTransfer === "function") {
    try {
      const data = new DataTransfer();
      data.setData("text/plain", text);
      const event = new ClipboardEvent("paste", { clipboardData: data, bubbles: true, cancelable: true });
      if (event.clipboardData && !host.dispatchEvent(event)) return true;
    } catch { /* insert as text below */ }
  }
  return document.execCommand("insertText", false, text);
}

/** Select the whole block or message around the selection. */
export function selectAllAround(): boolean {
  const range = appSelection();
  const container = selectionEditingHost() ?? elementOf(range?.commonAncestorContainer ?? null)?.closest(APP_SELECTION_SELECTOR);
  const selection = window.getSelection();
  if (!container || !selection) return false;
  const next = document.createRange();
  next.selectNodeContents(container);
  selection.removeAllRanges();
  selection.addRange(next);
  return true;
}
