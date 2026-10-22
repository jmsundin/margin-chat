import { isolateHistory } from "@codemirror/commands";
import { Transaction as CodeMirrorTransaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { closeHistory } from "@tiptap/pm/history";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { isApplePlatform } from "./workspaceViewShortcuts";

/**
 * Recordings have no length limit. They're kept as pieces of a few minutes
 * each, so every piece stays under the server's 4 MB upload limit.
 */
export const SEGMENT_MS = 4 * 60 * 1000;
export const MAX_SEGMENT_BYTES = 3_500_000;
const RECORDING_TYPES = ["audio/webm;codecs=opus", "audio/webm", "audio/mp4", "audio/ogg;codecs=opus"];
const TEXT_INPUT_TYPES = new Set(["text", "search", "url"]);

export function dictationSupported(): boolean {
  return typeof window !== "undefined" && typeof MediaRecorder !== "undefined" &&
    typeof navigator.mediaDevices?.getUserMedia === "function";
}

export const dictationShortcutLabel = (apple = isApplePlatform()) => apple ? "⌘⇧Space" : "Ctrl+Shift+Space";

/** ⌘⇧Space on a Mac, Ctrl+Shift+Space elsewhere. */
export function isDictationShortcut(event: Pick<KeyboardEvent, "code" | "metaKey" | "ctrlKey" | "shiftKey" | "altKey">, apple = isApplePlatform()): boolean {
  return event.code === "Space" && event.shiftKey && !event.altKey && (apple ? event.metaKey && !event.ctrlKey : event.ctrlKey && !event.metaKey);
}

/** The text field that dictation would type into, or null for anything else. */
export function findDictationTarget(element: Element | null): HTMLElement | null {
  if (!(element instanceof HTMLElement) || element.closest("[data-dictation='off']")) return null;
  if (element instanceof HTMLTextAreaElement) return element.readOnly || element.disabled ? null : element;
  if (element instanceof HTMLInputElement) {
    return TEXT_INPUT_TYPES.has(element.type) && !element.readOnly && !element.disabled ? element : null;
  }
  if (!element.isContentEditable) return null;
  let root = element;
  while (root.parentElement?.isContentEditable) root = root.parentElement;
  return root;
}

/** Puts a space between the transcript and a word right before the cursor. */
export function joinDictation(before: string, text: string): string {
  const trimmed = text.trim();
  if (!trimmed) return "";
  return before && !/\s/u.test(before) && !/^[.,!?;:)\]}'"…]/u.test(trimmed) ? ` ${trimmed}` : trimmed;
}

interface TiptapLike {
  isDestroyed?: boolean;
  state: { selection: { to: number }; doc: ProseMirrorNode; tr: Transaction };
  view: { dispatch(transaction: Transaction): void; focus(): void };
}

function findTiptap(target: HTMLElement): TiptapLike | null {
  for (let node: HTMLElement | null = target; node; node = node.parentElement) {
    const editor = (node as HTMLElement & { editor?: TiptapLike }).editor;
    if (editor?.view && editor.state) return editor.isDestroyed ? null : editor;
  }
  return null;
}

/** A field's own editor, seen as positions to read and replace plain text at. */
interface TextSurface {
  caret(): number;
  read(from: number, to: number): string;
  /**
   * Replaces text and puts the cursor after it, returning the text as the
   * field stored it. Without `history`, undo never sees it.
   */
  replace(from: number, to: number, text: string, history: boolean): string;
  focus(): void;
}

function setNativeValue(target: HTMLInputElement | HTMLTextAreaElement, value: string, caret: number, data: string) {
  // Through the prototype, so React's change tracking still sees an edit.
  Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), "value")?.set?.call(target, value);
  target.setSelectionRange(caret, caret);
  target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data }));
}

function surfaceFor(target: HTMLElement): TextSurface | null {
  const tiptap = findTiptap(target);
  if (tiptap) {
    return {
      caret: () => tiptap.state.selection.to,
      read: (from, to) => tiptap.state.doc.textBetween(from, to, "\n", " "),
      replace(from, to, text, history) {
        const plain = text.replace(/\s+/gu, " ");
        const tr = tiptap.state.tr;
        if (plain) tr.insertText(plain, from, to);
        else tr.delete(from, to);
        tr.setSelection(TextSelection.create(tr.doc, from + plain.length));
        tr.setMeta("addToHistory", history);
        // Its own undo step, even right after typing or another dictation edit.
        if (history) closeHistory(tr);
        tiptap.view.dispatch(tr.scrollIntoView());
        return plain;
      },
      focus: () => tiptap.view.focus(),
    };
  }
  const codeMirrorRoot = target.closest<HTMLElement>(".cm-editor");
  const codeMirror = codeMirrorRoot ? EditorView.findFromDOM(codeMirrorRoot) : null;
  if (codeMirror) {
    return {
      caret: () => codeMirror.state.selection.main.to,
      read: (from, to) => codeMirror.state.sliceDoc(from, to),
      replace(from, to, text, history) {
        codeMirror.dispatch({
          changes: { from, to, insert: text }, selection: { anchor: from + text.length }, scrollIntoView: true,
          annotations: history ? isolateHistory.of("full") : CodeMirrorTransaction.addToHistory.of(false),
        });
        return text;
      },
      focus: () => codeMirror.focus(),
    };
  }
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return {
      caret: () => target.selectionEnd ?? target.value.length,
      read: (from, to) => target.value.slice(from, to),
      replace(from, to, value, history) {
        // One-line fields can't hold line breaks.
        const text = target instanceof HTMLInputElement ? value.replace(/\s+/gu, " ") : value;
        target.focus();
        target.setSelectionRange(from, to);
        // insertText keeps the browser's undo stack; previews skip it.
        if (history && text && document.execCommand?.("insertText", false, text)) return text;
        setNativeValue(target, target.value.slice(0, from) + text + target.value.slice(to), from + text.length, text);
        return text;
      },
      focus: () => target.focus(),
    };
  }
  return null;
}

/**
 * Takes back the space a held Space key typed before it turned into
 * push-to-talk. Leaves anything else alone, such as a space an editor
 * already turned into a list bullet.
 */
export function removeSpaceBeforeCursor(target: HTMLElement): void {
  if (!target.isConnected) return;
  const surface = surfaceFor(target);
  if (surface) {
    const at = surface.caret();
    if (at > 0 && surface.read(at - 1, at) === " ") surface.replace(at - 1, at, "", false);
    return;
  }
  const selection = window.getSelection();
  const node = selection?.anchorNode;
  if (node?.nodeType === Node.TEXT_NODE && selection?.isCollapsed && /\s/u.test((node.textContent ?? "").charAt(selection.anchorOffset - 1))) {
    document.execCommand?.("delete");
  }
}

/** Words that help the speech model spell names right, like Claude Code's project and branch hints. */
export interface DictationHints {
  /** What's already written just before the cursor, so the transcript continues it. */
  prompt: string;
  /** Names worth recognizing, such as the open document's title. */
  keywords: string[];
}

export const HINT_PROMPT_CHARS = 400;

export function dictationHints(target: HTMLElement): DictationHints {
  let prompt = "";
  try {
    const surface = surfaceFor(target);
    if (surface) {
      const at = surface.caret();
      prompt = surface.read(Math.max(0, at - HINT_PROMPT_CHARS), at);
    }
  } catch { prompt = ""; }
  const title = document.querySelector<HTMLTextAreaElement>(".document-title-input")?.value.trim() ?? "";
  const keywords = title && !/^untitled/iu.test(title) ? [title.slice(0, 80)] : [];
  return { prompt: prompt.replace(/\s+/gu, " ").trim().slice(-HINT_PROMPT_CHARS), keywords };
}

/** Typed dictation that can be swapped for another version of itself. */
export interface DictationInsertion {
  /** Whether the typed text is still where it was put, unchanged. */
  intact(): boolean;
  /** Replaces the typed text as one undoable edit. False when it was edited or the field closed. */
  swap(text: string): boolean;
}

function trackInsertion(target: HTMLElement, surface: TextSurface, at: number, before: string, typed: string): DictationInsertion {
  let shown = typed;
  const intact = () => target.isConnected && surface.read(at, at + shown.length) === shown;
  return {
    intact,
    swap(text) {
      if (!intact()) return false;
      shown = surface.replace(at, at + shown.length, joinDictation(before, text), true);
      surface.focus();
      return true;
    },
  };
}

/**
 * Types the transcript where the cursor is, through the editor that owns the
 * field so its undo history and change handlers see an ordinary edit. Returns
 * null when the field is gone, so the caller can offer the text another way.
 */
export function insertDictation(target: HTMLElement, text: string): DictationInsertion | null {
  if (!target.isConnected) return null;
  const surface = surfaceFor(target);
  if (surface) {
    const at = surface.caret();
    const before = surface.read(Math.max(0, at - 1), at);
    const insert = joinDictation(before, text);
    const typed = insert ? surface.replace(at, at, insert, true) : "";
    surface.focus();
    return trackInsertion(target, surface, at, before, typed);
  }
  target.focus();
  const selection = window.getSelection();
  const node = selection?.anchorNode;
  const before = node?.nodeType === Node.TEXT_NODE && selection ? (node.textContent ?? "").slice(Math.max(0, selection.anchorOffset - 1), selection.anchorOffset) : "";
  const insert = joinDictation(before, text);
  if (insert && !document.execCommand?.("insertText", false, insert)) return null;
  // Plain editable elements can't be tracked, so their text can't be swapped.
  return { intact: () => false, swap: () => false };
}

/** Words shown in the field while the person is still talking. */
export interface DictationPreview {
  update(text: string): void;
  /** Swaps the preview for the final transcript as one undoable edit. */
  commit(text: string): DictationInsertion | null;
  discard(): void;
}

/**
 * Shows live words at the cursor, outside undo history, and replaces them with
 * the final transcript. If the person edits over the preview, it stops
 * updating and the final text goes in at the cursor instead. Returns null for
 * fields it cannot preview in, such as plain contenteditable elements.
 */
export function startDictationPreview(target: HTMLElement): DictationPreview | null {
  const surface = surfaceFor(target);
  if (!surface) return null;
  const at = surface.caret();
  const before = surface.read(Math.max(0, at - 1), at);
  let shown = "";
  let lost = false;
  const intact = () => !lost && target.isConnected && surface.read(at, at + shown.length) === shown;
  return {
    update(text) {
      if (!intact()) { lost = true; return; }
      const next = joinDictation(before, text);
      if (next === shown) return;
      shown = surface.replace(at, at + shown.length, next, false);
    },
    commit(text) {
      if (!target.isConnected) return null;
      if (!intact()) return insertDictation(target, text);
      if (shown) surface.replace(at, at + shown.length, "", false);
      shown = "";
      const insert = joinDictation(before, text);
      const typed = insert ? surface.replace(at, at, insert, true) : "";
      surface.focus();
      return trackInsertion(target, surface, at, before, typed);
    },
    discard() {
      if (shown && intact()) surface.replace(at, at + shown.length, "", false);
      shown = "";
      lost = true;
    },
  };
}

export interface DictationRecording {
  /** The microphone, for streaming it while it records. */
  stream: MediaStream;
  /** Ends the recording and resolves with its last piece of audio, after every earlier piece went to `onSegment`. */
  stop(): Promise<Blob>;
  /** Ends the recording and throws its audio away. */
  cancel(): void;
}

function pickRecordingType(): string | undefined {
  return RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported?.(type));
}

/**
 * Records the microphone for as long as the person talks. `onLevel` gets a
 * 0–1 loudness for the meter. Every few minutes the recording starts a new
 * piece, each a complete audio file, and hands the finished one to `onSegment`.
 */
export async function startDictationRecording(options: {
  onLevel?: (level: number) => void;
  onSegment?: (audio: Blob) => void;
  segmentMs?: number;
} = {}): Promise<DictationRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const mimeType = pickRecordingType();
  let cancelled = false;

  // One piece of the recording: its own recorder, so its audio plays on its own.
  const record = () => {
    const recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32_000 });
    const chunks: Blob[] = [];
    let size = 0;
    recorder.addEventListener("dataavailable", (event) => {
      if (!event.data.size) return;
      chunks.push(event.data);
      size += event.data.size;
      if (size >= MAX_SEGMENT_BYTES && current?.recorder === recorder) rotate();
    });
    const finished = new Promise<Blob>((resolve, reject) => {
      recorder.addEventListener("stop", () => resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" })), { once: true });
      recorder.addEventListener("error", () => reject(new Error("The recording stopped unexpectedly.")), { once: true });
    });
    recorder.start(1000);
    return { recorder, finished };
  };
  let current: ReturnType<typeof record> | null = null;
  // Earlier pieces reach `onSegment` in order, before `stop` resolves.
  let delivered: Promise<void> = Promise.resolve();
  const rotate = () => {
    const previous = current;
    // The next piece starts before the last one stops, so no words fall between them.
    current = record();
    if (!previous) return;
    delivered = delivered.then(() => previous.finished).then((audio) => {
      if (!cancelled && audio.size) options.onSegment?.(audio);
    }, () => undefined);
    if (previous.recorder.state !== "inactive") previous.recorder.stop();
  };
  try {
    rotate();
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
  const timer = window.setInterval(rotate, options.segmentMs ?? SEGMENT_MS);

  let audioContext: AudioContext | null = null;
  let frame = 0;
  if (options.onLevel && typeof AudioContext !== "undefined") {
    try {
      audioContext = new AudioContext();
      const analyser = audioContext.createAnalyser();
      analyser.fftSize = 512;
      audioContext.createMediaStreamSource(stream).connect(analyser);
      const samples = new Uint8Array(analyser.fftSize);
      const measure = () => {
        analyser.getByteTimeDomainData(samples);
        let sum = 0;
        for (const sample of samples) sum += ((sample - 128) / 128) ** 2;
        options.onLevel?.(Math.min(1, Math.sqrt(sum / samples.length) * 4));
        frame = requestAnimationFrame(measure);
      };
      measure();
    } catch { audioContext = null; }
  }

  const release = () => {
    window.clearInterval(timer);
    cancelAnimationFrame(frame);
    void audioContext?.close().catch(() => undefined);
    stream.getTracks().forEach((track) => track.stop());
  };

  return {
    stream,
    async stop() {
      window.clearInterval(timer);
      const last = current!;
      if (last.recorder.state !== "inactive") last.recorder.stop();
      try {
        const audio = await last.finished;
        await delivered;
        return audio;
      } finally {
        release();
      }
    },
    cancel() {
      cancelled = true;
      if (current && current.recorder.state !== "inactive") current.recorder.stop();
      release();
    },
  };
}

const BUTTON_PREFERENCE_KEY = "margin-chat:dictation-button";
const HOLD_SPACE_PREFERENCE_KEY = "margin-chat:dictation-hold-space";
const preferenceListeners = new Set<() => void>();

/** Whether the mic button shows in text fields. The shortcut always works. */
export function readDictationButtonPreference(): boolean {
  try { return localStorage.getItem(BUTTON_PREFERENCE_KEY) !== "off"; }
  catch { return true; }
}

export function saveDictationButtonPreference(show: boolean) {
  try { localStorage.setItem(BUTTON_PREFERENCE_KEY, show ? "on" : "off"); }
  catch { /* Private windows keep the default. */ }
  preferenceListeners.forEach((listener) => listener());
}

export function subscribeDictationButtonPreference(listener: () => void): () => void {
  preferenceListeners.add(listener);
  return () => preferenceListeners.delete(listener);
}

const REQUEST_EVENT = "margin-chat:dictation-request";

/**
 * Starts voice typing into a field, or stops the recording that is running.
 * For mic buttons that live outside the field, like the one beside Ask AI.
 */
export function requestDictation(target: HTMLElement) {
  window.dispatchEvent(new CustomEvent<HTMLElement>(REQUEST_EVENT, { detail: target }));
}

export function onDictationRequest(listener: (target: HTMLElement) => void): () => void {
  const handle = (event: Event) => { if ((event as CustomEvent<unknown>).detail instanceof HTMLElement) listener((event as CustomEvent<HTMLElement>).detail); };
  window.addEventListener(REQUEST_EVENT, handle);
  return () => window.removeEventListener(REQUEST_EVENT, handle);
}

/** Fields whose own mic sits elsewhere (the document's caret row and corner) don't get the floating one. */
export const hasOwnDictationButton = (target: HTMLElement) => Boolean(target.closest("[data-dictation-button='own']"));

/** Whether holding Space in a text field talks, like Claude Code. A quick tap still types a space. */
export function readHoldSpacePreference(): boolean {
  try { return localStorage.getItem(HOLD_SPACE_PREFERENCE_KEY) !== "off"; }
  catch { return true; }
}

export function saveHoldSpacePreference(on: boolean) {
  try { localStorage.setItem(HOLD_SPACE_PREFERENCE_KEY, on ? "on" : "off"); }
  catch { /* Private windows keep the default. */ }
  preferenceListeners.forEach((listener) => listener());
}
