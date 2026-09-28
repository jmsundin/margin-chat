import { createContext, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import { useVisualViewport } from "../lib/useVisualViewport";
import "./MobileKeyboard.css";

const mobileQueries = ["(max-width: 700px)", "(pointer: coarse)"];
const MobileKeyboardContext = createContext({ mobile: false, inputMode: "text" as "none" | "text" });
export const useMobileKeyboard = () => useContext(MobileKeyboardContext);

/** Keep native editable selection, but let the reader explicitly request the software keyboard. */
export function MobileKeyboardProvider({ children }: { children: ReactNode }) {
  const [mobile, setMobile] = useState(() => mobileQueries.some((query) => window.matchMedia(query).matches));
  const [enabled, setEnabled] = useState(false);
  const [hasTarget, setHasTarget] = useState(false);
  const target = useRef<HTMLElement | null>(null);
  const keyboardSession = useRef<{ height: number; width: number; reduced: boolean } | null>(null);
  const viewport = useVisualViewport(mobile);
  const safeBottom = viewport.height < window.innerHeight - 100 ? "0px" : "env(safe-area-inset-bottom, 0px)";
  useEffect(() => {
    const queries = mobileQueries.map((query) => window.matchMedia(query));
    const update = () => { setMobile(queries.some((query) => query.matches)); setEnabled(false); };
    queries.forEach((query) => query.addEventListener("change", update));
    return () => queries.forEach((query) => query.removeEventListener("change", update));
  }, []);
  useEffect(() => {
    if (!mobile) return;
    const focus = (event: FocusEvent) => {
      const element = event.target instanceof HTMLElement ? event.target : null;
      if (element?.closest("[data-mobile-keyboard-toggle]")) return;
      const field = element?.closest<HTMLElement>("[data-mobile-keyboard]") ?? null;
      target.current = field;
      setHasTarget(Boolean(field));
      if (!field) setEnabled(false);
    };
    document.addEventListener("focusin", focus);
    return () => document.removeEventListener("focusin", focus);
  }, [mobile]);

  useEffect(() => {
    const session = keyboardSession.current;
    if (!enabled || !session) return;
    // Return to selection mode when the OS keyboard's own dismiss action is
    // used. Ignore orientation changes, which also resize the viewport.
    if (viewport.width !== session.width) { keyboardSession.current = null; return; }
    if (viewport.height < session.height - 100) session.reduced = true;
    else if (session.reduced && viewport.height >= session.height - 40) {
      keyboardSession.current = null;
      setEnabled(false);
    }
  }, [enabled, viewport.height, viewport.width]);

  function toggle() {
    const field = target.current;
    if (!field?.isConnected) { setHasTarget(false); return; }
    const native = window.getSelection();
    const range = native?.rangeCount && field.contains(native.anchorNode) ? native.getRangeAt(0).cloneRange() : null;
    const input = field instanceof HTMLInputElement || field instanceof HTMLTextAreaElement ? field : null;
    const start = input?.selectionStart, end = input?.selectionEnd;
    // Mount/update attributes and focus synchronously in the tap gesture, which
    // iOS requires for opening its software keyboard. Keep the exact selection.
    keyboardSession.current = enabled ? null : { height: viewport.height, width: viewport.width, reduced: false };
    field.blur();
    flushSync(() => setEnabled(!enabled));
    field.setAttribute("inputmode", enabled ? "none" : "text");
    field.focus({ preventScroll: true });
    if (input && start != null && end != null) input.setSelectionRange(start, end);
    else if (range && native) { native.removeAllRanges(); native.addRange(range); }
  }

  const value = useMemo(() => ({ mobile, inputMode: mobile && !enabled ? "none" as const : "text" as const }), [mobile, enabled]);
  return <MobileKeyboardContext.Provider value={value}>
    {children}
    {mobile && hasTarget && createPortal(<button type="button" className="mobile-keyboard-toggle" data-mobile-keyboard-toggle
      aria-label={enabled ? "Hide keyboard" : "Show keyboard"} title={enabled ? "Hide keyboard" : "Show keyboard"} aria-pressed={enabled}
      style={{ top: `calc(${viewport.top + viewport.height - 56}px - ${safeBottom})`, left: viewport.left + viewport.width - 60 }}
      onPointerDown={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()} onClick={toggle}>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <rect x="2" y="5" width="20" height="14" rx="3" />
        <path d="M5 9h2m2 0h2m2 0h2m2 0h2M5 12h2m2 0h2m2 0h2m2 0h2M7 16h10" />
      </svg>
    </button>, document.body)}
  </MobileKeyboardContext.Provider>;
}

/** Portaling avoids clipping and transformed containing blocks in document panes. */
export function MobileComposerViewport({ children }: { children: ReactNode }) {
  const viewport = useVisualViewport(true);
  const safeBottom = viewport.height < window.innerHeight - 100 ? "0px" : "env(safe-area-inset-bottom, 0px)";
  return createPortal(<div className="mobile-composer-viewport" style={{ top: viewport.top, left: viewport.left, width: viewport.width, height: viewport.height, paddingBottom: `calc(8px + ${safeBottom})` }}>{children}</div>, document.body);
}
