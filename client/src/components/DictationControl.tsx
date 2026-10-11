import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import { requestDictationTranscript } from "../lib/api";
import {
  dictationShortcutLabel,
  dictationSupported,
  findDictationTarget,
  insertDictation,
  isDictationShortcut,
  readDictationButtonPreference,
  startDictationRecording,
  subscribeDictationButtonPreference,
  type DictationRecording,
} from "../lib/dictation";
import "./DictationControl.css";

type Phase =
  | { kind: "idle" }
  | { kind: "starting"; target: HTMLElement }
  | { kind: "recording"; target: HTMLElement; startedAt: number }
  | { kind: "transcribing"; target: HTMLElement }
  | { kind: "notice"; target: HTMLElement | null; message: string };

/** Distances from the viewport's right and bottom edges, so wider or taller states grow away from the corner. */
interface Anchor { right: number; bottom: number }

const BUTTON_SIZE = 24;
const INSET = 6;
// Holding the shortcut longer than this makes it push-to-talk: letting go stops.
const HOLD_MS = 450;
const SHORTEST_RECORDING_MS = 300;

/** Bottom-right corner of the part of the field that is on screen. */
function anchorFor(target: HTMLElement): Anchor | null {
  const rect = target.getBoundingClientRect();
  const right = Math.min(rect.right, window.innerWidth);
  const bottom = Math.min(rect.bottom, window.innerHeight);
  const top = Math.max(rect.top, 0);
  if (right - Math.max(rect.left, 0) < BUTTON_SIZE || bottom - top < 12) return null;
  const singleLine = rect.height < 48;
  const buttonTop = singleLine ? rect.top + (rect.height - BUTTON_SIZE) / 2 : bottom - BUTTON_SIZE - INSET;
  return {
    right: Math.max(4, window.innerWidth - right + INSET),
    bottom: Math.max(4, window.innerHeight - buttonTop - BUTTON_SIZE),
  };
}

function describeError(error: unknown): string {
  if (error instanceof DOMException) {
    if (error.name === "NotAllowedError" || error.name === "SecurityError") return "Microphone access is blocked. Allow it in your browser or system settings, then try again.";
    if (error.name === "NotFoundError") return "No microphone was found.";
    if (error.name === "AbortError") return "Voice typing was cancelled.";
  }
  return error instanceof Error && error.message ? error.message : "Voice typing didn't work. Try again.";
}

function formatElapsed(ms: number) {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/**
 * Voice typing for every text field in the app: a mic button on the focused
 * field and a shortcut that records, transcribes and types at the cursor.
 */
export default function DictationControl({ userId }: { userId?: string }) {
  const supported = dictationSupported();
  const showButton = useSyncExternalStore(subscribeDictationButtonPreference, readDictationButtonPreference, () => true);
  const [focused, setFocused] = useState<HTMLElement | null>(null);
  const [phase, setPhaseState] = useState<Phase>({ kind: "idle" });
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [level, setLevel] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [typing, setTyping] = useState(false);
  // Read by async steps and key handlers, so it changes with each update, not each render.
  const phaseRef = useRef<Phase>(phase);
  const setPhase = useCallback((next: Phase) => { phaseRef.current = next; setPhaseState(next); }, []);
  const recordingRef = useRef<DictationRecording | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const keyPressRef = useRef<number | null>(null);
  const noticeTimer = useRef(0);
  const coarsePointer = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches && !window.matchMedia("(any-pointer: fine)").matches;

  const showNotice = useCallback((target: HTMLElement | null, message: string) => {
    window.clearTimeout(noticeTimer.current);
    setPhase({ kind: "notice", target, message });
    noticeTimer.current = window.setTimeout(() => {
      if (phaseRef.current.kind === "notice") setPhase({ kind: "idle" });
    }, 6000);
  }, []);

  const finish = useCallback(async () => {
    const current = phaseRef.current;
    const recording = recordingRef.current;
    if (current.kind !== "recording" || !recording) return;
    recordingRef.current = null;
    keyPressRef.current = null;
    if (Date.now() - current.startedAt < SHORTEST_RECORDING_MS) {
      recording.cancel();
      setPhase({ kind: "idle" });
      return;
    }
    const { target } = current;
    setPhase({ kind: "transcribing", target });
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      const audio = await recording.stop();
      const text = await requestDictationTranscript(audio, { expectedUserId: userId, signal: controller.signal });
      if (controller.signal.aborted) return;
      if (!text.trim()) { showNotice(target, "Didn't catch anything. Try again a little closer to the mic."); return; }
      if (insertDictation(target, text)) { setPhase({ kind: "idle" }); return; }
      await navigator.clipboard?.writeText(text).catch(() => undefined);
      showNotice(null, "That field closed, so the transcript was copied instead.");
    } catch (error) {
      if (controller.signal.aborted) return;
      showNotice(target, describeError(error));
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [showNotice, userId]);

  const cancel = useCallback(() => {
    recordingRef.current?.cancel();
    recordingRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    keyPressRef.current = null;
    setPhase({ kind: "idle" });
  }, []);

  const start = useCallback(async (target: HTMLElement) => {
    if (phaseRef.current.kind === "starting" || phaseRef.current.kind === "recording" || phaseRef.current.kind === "transcribing") return;
    setPhase({ kind: "starting", target });
    try {
      const recording = await startDictationRecording({
        onLevel: setLevel,
        onLimit: () => { void finish(); },
      });
      // Esc or a second press while the microphone was opening.
      if ((phaseRef.current as Phase).kind !== "starting") { recording.cancel(); return; }
      recordingRef.current = recording;
      setPhase({ kind: "recording", target, startedAt: Date.now() });
    } catch (error) {
      keyPressRef.current = null;
      showNotice(target, describeError(error));
    }
  }, [finish, showNotice]);

  const toggle = useCallback((target: HTMLElement | null) => {
    const current = phaseRef.current;
    if (current.kind === "recording") { void finish(); return; }
    if (current.kind === "starting" || current.kind === "transcribing") return;
    if (!target) { showNotice(null, `Click into a text field, then press ${dictationShortcutLabel()} to talk.`); return; }
    void start(target);
  }, [finish, showNotice, start]);

  // Follow which text field has focus.
  useEffect(() => {
    if (!supported) return undefined;
    const update = () => setFocused(findDictationTarget(document.activeElement));
    const onKeyDown = (event: KeyboardEvent) => {
      if (!event.metaKey && !event.ctrlKey && !event.altKey && event.key.length === 1) setTyping(true);
    };
    const onPointerMove = () => setTyping(false);
    // Focus moving between fields passes through the body; settle after it.
    const onFocusOut = () => window.setTimeout(update, 0);
    update();
    document.addEventListener("focusin", update);
    document.addEventListener("focusout", onFocusOut);
    document.addEventListener("keydown", onKeyDown, true);
    document.addEventListener("pointermove", onPointerMove, { passive: true });
    return () => {
      document.removeEventListener("focusin", update);
      document.removeEventListener("focusout", onFocusOut);
      document.removeEventListener("keydown", onKeyDown, true);
      document.removeEventListener("pointermove", onPointerMove);
    };
  }, [supported]);

  // The shortcut: press to start and again to stop, or hold to talk. Esc cancels.
  useEffect(() => {
    if (!supported) return undefined;
    const onKeyDown = (event: KeyboardEvent) => {
      const kind = phaseRef.current.kind;
      if (event.key === "Escape" && (kind === "recording" || kind === "starting" || kind === "transcribing")) {
        event.preventDefault();
        event.stopPropagation();
        cancel();
        return;
      }
      if (!isDictationShortcut(event)) return;
      event.preventDefault();
      event.stopPropagation();
      if (event.repeat) return;
      if (kind !== "recording") keyPressRef.current = Date.now();
      toggle(findDictationTarget(document.activeElement));
    };
    const onKeyUp = (event: KeyboardEvent) => {
      const pressed = keyPressRef.current;
      if (pressed === null || event.code !== "Space") return;
      keyPressRef.current = null;
      if (Date.now() - pressed >= HOLD_MS && phaseRef.current.kind === "recording") void finish();
    };
    window.addEventListener("keydown", onKeyDown, true);
    window.addEventListener("keyup", onKeyUp, true);
    return () => {
      window.removeEventListener("keydown", onKeyDown, true);
      window.removeEventListener("keyup", onKeyUp, true);
    };
  }, [cancel, finish, supported, toggle]);

  useEffect(() => () => cancel(), [cancel]);

  const activeTarget = phase.kind === "idle" ? null : phase.target;
  const buttonTarget = showButton && !coarsePointer && !typing ? focused : null;
  const anchorTarget = activeTarget ?? (phase.kind === "idle" ? buttonTarget : null);

  // Keep the control on its field as the page scrolls, resizes or reflows.
  useEffect(() => {
    if (!anchorTarget) { setAnchor(null); return undefined; }
    let frame = 0;
    const measure = () => {
      frame = 0;
      const next = anchorFor(anchorTarget);
      setAnchor((current) => current?.right === next?.right && current?.bottom === next?.bottom ? current : next);
    };
    const schedule = () => { if (!frame) frame = requestAnimationFrame(measure); };
    measure();
    const resize = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(schedule);
    resize?.observe(anchorTarget);
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    document.addEventListener("input", schedule, true);
    return () => {
      cancelAnimationFrame(frame);
      resize?.disconnect();
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      document.removeEventListener("input", schedule, true);
    };
  }, [anchorTarget]);

  useEffect(() => {
    if (phase.kind !== "recording") return undefined;
    const timer = window.setInterval(() => setNow(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, [phase.kind]);

  if (!supported) return null;

  const floating = anchor
    ? { right: anchor.right, bottom: anchor.bottom }
    : { left: "50%", bottom: 24, transform: "translateX(-50%)" };

  if (phase.kind === "idle") {
    if (!buttonTarget || !anchor) return null;
    return createPortal(
      <button
        aria-label={`Voice typing (${dictationShortcutLabel()})`}
        className="dictation-mic"
        data-dictation="off"
        onClick={() => toggle(buttonTarget)}
        onMouseDown={(event) => event.preventDefault()}
        style={floating}
        title={`Voice typing (${dictationShortcutLabel()})`}
        type="button"
      >
        <MicIcon />
      </button>,
      document.body,
    );
  }

  return createPortal(
    <div className={`dictation-pill is-${phase.kind}`} data-dictation="off" role="status" style={floating} onMouseDown={(event) => event.preventDefault()}>
      {phase.kind === "notice" ? (
        <>
          <span className="dictation-pill-message">{phase.message}</span>
          <button aria-label="Dismiss" className="dictation-pill-button" onClick={() => setPhase({ kind: "idle" })} type="button">×</button>
        </>
      ) : phase.kind === "transcribing" ? (
        <>
          <span className="dictation-spinner" aria-hidden="true" />
          <span>Transcribing…</span>
        </>
      ) : (
        <>
          <button aria-label="Stop and type what I said" className="dictation-pill-button is-stop" onClick={() => void finish()} title="Stop and type" type="button">
            <span className="dictation-level" style={{ transform: `scale(${1 + level * 0.9})` }} aria-hidden="true" />
            <span className="dictation-stop-square" aria-hidden="true" />
          </button>
          <span className="dictation-elapsed">{phase.kind === "recording" ? formatElapsed(Math.max(0, now - phase.startedAt)) : "Starting…"}</span>
          <button aria-label="Cancel voice typing" className="dictation-pill-button" onClick={cancel} title="Cancel (Esc)" type="button">×</button>
        </>
      )}
    </div>,
    document.body,
  );
}

function MicIcon() {
  return (
    <svg aria-hidden="true" fill="none" height="14" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="2" viewBox="0 0 24 24" width="14">
      <rect height="12" rx="3" width="6" x="9" y="3" />
      <path d="M5 11a7 7 0 0 0 14 0M12 18v3" />
    </svg>
  );
}
