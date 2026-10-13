import { Transaction as CodeMirrorTransaction } from "@codemirror/state";
import { EditorView } from "@codemirror/view";
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";
import { TextSelection, type Transaction } from "@tiptap/pm/state";
import { isApplePlatform } from "./workspaceViewShortcuts";

/** Recordings stop on their own before they outgrow the server's 4 MB limit. */
export const MAX_RECORDING_MS = 10 * 60 * 1000;
export const MAX_RECORDING_BYTES = 3_800_000;
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
  /** Replaces text and puts the cursor after it. Without `history`, undo never sees it. */
  replace(from: number, to: number, text: string, history: boolean): void;
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
        tiptap.view.dispatch(tr.scrollIntoView());
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
          ...(history ? {} : { annotations: CodeMirrorTransaction.addToHistory.of(false) }),
        });
      },
      focus: () => codeMirror.focus(),
    };
  }
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    return {
      caret: () => target.selectionEnd ?? target.value.length,
      read: (from, to) => target.value.slice(from, to),
      replace(from, to, text, history) {
        target.focus();
        target.setSelectionRange(from, to);
        // insertText keeps the browser's undo stack; previews skip it.
        if (history && text && document.execCommand?.("insertText", false, text)) return;
        setNativeValue(target, target.value.slice(0, from) + text + target.value.slice(to), from + text.length, text);
      },
      focus: () => target.focus(),
    };
  }
  return null;
}

/**
 * Types the transcript where the cursor is, through the editor that owns the
 * field so its undo history and change handlers see an ordinary edit. Returns
 * false when the field is gone, so the caller can offer the text another way.
 */
export function insertDictation(target: HTMLElement, text: string): boolean {
  if (!target.isConnected) return false;
  const surface = surfaceFor(target);
  if (surface) {
    const at = surface.caret();
    const insert = joinDictation(surface.read(Math.max(0, at - 1), at), text);
    if (insert) surface.replace(at, at, insert, true);
    surface.focus();
    return true;
  }
  target.focus();
  const selection = window.getSelection();
  const node = selection?.anchorNode;
  const before = node?.nodeType === Node.TEXT_NODE && selection ? (node.textContent ?? "").slice(Math.max(0, selection.anchorOffset - 1), selection.anchorOffset) : "";
  const insert = joinDictation(before, text);
  if (insert && !document.execCommand?.("insertText", false, insert)) return false;
  return true;
}

/** Words shown in the field while the person is still talking. */
export interface DictationPreview {
  update(text: string): void;
  /** Swaps the preview for the final transcript as one undoable edit. */
  commit(text: string): boolean;
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
      surface.replace(at, at + shown.length, next, false);
      shown = next;
    },
    commit(text) {
      if (!target.isConnected) return false;
      if (!intact()) return insertDictation(target, text);
      if (shown) surface.replace(at, at + shown.length, "", false);
      shown = "";
      const insert = joinDictation(before, text);
      if (insert) surface.replace(at, at, insert, true);
      surface.focus();
      return true;
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
  /** Ends the recording and resolves with its audio. */
  stop(): Promise<Blob>;
  /** Ends the recording and throws its audio away. */
  cancel(): void;
}

function pickRecordingType(): string | undefined {
  return RECORDING_TYPES.find((type) => MediaRecorder.isTypeSupported?.(type));
}

/**
 * Records the microphone. `onLevel` gets a 0–1 loudness for the meter, and
 * `onLimit` fires when the recording reaches its length or size limit.
 */
export async function startDictationRecording(options: { onLevel?: (level: number) => void; onLimit?: () => void } = {}): Promise<DictationRecording> {
  const stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
  const mimeType = pickRecordingType();
  let recorder: MediaRecorder;
  try {
    recorder = new MediaRecorder(stream, { ...(mimeType ? { mimeType } : {}), audioBitsPerSecond: 32_000 });
  } catch (error) {
    stream.getTracks().forEach((track) => track.stop());
    throw error;
  }
  const chunks: Blob[] = [];
  let size = 0;
  let limited = false;
  const reachLimit = () => { if (!limited) { limited = true; options.onLimit?.(); } };
  recorder.addEventListener("dataavailable", (event) => {
    if (!event.data.size) return;
    chunks.push(event.data);
    size += event.data.size;
    if (size >= MAX_RECORDING_BYTES) reachLimit();
  });
  const timer = window.setTimeout(reachLimit, MAX_RECORDING_MS);

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
    window.clearTimeout(timer);
    cancelAnimationFrame(frame);
    void audioContext?.close().catch(() => undefined);
    stream.getTracks().forEach((track) => track.stop());
  };
  recorder.start(1000);

  return {
    stream,
    stop: () => new Promise<Blob>((resolve, reject) => {
      if (recorder.state === "inactive") { release(); resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" })); return; }
      recorder.addEventListener("stop", () => {
        release();
        resolve(new Blob(chunks, { type: recorder.mimeType || mimeType || "audio/webm" }));
      }, { once: true });
      recorder.addEventListener("error", () => { release(); reject(new Error("The recording stopped unexpectedly.")); }, { once: true });
      recorder.stop();
    }),
    cancel: () => {
      if (recorder.state !== "inactive") recorder.stop();
      release();
    },
  };
}

const BUTTON_PREFERENCE_KEY = "margin-chat:dictation-button";
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
