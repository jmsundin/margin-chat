import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { createPortal, flushSync } from "react-dom";
import { editorActionsOf, runEditorCommand, type EditorAction, type EditorCommand } from "../lib/editorCommands";
import { MicIcon } from "./DictationButton";
import { CODE_KEYS_ATTRIBUTE, codeKeyRows, sendCodeKey, type CodeKey } from "../lib/codeKeys";
import { setMobileDockSlot } from "../lib/mobileDock";
import { useVisualViewport } from "../lib/useVisualViewport";
import "./MobileKeyboard.css";

const mobileQueries = ["(max-width: 700px)", "(pointer: coarse)"];
const MobileKeyboardContext = createContext({ mobile: false, inputMode: "text" as "none" | "text", registerComposer: () => () => {}, overlayOpen: false });
export const useMobileKeyboard = () => useContext(MobileKeyboardContext);

/**
 * Fields inside are for typing, not reading: a tap brings the software keyboard straight up,
 * with no trip to the keyboard button (used for an open margin note on phones).
 */
export function MobileKeyboardDirect({ children }: { children: ReactNode }) {
  const parent = useMobileKeyboard();
  const value = useMemo(() => ({ ...parent, inputMode: "text" as const }), [parent]);
  return <MobileKeyboardContext.Provider value={value}>{children}</MobileKeyboardContext.Provider>;
}

/** Keep native editable selection, but let the reader explicitly request the software keyboard. */
export function MobileKeyboardProvider({ children }: { children: ReactNode }) {
  const [mobile, setMobile] = useState(() => mobileQueries.some((query) => window.matchMedia(query).matches));
  const [enabled, setEnabled] = useState(false);
  const [hasTarget, setHasTarget] = useState(false);
  const [composerCount, setComposerCount] = useState(0);
  /** The code block holding the caret: its editor and language, for the programming keys. */
  const [code, setCode] = useState<{ field: HTMLElement; language: string } | null>(null);
  const registerComposer = useCallback(() => {
    // The AI textarea has its own native typing session. Return the document
    // to selection mode so closing the dock doesn't reopen its keyboard.
    setEnabled(false);
    setComposerCount((count) => count + 1);
    return () => setComposerCount((count) => count - 1);
  }, []);
  const target = useRef<HTMLElement | null>(null);
  const touchGesture = useRef<{ x: number; y: number; moved: boolean } | null>(null);
  const lastTouchActivation = useRef(-Infinity);
  /** The keyboard button refocuses its field; that focus must not turn the keyboard back on. */
  const toggling = useRef(false);
  const keyboardSession = useRef<{ height: number; width: number; reduced: boolean } | null>(null);
  const viewport = useVisualViewport(mobile);
  const viewportRef = useRef(viewport);
  viewportRef.current = viewport;
  const micSlot = useCallback((element: HTMLElement | null) => setMobileDockSlot("mic", element), []);
  const createSlot = useCallback((element: HTMLElement | null) => setMobileDockSlot("create", element), []);
  const topSlot = useCallback((element: HTMLElement | null) => setMobileDockSlot("top", element), []);
  const keyboardShown = viewport.height < window.innerHeight - 100;
  const safeBottom = keyboardShown ? "0px" : "env(safe-area-inset-bottom, 0px)";
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
      if (element?.closest("[data-code-key-bar]")) return;
      const codeField = element?.closest<HTMLElement>(`[${CODE_KEYS_ATTRIBUTE}]`) ?? null;
      setCode((current) => codeField === (current?.field ?? null) ? current : codeField ? { field: codeField, language: codeField.getAttribute(CODE_KEYS_ATTRIBUTE) ?? "" } : null);
      const field = element?.closest<HTMLElement>("[data-mobile-keyboard]") ?? null;
      target.current = field;
      setHasTarget(Boolean(field));
      if (!field) { keyboardSession.current = null; setEnabled(false); }
      // A field made for typing (an open margin note) brings the keyboard up on its own tap, so
      // the writing bar shows and the keyboard's own dismiss returns to selection mode as usual.
      else if (!toggling.current && field.closest("[data-mobile-keyboard-direct]")) {
        keyboardSession.current ??= { height: viewportRef.current.height, width: viewportRef.current.width, reduced: false };
        setEnabled(true);
      }
    };
    // Leaving a code block for nothing (the keyboard's own Done) puts its keys away too.
    const blur = () => { setTimeout(() => setCode((current) => current && !current.field.contains(document.activeElement) ? null : current), 0); };
    document.addEventListener("focusin", focus);
    document.addEventListener("focusout", blur);
    return () => { document.removeEventListener("focusin", focus); document.removeEventListener("focusout", blur); };
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
    flushSync(() => setEnabled(!enabled));
    field.setAttribute("inputmode", enabled ? "none" : "text");
    // Finish React/ProseMirror updates before restarting the input session.
    // Opening uses native focus in the touch-end gesture (like Tiptap's iOS
    // focus path), rather than a scroll-suppressed or deferred focus request.
    toggling.current = true;
    try {
      field.blur();
      if (enabled) field.focus({ preventScroll: true });
      else field.focus();
    } finally { toggling.current = false; }
    if (input && start != null && end != null) input.setSelectionRange(start, end);
    else if (range && native) { native.removeAllRanges(); native.addRange(range); }
  }

  // The writing bar rides on top of the software keyboard while a document is being typed in.
  const barShown = mobile && enabled && hasTarget && composerCount === 0;
  const barActions = barShown ? editorActionsOf(target.current) : [];
  function runCommand(command: EditorCommand) {
    const field = target.current;
    if (!field?.isConnected) return;
    if (document.activeElement !== field && !field.contains(document.activeElement)) field.focus({ preventScroll: true });
    runEditorCommand(field, command);
  }

  const codeRows = useMemo(() => mobile && code && composerCount === 0 ? codeKeyRows(code.language) : null, [mobile, code, composerCount]);
  const codeBarHeight = codeRows ? CODE_KEY_ROW_HEIGHT + (codeRows.words.length ? CODE_WORD_ROW_HEIGHT : 0) : 0;
  function pressCodeKey(key: CodeKey) {
    if (!code?.field.isConnected) { setCode(null); return; }
    if (document.activeElement !== code.field) code.field.focus({ preventScroll: true });
    sendCodeKey(code.field, key);
  }

  // Floating buttons stay out of the way of an open AI composer or on-screen keyboard.
  const overlayOpen = mobile && (composerCount > 0 || keyboardShown);
  const value = useMemo(() => ({ mobile, inputMode: mobile && !enabled ? "none" as const : "text" as const, registerComposer, overlayOpen }), [mobile, enabled, registerComposer, overlayOpen]);
  return <MobileKeyboardContext.Provider value={value}>
    {children}
    {/* One stack at the bottom right: +, microphone, back to top, keyboard. While the on-screen
        keyboard is up, its own Done/checkmark closes it, so the stack would only cover text. */}
    {mobile && composerCount === 0 && !keyboardShown && createPortal(<div className="mobile-dock" data-mobile-dock
      // Kept clear of the rounded screen corners on curved phones: 24px up and 20px in.
      style={{ bottom: `calc(${window.innerHeight - viewport.top - viewport.height + 24 + (barShown ? KEYBOARD_BAR_HEIGHT : 0) + codeBarHeight}px + ${safeBottom})`, right: window.innerWidth - viewport.left - viewport.width + 20 }}>
      <span className="mobile-dock-slot" ref={createSlot} />
      <span className="mobile-dock-slot" ref={micSlot} />
      <span className="mobile-dock-slot" ref={topSlot} />
      {hasTarget ? <button type="button" className="mobile-keyboard-toggle" data-mobile-keyboard-toggle
      aria-label={enabled ? "Hide keyboard" : "Show keyboard"} title={enabled ? "Hide keyboard" : "Show keyboard"} aria-pressed={enabled}
      onPointerDown={(event) => { if (event.pointerType === "mouse") lastTouchActivation.current = -Infinity; event.preventDefault(); }}
      onMouseDown={(event) => event.preventDefault()}
      onTouchStart={(event) => {
        const touch = event.touches[0];
        touchGesture.current = event.touches.length === 1 ? { x: touch.clientX, y: touch.clientY, moved: false } : null;
      }}
      onTouchMove={(event) => {
        const gesture = touchGesture.current;
        const touch = event.touches[0];
        if (gesture && (!touch || event.touches.length !== 1 || Math.hypot(touch.clientX - gesture.x, touch.clientY - gesture.y) > 10)) gesture.moved = true;
      }}
      onTouchCancel={() => { touchGesture.current = null; }}
      onTouchEnd={(event) => {
        const gesture = touchGesture.current;
        touchGesture.current = null;
        // A scroll/cancel must not open the keyboard or synthesize a toggle.
        event.preventDefault();
        lastTouchActivation.current = event.timeStamp;
        if (gesture && !gesture.moved && event.touches.length === 0) toggle();
      }}
      onClick={(event) => {
        // Some WebKit versions still deliver a compatibility click. Keyboard
        // and assistive-technology activation (detail=0) must keep working.
        if (event.detail !== 0 && event.timeStamp - lastTouchActivation.current < 800) { event.preventDefault(); return; }
        toggle();
      }}>
      <svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.6" aria-hidden="true">
        <rect x="2" y="5" width="20" height="14" rx="3" />
        <path d="M5 9h2m2 0h2m2 0h2m2 0h2M5 12h2m2 0h2m2 0h2m2 0h2M7 16h10" />
      </svg>
    </button> : null}
    </div>, document.body)}
    {barShown && createPortal(<div className="mobile-keyboard-bar" role="toolbar" aria-label="Writing tools" data-mobile-keyboard-bar
      style={{ top: viewport.top + viewport.height - KEYBOARD_BAR_HEIGHT, left: viewport.left, width: viewport.width, height: KEYBOARD_BAR_HEIGHT }}>
      {keyboardBarButtons.map((button) => <KeyboardBarButton key={button.command} {...button} onRun={runCommand} />)}
      {/* Ask AI, the caret's ⋯ menu and voice typing, for editors that answer them: these used to be
          a row of chips inside the page under the caret's paragraph. */}
      {barActions.length ? <span className="mobile-keyboard-bar-spacer" /> : null}
      {keyboardBarActions.filter((button) => barActions.includes(button.command)).map((button) => <KeyboardBarButton key={button.command} {...button} onRun={runCommand} />)}
    </div>, document.body)}
    {codeRows && createPortal(<div className="code-key-bar" role="toolbar" aria-label="Programming keys" data-code-key-bar
      style={{ top: viewport.top + viewport.height - codeBarHeight, left: viewport.left, width: viewport.width, height: codeBarHeight }}>
      {codeRows.words.length ? <div className="code-key-row is-words" style={{ height: CODE_WORD_ROW_HEIGHT }}>
        {codeRows.words.map((word) => <CodeKeyButton key={word} className="code-key-word" label={word} onPress={() => pressCodeKey({ kind: "text", text: word })}>{word}</CodeKeyButton>)}
      </div> : null}
      <div className="code-key-row" style={{ height: CODE_KEY_ROW_HEIGHT }}>
        <CodeKeyButton className="code-key is-action" label="Tab" onPress={() => pressCodeKey({ kind: "tab" })}>⇥</CodeKeyButton>
        {codeRows.symbols.map((symbol) => <CodeKeyButton key={symbol} className="code-key" label={symbol} onPress={() => pressCodeKey({ kind: "text", text: symbol })}>{symbol}</CodeKeyButton>)}
      </div>
    </div>, document.body)}
  </MobileKeyboardContext.Provider>;
}

const KEYBOARD_BAR_HEIGHT = 44;
const iconProps = { width: 22, height: 22, viewBox: "0 0 24 24", fill: "none", stroke: "currentColor", strokeWidth: 1.7, strokeLinecap: "round" as const, strokeLinejoin: "round" as const, "aria-hidden": true };
const keyboardBarButtons: { command: EditorCommand; label: string; icon: ReactNode }[] = [
  { command: "wiki-link", label: "Insert [[ link", icon: <span className="mobile-keyboard-bar-text" aria-hidden="true">[[</span> },
  { command: "date-time", label: "Insert date and time (Ctrl+D)", icon: <svg {...iconProps}><rect x="3" y="5" width="18" height="16" rx="2.5" /><path d="M3 10h18M8 3v4M16 3v4M8 14h2m4 0h2M8 17.5h2" /></svg> },
  { command: "outdent", label: "Outdent (Shift+Tab)", icon: <svg {...iconProps}><path d="M11 6h10M11 12h10M11 18h10M7 9l-3 3 3 3" /></svg> },
  { command: "indent", label: "Indent (Tab)", icon: <svg {...iconProps}><path d="M11 6h10M11 12h10M11 18h10M4 9l3 3-3 3" /></svg> },
];

const keyboardBarActions: { command: EditorAction; label: string; icon: ReactNode; className?: string }[] = [
  { command: "ask-ai", label: "Ask AI here", className: "is-ask", icon: <span className="mobile-keyboard-bar-label" aria-hidden="true">✦ Ask AI</span> },
  { command: "caret-menu", label: "More actions here", icon: <span className="mobile-keyboard-bar-text" aria-hidden="true">⋯</span> },
  { command: "dictate", label: "Voice typing here", icon: <MicIcon size={20} /> },
];

const CODE_KEY_ROW_HEIGHT = 48;
const CODE_WORD_ROW_HEIGHT = 44;

/** A key in a row that scrolls sideways: a tap types, a swipe only scrolls, and neither takes the caret. */
function CodeKeyButton({ className, label, onPress, children }: { className: string; label: string; onPress: () => void; children: ReactNode }) {
  const lastTouch = useRef(-Infinity);
  const start = useRef<{ x: number; y: number } | null>(null);
  return <button type="button" className={className} aria-label={label}
    onPointerDown={(event) => { if (event.pointerType === "mouse") event.preventDefault(); }}
    onMouseDown={(event) => event.preventDefault()}
    onTouchStart={(event) => { const touch = event.touches[0]; start.current = event.touches.length === 1 ? { x: touch.clientX, y: touch.clientY } : null; }}
    onTouchCancel={() => { start.current = null; }}
    onTouchEnd={(event) => {
      const from = start.current, touch = event.changedTouches[0];
      start.current = null;
      if (event.cancelable) event.preventDefault();
      lastTouch.current = event.timeStamp;
      if (from && touch && Math.hypot(touch.clientX - from.x, touch.clientY - from.y) <= 10) onPress();
    }}
    onClick={(event) => { if (event.detail !== 0 && event.timeStamp - lastTouch.current < 800) return; onPress(); }}>
    {children}
  </button>;
}

/** Acts on touch end without taking focus, so the caret and keyboard stay where they are. */
function KeyboardBarButton({ command, label, icon, className, onRun }: { command: EditorCommand; label: string; icon: ReactNode; className?: string; onRun: (command: EditorCommand) => void }) {
  const lastTouch = useRef(-Infinity);
  return <button type="button" className={`mobile-keyboard-bar-button${className ? ` ${className}` : ""}`} aria-label={label} title={label}
    onPointerDown={(event) => event.preventDefault()}
    onMouseDown={(event) => event.preventDefault()}
    onTouchEnd={(event) => { event.preventDefault(); lastTouch.current = event.timeStamp; onRun(command); }}
    onClick={(event) => { if (event.detail !== 0 && event.timeStamp - lastTouch.current < 800) return; onRun(command); }}>
    {icon}
  </button>;
}

/** Portaling avoids clipping and transformed containing blocks in document panes. */
export function MobileComposerViewport({ children }: { children: ReactNode }) {
  const { registerComposer } = useMobileKeyboard();
  useEffect(() => registerComposer(), [registerComposer]);
  const viewport = useVisualViewport(true);
  const safeBottom = viewport.height < window.innerHeight - 100 ? "0px" : "env(safe-area-inset-bottom, 0px)";
  return createPortal(<div className="mobile-composer-viewport" data-mobile-composer style={{ top: viewport.top, left: viewport.left, width: viewport.width, height: viewport.height, paddingBottom: `calc(20px + ${safeBottom})` }}>{children}</div>, document.body);
}
