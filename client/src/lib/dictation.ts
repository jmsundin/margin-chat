import { EditorView } from "@codemirror/view";
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
  state: { selection: { from: number }; doc: { textBetween(from: number, to: number, block?: string, leaf?: string): string }; tr: { insertText(text: string): unknown } };
  view: { dispatch(transaction: unknown): void; focus(): void };
}

function findTiptap(target: HTMLElement): TiptapLike | null {
  for (let node: HTMLElement | null = target; node; node = node.parentElement) {
    const editor = (node as HTMLElement & { editor?: TiptapLike }).editor;
    if (editor?.view && editor.state) return editor.isDestroyed ? null : editor;
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
  const tiptap = findTiptap(target);
  if (tiptap) {
    const { from } = tiptap.state.selection;
    const insert = joinDictation(tiptap.state.doc.textBetween(Math.max(0, from - 1), from, "\n", " "), text);
    if (insert) tiptap.view.dispatch(tiptap.state.tr.insertText(insert));
    tiptap.view.focus();
    return true;
  }
  const codeMirrorRoot = target.closest<HTMLElement>(".cm-editor");
  const codeMirror = codeMirrorRoot ? EditorView.findFromDOM(codeMirrorRoot) : null;
  if (codeMirror) {
    const { from } = codeMirror.state.selection.main;
    const insert = joinDictation(codeMirror.state.sliceDoc(Math.max(0, from - 1), from), text);
    if (insert) codeMirror.dispatch(codeMirror.state.replaceSelection(insert), { scrollIntoView: true });
    codeMirror.focus();
    return true;
  }
  if (target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement) {
    const start = target.selectionStart ?? target.value.length;
    const end = target.selectionEnd ?? start;
    const insert = joinDictation(target.value.slice(Math.max(0, start - 1), start), text);
    target.focus();
    if (!insert) return true;
    target.setSelectionRange(start, end);
    // insertText keeps the browser's undo stack. The fallback sets the value
    // through the prototype so React's change tracking still sees an edit.
    if (!document.execCommand?.("insertText", false, insert)) {
      const value = target.value.slice(0, start) + insert + target.value.slice(end);
      Object.getOwnPropertyDescriptor(Object.getPrototypeOf(target), "value")?.set?.call(target, value);
      target.setSelectionRange(start + insert.length, start + insert.length);
      target.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: insert }));
    }
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

export interface DictationRecording {
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
