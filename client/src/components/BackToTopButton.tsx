import { useEffect, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { useVisualViewport } from "../lib/useVisualViewport";
import { useMobileKeyboard } from "./MobileKeyboard";
import "./BackToTopButton.css";

/** How many screens down the reader must be before the button appears. */
const SHOW_AFTER_SCREENS = 1.5;

/** A quiet "back to top" button for a long document, shown once the reader is far down. */
export default function BackToTopButton({ scrollRef, active }: { scrollRef: RefObject<HTMLElement | null>; active: boolean }) {
  const { mobile, overlayOpen } = useMobileKeyboard();
  const [far, setFar] = useState(false);
  useEffect(() => {
    const body = scrollRef.current;
    if (!body) return;
    const update = () => setFar(body.scrollTop > body.clientHeight * SHOW_AFTER_SCREENS);
    update();
    body.addEventListener("scroll", update, { passive: true });
    return () => body.removeEventListener("scroll", update);
  }, [scrollRef]);
  // Phones show one document at a time; only the active one owns the screen corner.
  const floating = mobile && active;
  const viewport = useVisualViewport(floating && far);
  if (!far || (mobile && (!active || overlayOpen))) return null;
  // Jump straight there: CodeMirror re-measures lines while a smooth scroll
  // runs, which can stop it partway up a long document.
  const toTop = () => scrollRef.current?.scrollTo({ top: 0 });
  const button = <button type="button" className={`back-to-top${floating ? " is-floating" : ""}`} aria-label="Back to top" title="Back to top"
    // Stacked directly above the keyboard button at the right end of the phone's bottom row (48px, 20px in from the edge, 72px up).
    style={floating ? { top: `calc(${viewport.top + viewport.height - 72 - 8 - 40}px - env(safe-area-inset-bottom, 0px))`, left: viewport.left + viewport.width - 64 } : undefined}
    onPointerDown={(event) => event.preventDefault()} onClick={toTop}>
    <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <path d="M6 4h12M12 20V9m-5 5 5-5 5 5"/>
    </svg>
  </button>;
  return floating ? createPortal(button, document.body) : button;
}
