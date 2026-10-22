import { useEffect, useRef, useState, type RefObject } from "react";
import { createPortal } from "react-dom";
import { EditorSelection } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import { requestDictation } from "../lib/dictation";
import { useVisualViewport } from "../lib/useVisualViewport";
import { MicIcon, useDictationButton } from "./DictationButton";
import { useMobileKeyboard } from "./MobileKeyboard";
import "./BackToTopButton.css";

/** How many screens down the reader must be before the button appears. */
const SHOW_AFTER_SCREENS = 1.5;
/** Phones: the keyboard button's top is 72px up; each button above it is 40px with an 8px gap. */
const PHONE_STACK_BOTTOM = 72 + 8 + 40;
const STACK_STEP = 40 + 8;

/** The document's editable text, the field the corner mic types into. */
function editableText(body: HTMLElement | null): HTMLElement | null {
  return body?.querySelector<HTMLElement>(".rich-document-editor [contenteditable='true']") ?? null;
}

/**
 * Scrolls to the top so the reader sees the text go by, like following a link
 * to a heading. Set frame by frame rather than with smooth scrolling: CodeMirror
 * re-measures lines as they pass, which can stop a smooth scroll partway up.
 */
function glideToTop(body: HTMLElement) {
  const start = body.scrollTop;
  if (start <= 0) return;
  if (window.matchMedia?.("(prefers-reduced-motion: reduce)").matches) { body.scrollTo({ top: 0 }); return; }
  const duration = Math.min(1100, 500 + start / 10);
  const began = performance.now();
  let frame = 0;
  // Scrolling by hand takes over.
  const stop = () => {
    cancelAnimationFrame(frame);
    body.removeEventListener("wheel", stop);
    body.removeEventListener("touchstart", stop);
    window.removeEventListener("keydown", stop, true);
  };
  const step = (now: number) => {
    const progress = Math.min(1, (now - began) / duration);
    // Eases in and out, so the start of the move is visible too.
    const eased = progress < 0.5 ? 4 * progress ** 3 : 1 - (-2 * progress + 2) ** 3 / 2;
    body.scrollTop = start * (1 - eased);
    if (progress < 1) frame = requestAnimationFrame(step);
    else stop();
  };
  body.addEventListener("wheel", stop, { passive: true });
  body.addEventListener("touchstart", stop, { passive: true });
  window.addEventListener("keydown", stop, true);
  frame = requestAnimationFrame(step);
}

/**
 * The document's corner: a quiet "back to top" button once the reader is far down,
 * and above it a mic for voice typing while the text hasn't been clicked into.
 * Once it has, the mic beside Ask AI at the caret takes over, and this one keeps
 * its place for the recording controls.
 */
export default function BackToTopButton({ scrollRef, active }: { scrollRef: RefObject<HTMLElement | null>; active: boolean }) {
  const { mobile, overlayOpen } = useMobileKeyboard();
  const micShown = useDictationButton();
  const [far, setFar] = useState(false);
  const [text, setText] = useState<{ editable: boolean; focused: boolean }>({ editable: false, focused: false });
  const touched = useRef(false);
  useEffect(() => {
    const body = scrollRef.current;
    if (!body) return;
    const update = () => setFar(body.scrollTop > body.clientHeight * SHOW_AFTER_SCREENS);
    update();
    body.addEventListener("scroll", update, { passive: true });
    return () => body.removeEventListener("scroll", update);
  }, [scrollRef]);
  useEffect(() => {
    const body = scrollRef.current;
    if (!body || !micShown) return undefined;
    const update = () => {
      const target = editableText(body);
      const focused = Boolean(target && document.activeElement instanceof Node && target.contains(document.activeElement));
      if (focused) touched.current = true;
      setText((current) => current.editable === Boolean(target) && current.focused === focused ? current : { editable: Boolean(target), focused });
    };
    // Focus moving between fields passes through the body; settle after it.
    const settle = () => window.setTimeout(update, 0);
    update();
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", settle);
    // Reading mode and loading switch the text's editability.
    const observer = typeof MutationObserver === "undefined" ? null : new MutationObserver(update);
    observer?.observe(body, { subtree: true, childList: true, attributes: true, attributeFilter: ["contenteditable"] });
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", settle);
      observer?.disconnect();
    };
  }, [scrollRef, micShown]);
  // Phones show one document at a time; only the active one owns the screen corner.
  const floating = mobile && active;
  const hidden = mobile && (!active || overlayOpen);
  const mic = micShown && text.editable && !hidden;
  const viewport = useVisualViewport(floating && (far || mic));
  if (hidden || (!far && !mic)) return null;

  const toTop = () => { if (scrollRef.current) glideToTop(scrollRef.current); };
  const talk = () => {
    const target = editableText(scrollRef.current);
    if (!target) return;
    const view = EditorView.findFromDOM(target);
    // Not clicked into yet: what's said goes at the end of the document.
    if (view && !touched.current) view.dispatch({ selection: EditorSelection.cursor(view.state.doc.length), scrollIntoView: true });
    if (view) view.focus(); else target.focus();
    requestDictation(target);
  };
  const place = (above: number) => floating
    // Stacked directly above the keyboard button at the right end of the phone's bottom row (48px, 20px in from the edge).
    ? { top: `calc(${viewport.top + viewport.height - PHONE_STACK_BOTTOM - above * STACK_STEP}px - env(safe-area-inset-bottom, 0px))`, left: viewport.left + viewport.width - 64 }
    : undefined;
  const buttons = <>
    {mic && <button type="button" className={`document-corner-mic${floating ? " is-floating" : ""}${text.focused ? " is-standby" : ""}`}
      data-dictation-slot="" data-dictation="off" aria-label="Voice typing" title="Voice typing" aria-hidden={text.focused || undefined}
      tabIndex={text.focused ? -1 : undefined} style={place(1)}
      onPointerDown={(event) => event.preventDefault()} onMouseDown={(event) => event.preventDefault()} onClick={talk}>
      <MicIcon size={18} />
    </button>}
    {far && <button type="button" className={`back-to-top${floating ? " is-floating" : ""}`} aria-label="Back to top" title="Back to top" style={place(0)}
      onPointerDown={(event) => event.preventDefault()} onClick={toTop}>
      <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d="M6 4h12M12 20V9m-5 5 5-5 5 5"/>
      </svg>
    </button>}
  </>;
  return floating ? createPortal(buttons, document.body) : buttons;
}
