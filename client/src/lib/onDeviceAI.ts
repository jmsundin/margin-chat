/**
 * Chrome's built-in model (Gemini Nano through the Prompt API, `LanguageModel`).
 * It runs on the visitor's own computer, so guests can try AI without an account
 * and without anything reaching a paid provider. Chrome 148+ on Windows, macOS,
 * Linux and Chromebook Plus; not on phones yet.
 */

export type OnDeviceStatus =
  /** No Prompt API in this browser (Safari, Firefox, phones, older Chrome). */
  | "unsupported"
  /** The API exists but this computer can't run the model (memory, GPU, disk space). */
  | "unavailable"
  /** The model can be downloaded; Chrome needs a click to start it. */
  | "downloadable"
  | "downloading"
  | "available";

interface LanguageModelSession {
  promptStreaming(input: string, options?: { signal?: AbortSignal }): ReadableStream<string>;
  destroy(): void;
  contextWindow?: number;
  inputQuota?: number;
}

interface LanguageModelMonitor extends EventTarget {}

interface LanguageModelOptions {
  initialPrompts?: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  expectedInputs?: Array<{ type: "text"; languages: string[] }>;
  expectedOutputs?: Array<{ type: "text"; languages: string[] }>;
  monitor?: (monitor: LanguageModelMonitor) => void;
  signal?: AbortSignal;
}

export interface LanguageModelApi {
  availability(options?: LanguageModelOptions): Promise<string>;
  create(options?: LanguageModelOptions): Promise<LanguageModelSession>;
}

const TEXT_OPTIONS: LanguageModelOptions = {
  expectedInputs: [{ type: "text", languages: ["en"] }],
  expectedOutputs: [{ type: "text", languages: ["en"] }],
};

/** A small model's context is a few thousand tokens; this keeps a prompt and its answer inside it. */
export const ON_DEVICE_PROMPT_CHARACTERS = 12_000;

export const ON_DEVICE_SYSTEM_PROMPT = [
  "You are the writing assistant inside Margin Chat, a workspace of linked documents.",
  "Answer clearly and concretely in Markdown. Keep answers short unless asked for more.",
  "When asked to write into a document, return only the text to insert, with no preamble.",
].join(" ");

export function languageModelApi(scope: unknown = globalThis): LanguageModelApi | null {
  const api = (scope as { LanguageModel?: unknown }).LanguageModel;
  return api && typeof (api as LanguageModelApi).availability === "function" && typeof (api as LanguageModelApi).create === "function"
    ? api as LanguageModelApi : null;
}

export async function onDeviceStatus(api = languageModelApi()): Promise<OnDeviceStatus> {
  if (!api) return "unsupported";
  try {
    const value = await api.availability(TEXT_OPTIONS);
    return value === "available" || value === "downloadable" || value === "downloading" ? value : "unavailable";
  } catch {
    return "unavailable";
  }
}

/** What a visitor sees when AI can't run here, with what would make it work. */
export function onDeviceUnavailableMessage(status: OnDeviceStatus) {
  return status === "unsupported"
    ? "AI in the free trial runs on your computer with Chrome’s built-in model, which this browser doesn’t have. Open this page in Chrome on a Windows, Mac, Linux or Chromebook Plus computer, or sign up to use AI anywhere."
    : "Chrome can’t run its built-in model on this computer (it needs about 16 GB of memory or a graphics card with more than 4 GB, and 22 GB of free disk space). Sign up to use AI anywhere.";
}

/** Shortens a long prompt from the middle, keeping its instructions and the request at the end. */
export function fitOnDevicePrompt(text: string, limit = ON_DEVICE_PROMPT_CHARACTERS) {
  if (text.length <= limit) return text;
  const head = Math.min(1_200, Math.floor(limit / 4));
  const marker = "\n\n[… part of the document was left out to fit the on-device model …]\n\n";
  return text.slice(0, head) + marker + text.slice(text.length - (limit - head - marker.length));
}

let session: Promise<LanguageModelSession> | null = null;
const progressListeners = new Set<(fraction: number) => void>();

/** Reports download progress (0 to 1) while Chrome fetches the model. */
export function onDownloadProgress(listener: (fraction: number) => void) {
  progressListeners.add(listener);
  return () => { progressListeners.delete(listener); };
}

/**
 * The shared session, created on first use. Starting the download needs a click
 * (user activation), so call this from a click handler when the model isn't on disk yet.
 */
export function onDeviceSession(api = languageModelApi()): Promise<LanguageModelSession> {
  if (!api) return Promise.reject(new Error(onDeviceUnavailableMessage("unsupported")));
  session ??= api.create({
    ...TEXT_OPTIONS,
    initialPrompts: [{ role: "system", content: ON_DEVICE_SYSTEM_PROMPT }],
    monitor(monitor) {
      monitor.addEventListener("downloadprogress", (event) => {
        const loaded = (event as Event & { loaded?: number }).loaded;
        if (typeof loaded === "number") for (const listener of progressListeners) listener(loaded);
      });
    },
  }).catch((error) => {
    session = null;
    throw error;
  });
  return session;
}

/** Each prompt runs on its own copy of the session, so earlier answers don't fill the small context. */
export async function* streamOnDevice(prompt: string, { signal, api = languageModelApi() }: { signal?: AbortSignal; api?: LanguageModelApi | null } = {}): AsyncGenerator<string> {
  const base = await onDeviceSession(api);
  const clone = (base as LanguageModelSession & { clone?: (options?: { signal?: AbortSignal }) => Promise<LanguageModelSession> }).clone;
  const run = typeof clone === "function" ? await clone.call(base, { signal }) : base;
  try {
    const reader = run.promptStreaming(fitOnDevicePrompt(prompt), { signal }).getReader();
    for (;;) {
      const { value, done } = await reader.read();
      if (done) break;
      if (value) yield value;
    }
  } finally {
    if (run !== base) run.destroy();
  }
}

export function resetOnDeviceSessionForTests() {
  session = null;
  progressListeners.clear();
}
