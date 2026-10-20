import { useEffect, useState, type RefObject } from "react";

const STORAGE_KEY = "margin-chat:document-header-open";

/** Whether the path and views row under the tabs is shown on a computer; it starts shown. */
export function loadDocumentHeaderOpen(): boolean {
  try { return localStorage.getItem(STORAGE_KEY) !== "false"; } catch { return true; }
}

export function saveDocumentHeaderOpen(open: boolean) {
  try { localStorage.setItem(STORAGE_KEY, String(open)); } catch { /* Best effort. */ }
}

/** How far a document must scroll down before the header slides away, and up before it returns. */
const HIDE_AFTER_PX = 24;
const SHOW_AFTER_PX = 12;

/**
 * True while the reader is scrolling down a document inside `area`, so a phone can give the
 * header's row to the text. Scrolling back up, or reaching the top, brings it back.
 */
export function useScrollAwayHeader(area: RefObject<HTMLElement | null>, enabled: boolean) {
  const [hidden, setHidden] = useState(false);
  useEffect(() => {
    const element = area.current;
    if (!enabled || !element) { setHidden(false); return; }
    const last = new WeakMap<EventTarget, number>();
    let travel = 0;
    function onScroll(event: Event) {
      const target = event.target;
      if (!(target instanceof HTMLElement) || target.scrollHeight <= target.clientHeight) return;
      const top = target.scrollTop;
      const previous = last.get(target);
      last.set(target, top);
      if (top <= 8) { travel = 0; setHidden(false); return; }
      // Horizontal scrolling, and the first event from a newly scrolled pane, say nothing about direction.
      if (previous === undefined || previous === top) return;
      const delta = top - previous;
      travel = Math.sign(travel) === Math.sign(delta) ? travel + delta : delta;
      if (travel > HIDE_AFTER_PX) setHidden(true);
      else if (travel < -SHOW_AFTER_PX) setHidden(false);
    }
    element.addEventListener("scroll", onScroll, { capture: true, passive: true });
    return () => element.removeEventListener("scroll", onScroll, { capture: true });
  }, [area, enabled]);
  return enabled && hidden;
}
