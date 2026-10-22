import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from "react";
import { createPortal } from "react-dom";
import {
  finishLiveDictationSession,
  renewLiveDictationSession,
  requestDictationTranscript,
  requestLiveDictationSession,
} from "../lib/api";
import { joinTranscripts } from "../lib/dictationText";
import { startLiveTranscription, type LiveTranscription } from "../lib/liveDictation";
import { useMobileDockSlot } from "../lib/mobileDock";
import { MicIcon } from "./DictationButton";
import {
  dictationHints,
  dictationShortcutLabel,
  dictationSupported,
  findDictationTarget,
  hasOwnDictationButton,
  insertDictation,
  isDictationShortcut,
  onDictationRequest,
  readDictationButtonPreference,
  readHoldSpacePreference,
  removeSpaceBeforeCursor,
  startDictationPreview,
  startDictationRecording,
  subscribeDictationButtonPreference,
  type DictationHints,
  type DictationPreview,
  type DictationRecording,
} from "../lib/dictation";
import "./DictationControl.css";

type Phase =
  | { kind: "idle" }
  | { kind: "starting"; target: HTMLElement }
  | { kind: "recording"; target: HTMLElement; startedAt: number }
  | { kind: "transcribing"; target: HTMLElement; done?: number; total?: number }
  | { kind: "notice"; target: HTMLElement | null; message: string; retry?: () => void };

/** Distances from the viewport's right and bottom edges, so wider or taller states grow away from the corner. */
interface Anchor { right: number; bottom: number }

const BUTTON_SIZE = 24;
const INSET = 6;
// Holding the shortcut longer than this makes it push-to-talk: letting go stops.
const HOLD_MS = 450;
// Holding plain Space talks once the key has repeated this often, so a quick tap still types a space.
const HOLD_SPACE_REPEATS = 2;
const SHORTEST_RECORDING_MS = 300;
// A hosted live session holds ten minutes of credit; renew it before that runs out.
const LIVE_RENEW_MS = 9 * 60 * 1000;
// Pieces of a long recording transcribed at once.
const TRANSCRIBE_CONCURRENCY = 2;

/** The document's corner mic, where its recording shows. Phones float the active document's at the screen corner. */
function slotFor(target: HTMLElement): HTMLElement | null {
  if (!hasOwnDictationButton(target)) return null;
  const slot = target.closest(".document-panel")?.querySelector<HTMLElement>("[data-dictation-slot]")
    ?? document.querySelector<HTMLElement>("[data-dictation-slot].is-floating");
  return slot?.getClientRects().length ? slot : null;
}

/** Bottom-right corner of the part of the field that is on screen, or the document's corner mic. */
function anchorFor(target: HTMLElement): Anchor | null {
  const slot = slotFor(target);
  if (slot) {
    const box = slot.getBoundingClientRect();
    return { right: Math.max(4, window.innerWidth - box.right), bottom: Math.max(4, window.innerHeight - box.bottom + (box.height - BUTTON_SIZE) / 2) };
  }
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

/** One recording's live transcription: words shown while talking, then the final text. */
interface LiveRun {
  transcription: LiveTranscription | null;
  preview: DictationPreview | null;
  token: string | null;
  ended: boolean;
  renewTimer: number;
}

/**
 * The recording's audio, a few minutes per piece. While live transcription
 * runs, the pieces are only kept; if it isn't available or drops, every piece
 * is transcribed on its own, a couple at a time.
 */
interface Pieces {
  audio: Blob[];
  texts: (Promise<string> | undefined)[];
  /** True once the pieces, not the live session, are the transcript. */
  batch: boolean;
  done: Set<number>;
  /** Stops every piece's request when voice typing is cancelled. */
  controller: AbortController;
  hints: DictationHints;
}

function formatElapsed(ms: number) {
  const seconds = Math.floor(ms / 1000);
  const hours = Math.floor(seconds / 3600);
  const minutes = Math.floor((seconds % 3600) / 60);
  const clock = `${String(seconds % 60).padStart(2, "0")}`;
  return hours ? `${hours}:${String(minutes).padStart(2, "0")}:${clock}` : `${minutes}:${clock}`;
}

/**
 * Voice typing for every text field in the app: a mic button on the focused
 * field, holding Space, or a shortcut, which record, transcribe and type at
 * the cursor. Recordings run as long as the person talks, and what they said
 * is typed word for word, like Claude Code.
 */
export default function DictationControl({ userId, segmentMs }: { userId?: string; segmentMs?: number }) {
  const supported = dictationSupported();
  const showButton = useSyncExternalStore(subscribeDictationButtonPreference, readDictationButtonPreference, () => true);
  const [focused, setFocused] = useState<HTMLElement | null>(null);
  const [phase, setPhaseState] = useState<Phase>({ kind: "idle" });
  const [anchor, setAnchor] = useState<Anchor | null>(null);
  const [level, setLevel] = useState(0);
  const [now, setNow] = useState(() => Date.now());
  const [typing, setTyping] = useState(false);
  // Live words for fields that can't show them in place.
  const [liveText, setLiveText] = useState("");
  const liveRef = useRef<LiveRun | null>(null);
  const piecesRef = useRef<Pieces | null>(null);
  // Read by async steps and key handlers, so it changes with each update, not each render.
  const phaseRef = useRef<Phase>(phase);
  const setPhase = useCallback((next: Phase) => { phaseRef.current = next; setPhaseState(next); }, []);
  const recordingRef = useRef<DictationRecording | null>(null);
  const abortRef = useRef<AbortController | null>(null);
  const keyPressRef = useRef<number | null>(null);
  // A plain Space press that may turn into push-to-talk if it's held.
  const spaceHoldRef = useRef<{ target: HTMLElement; repeats: number; started: boolean } | null>(null);
  const holdSpace = useSyncExternalStore(subscribeDictationButtonPreference, readHoldSpacePreference, () => true);
  const noticeTimer = useRef(0);
  const coarsePointer = typeof window !== "undefined" && window.matchMedia?.("(pointer: coarse)").matches && !window.matchMedia("(any-pointer: fine)").matches;
  // On phones the mic joins the bottom row beside the + and keyboard buttons while that row is shown.
  const dockSlot = useMobileDockSlot("mic");

  const showNotice = useCallback((target: HTMLElement | null, message: string, retry?: () => void) => {
    window.clearTimeout(noticeTimer.current);
    setPhase({ kind: "notice", target, message, retry });
    // A notice that can retry keeps the recording, so it stays until it's used or dismissed.
    if (retry) return;
    noticeTimer.current = window.setTimeout(() => {
      if (phaseRef.current.kind === "notice") setPhase({ kind: "idle" });
    }, 6000);
  }, []);

  // Stops a hosted session's charge; the server bills the time it ran.
  const endCharge = useCallback((run: LiveRun) => {
    window.clearInterval(run.renewTimer);
    if (run.token) void finishLiveDictationSession(run.token, userId);
    run.token = null;
  }, [userId]);

  /** Starts transcribing a piece of the recording, unless it already is. */
  const transcribePiece = useCallback((pieces: Pieces, index: number): Promise<string> => {
    const existing = pieces.texts[index];
    if (existing) return existing;
    // Wait for an earlier piece's slot, so a long recording doesn't flood the server.
    const ahead = pieces.texts[index - TRANSCRIBE_CONCURRENCY] ?? Promise.resolve("");
    const text = ahead.catch(() => "").then(() => requestDictationTranscript(pieces.audio[index], { expectedUserId: userId, signal: pieces.controller.signal, prompt: pieces.hints.prompt }));
    pieces.texts[index] = text;
    text.then(() => { pieces.done.add(index); }, () => {
      // A failed piece is tried again on the next attempt.
      if (pieces.texts[index] === text) pieces.texts[index] = undefined;
    });
    return text;
  }, [userId]);

  /** From now on the pieces are the transcript: transcribe the ones so far, and each new one as it ends. */
  const switchToPieces = useCallback((pieces: Pieces) => {
    if (pieces.batch) return;
    pieces.batch = true;
    pieces.audio.forEach((_, index) => { void transcribePiece(pieces, index).catch(() => undefined); });
  }, [transcribePiece]);

  /** Live transcription stopped working mid-recording; the recording's pieces take over. */
  const dropLive = useCallback((run: LiveRun) => {
    if (run.ended) return;
    run.ended = true;
    run.transcription?.close();
    run.transcription = null;
    endCharge(run);
    if (piecesRef.current) switchToPieces(piecesRef.current);
  }, [endCharge, switchToPieces]);

  const beginLive = useCallback((stream: MediaStream, target: HTMLElement, hints: DictationHints): LiveRun => {
    const run: LiveRun = { transcription: null, preview: startDictationPreview(target), token: null, ended: false, renewTimer: 0 };
    if (typeof RTCPeerConnection === "undefined") { run.ended = true; return run; }
    void (async () => {
      try {
        const session = await requestLiveDictationSession({ expectedUserId: userId, ...hints });
        run.token = session.token;
        if (run.ended) { endCharge(run); return; }
        const transcription = await startLiveTranscription({
          stream, clientSecret: session.clientSecret,
          onText: (text) => {
            if (run.ended) return;
            if (run.preview) run.preview.update(text);
            else setLiveText(text);
          },
          onDrop: () => dropLive(run),
        });
        if (run.ended) { transcription.close(); endCharge(run); return; }
        run.transcription = transcription;
        if (run.token) {
          // Long sessions keep going: bill the time so far and hold the next stretch.
          run.renewTimer = window.setInterval(() => {
            const token = run.token;
            if (!token || run.ended) return;
            renewLiveDictationSession(token, userId).then(
              (next) => { if (run.token === token) run.token = next; },
              // Finishing still settles the old hold, whatever the renewal got to.
              () => dropLive(run),
            );
          }, LIVE_RENEW_MS);
        }
      } catch {
        // Without a live session, the recording's pieces are transcribed instead.
        endCharge(run);
        run.ended = true;
        if (piecesRef.current) switchToPieces(piecesRef.current);
      }
    })();
    return run;
  }, [dropLive, endCharge, switchToPieces, userId]);

  /** Types the transcript where the words were going, and that's it, like Claude Code. */
  const deliver = useCallback((target: HTMLElement, text: string, preview: DictationPreview | null) => {
    const insertion = preview ? preview.commit(text) : insertDictation(target, text);
    if (!insertion) {
      void navigator.clipboard?.writeText(text).catch(() => undefined);
      showNotice(null, "That field closed, so the transcript was copied instead.");
      return;
    }
    setPhase({ kind: "idle" });
  }, [showNotice]);

  /** Turns the recording's pieces into one transcript and types it. Failures keep the audio for another try. */
  const transcribePieces = useCallback(async (target: HTMLElement, pieces: Pieces, preview: DictationPreview | null) => {
    const { controller } = pieces;
    abortRef.current = controller;
    const total = pieces.audio.length;
    setPhase({ kind: "transcribing", target, done: pieces.done.size, total });
    const progress = window.setInterval(() => {
      if (phaseRef.current.kind === "transcribing" && total > 1) setPhase({ kind: "transcribing", target, done: pieces.done.size, total });
    }, 500);
    try {
      const texts = await Promise.all(pieces.audio.map((_, index) => transcribePiece(pieces, index)));
      if (controller.signal.aborted) return;
      const raw = joinTranscripts(texts);
      if (!raw) {
        preview?.discard();
        showNotice(target, "Didn't catch anything. Try again a little closer to the mic.");
        return;
      }
      deliver(target, raw, preview);
    } catch (error) {
      if (controller.signal.aborted) return;
      preview?.discard();
      const retry = () => { void transcribePieces(target, pieces, null); };
      showNotice(target, `${describeError(error)} Your recording is kept, so you can try again.`, retry);
    } finally {
      window.clearInterval(progress);
      if (abortRef.current === controller) abortRef.current = null;
    }
  }, [deliver, showNotice, transcribePiece]);

  const finish = useCallback(async () => {
    const current = phaseRef.current;
    const recording = recordingRef.current;
    const pieces = piecesRef.current;
    if (current.kind !== "recording" || !recording || !pieces) return;
    recordingRef.current = null;
    piecesRef.current = null;
    keyPressRef.current = null;
    spaceHoldRef.current = null;
    const live = liveRef.current;
    liveRef.current = null;
    if (Date.now() - current.startedAt < SHORTEST_RECORDING_MS) {
      if (live) { live.ended = true; live.transcription?.close(); live.preview?.discard(); endCharge(live); }
      recording.cancel();
      setPhase({ kind: "idle" });
      return;
    }
    const { target } = current;
    setPhase({ kind: "transcribing", target });
    try {
      // The live session's final text, when it ran start to finish; otherwise the pieces are transcribed.
      let text: string | null = null;
      const transcription = live && !live.ended ? live.transcription : null;
      if (live) {
        live.ended = true;
        window.clearInterval(live.renewTimer);
        text = transcription ? await transcription.finish() : null;
        endCharge(live);
      }
      const last = await recording.stop();
      if (last.size) pieces.audio.push(last);
      setLiveText("");
      if ((phaseRef.current as Phase).kind !== "transcribing") { live?.preview?.discard(); return; }
      if (text !== null) {
        if (!text.trim()) {
          live?.preview?.discard();
          showNotice(target, "Didn't catch anything. Try again a little closer to the mic.");
          return;
        }
        deliver(target, text, live?.preview ?? null);
        return;
      }
      if (!pieces.audio.length) {
        live?.preview?.discard();
        showNotice(target, "Didn't catch anything. Try again a little closer to the mic.");
        return;
      }
      await transcribePieces(target, pieces, live?.preview ?? null);
    } catch (error) {
      if ((phaseRef.current as Phase).kind !== "transcribing") return;
      live?.preview?.discard();
      showNotice(target, describeError(error));
    }
  }, [deliver, endCharge, showNotice, transcribePieces]);

  const cancel = useCallback(() => {
    const live = liveRef.current;
    liveRef.current = null;
    if (live) {
      live.ended = true;
      live.transcription?.close();
      live.preview?.discard();
      endCharge(live);
    }
    setLiveText("");
    recordingRef.current?.cancel();
    recordingRef.current = null;
    piecesRef.current?.controller.abort();
    piecesRef.current = null;
    abortRef.current?.abort();
    abortRef.current = null;
    keyPressRef.current = null;
    spaceHoldRef.current = null;
    setPhase({ kind: "idle" });
  }, [endCharge]);

  const start = useCallback(async (target: HTMLElement) => {
    if (phaseRef.current.kind === "starting" || phaseRef.current.kind === "recording" || phaseRef.current.kind === "transcribing") return;
    setPhase({ kind: "starting", target });
    try {
      const pieces: Pieces = { audio: [], texts: [], batch: false, done: new Set(), controller: new AbortController(), hints: dictationHints(target) };
      const recording = await startDictationRecording({
        onLevel: setLevel,
        segmentMs,
        onSegment: (audio) => {
          pieces.audio.push(audio);
          if (pieces.batch) void transcribePiece(pieces, pieces.audio.length - 1).catch(() => undefined);
        },
      });
      // Esc or a second press while the microphone was opening.
      if ((phaseRef.current as Phase).kind !== "starting") { recording.cancel(); return; }
      recordingRef.current = recording;
      piecesRef.current = pieces;
      const live = beginLive(recording.stream, target, pieces.hints);
      liveRef.current = live;
      if (live.ended) switchToPieces(pieces);
      setPhase({ kind: "recording", target, startedAt: Date.now() });
    } catch (error) {
      keyPressRef.current = null;
      showNotice(target, describeError(error));
    }
  }, [beginLive, segmentMs, showNotice, switchToPieces, transcribePiece]);

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
        spaceHoldRef.current = null;
        cancel();
        return;
      }
      if (event.code === "Space" && !event.shiftKey && !event.metaKey && !event.ctrlKey && !event.altKey && !event.isComposing) {
        const hold = spaceHoldRef.current;
        if (!event.repeat) {
          // Space again after a held recording stopped short of its release: stop.
          if (hold?.started && kind === "recording") {
            event.preventDefault();
            event.stopPropagation();
            spaceHoldRef.current = null;
            void finish();
            return;
          }
          // A tap types its space as usual (or opens AI on an empty line); only a hold talks.
          const target = holdSpace && (kind === "idle" || kind === "notice") ? findDictationTarget(document.activeElement) : null;
          spaceHoldRef.current = target ? { target, repeats: 0, started: false } : null;
          return;
        }
        if (!hold) return;
        // Held: the key's repeats never type, like Claude Code's warm-up.
        event.preventDefault();
        event.stopPropagation();
        hold.repeats += 1;
        if (hold.started || hold.repeats < HOLD_SPACE_REPEATS) return;
        // Focus may have moved since the press, such as into the Ask AI box a Space on an empty line opens.
        const target = findDictationTarget(document.activeElement);
        if (!target) { spaceHoldRef.current = null; return; }
        if (target === hold.target) removeSpaceBeforeCursor(target);
        hold.started = true;
        void start(target);
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
      const hold = spaceHoldRef.current;
      if (hold && event.code === "Space") {
        // Letting go stops a held recording. One that's still opening the mic stops on the next Space.
        if (hold.started && phaseRef.current.kind === "recording") { spaceHoldRef.current = null; void finish(); }
        else if (!hold.started) spaceHoldRef.current = null;
        return;
      }
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
  }, [cancel, finish, holdSpace, start, supported, toggle]);

  // Mic buttons outside the field, like the document's, start and stop it here.
  useEffect(() => supported ? onDictationRequest(toggle) : undefined, [supported, toggle]);

  useEffect(() => {
    // Leaving the page mid-recording still ends a hosted session's charge.
    window.addEventListener("pagehide", cancel);
    return () => {
      window.removeEventListener("pagehide", cancel);
      cancel();
    };
  }, [cancel]);

  const activeTarget = phase.kind === "idle" ? null : phase.target;
  // Phones get the mic too: tap to start, tap the stop button to finish. Their keyboards never move a pointer, so typing doesn't hide it.
  const buttonTarget = showButton && (coarsePointer || !typing) && focused && !hasOwnDictationButton(focused) ? focused : null;
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

  const dock = activeTarget && slotFor(activeTarget) ? undefined : dockSlot?.parentElement?.getBoundingClientRect();
  const floating = dock
    // Recording on a phone shows just above the bottom row, so the row's buttons stay put.
    ? { right: Math.max(4, window.innerWidth - dock.right + 20), bottom: window.innerHeight - dock.top + 10 }
    : anchor
    ? { right: anchor.right, bottom: anchor.bottom }
    : { left: "50%", bottom: 24, transform: "translateX(-50%)" };

  if (phase.kind === "idle") {
    if (!buttonTarget) return null;
    if (dockSlot) return createPortal(
      <button aria-label="Voice typing" className="dictation-mic is-docked" data-dictation="off" onClick={() => toggle(buttonTarget)}
        onMouseDown={(event) => event.preventDefault()} onPointerDown={(event) => event.preventDefault()} title="Voice typing" type="button">
        <MicIcon size={24} />
      </button>,
      dockSlot,
    );
    if (!anchor) return null;
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
          {phase.retry ? <button className="dictation-pill-action" onClick={phase.retry} type="button">Try again</button> : null}
          <button aria-label="Dismiss" className="dictation-pill-button" onClick={() => setPhase({ kind: "idle" })} type="button">×</button>
        </>
      ) : phase.kind === "transcribing" ? (
        <>
          <span className="dictation-spinner" aria-hidden="true" />
          <span>{phase.total && phase.total > 1 ? `Transcribing ${Math.min(phase.done ?? 0, phase.total)} of ${phase.total}…` : "Transcribing…"}</span>
        </>
      ) : (
        <>
          <button aria-label="Stop and type what I said" className="dictation-pill-button is-stop" onClick={() => void finish()} title="Stop and type" type="button">
            <span className="dictation-level" style={{ transform: `scale(${1 + level * 0.9})` }} aria-hidden="true" />
            <span className="dictation-stop-square" aria-hidden="true" />
          </button>
          <span className="dictation-elapsed">{phase.kind === "recording" ? formatElapsed(Math.max(0, now - phase.startedAt)) : "Starting…"}</span>
          {liveText ? <span className="dictation-live-text">{liveText.length > 80 ? `…${liveText.slice(-80)}` : liveText}</span> : null}
          <button aria-label="Cancel voice typing" className="dictation-pill-button" onClick={cancel} title="Cancel (Esc)" type="button">×</button>
        </>
      )}
    </div>,
    document.body,
  );
}
