import { JAVASCRIPT_WORKER, JAVA_FILE_SHIM, PYTHON_WORKER, SQL_WORKER } from "./workers";
import { javaProgram, type CodeLanguage } from "./languages";

/**
 * Runs code cells. Code never runs in the app's page: a hidden frame with a
 * sandbox and no origin of its own starts one worker per language, so a cell
 * can't read the app's data or cookies, and an endless loop only stalls its
 * worker, which is ended after a time limit.
 */

declare const __CODE_RUNNER_ASSETS__: { sqlGlue: string; sqlWasm: string; typescript: string; javaWorker: string; javaFiles: string };

const PYODIDE_URL = "https://cdn.jsdelivr.net/pyodide/v0.29.3/full/";
type Runtime = "javascript" | "sql" | "python" | "java";
const RUNTIME: Record<Exclude<CodeLanguage, "html" | "css">, Runtime> = { javascript: "javascript", typescript: "javascript", sql: "sql", python: "python", java: "java" };
/** Seconds a run may take once its language is loaded. */
const TIME_LIMIT_S: Record<Runtime, number> = { javascript: 10, sql: 10, python: 20, java: 20 };

export type RunEvent =
  | { type: "status"; text: string }
  | { type: "out"; stream: "stdout" | "stderr"; text: string }
  | { type: "table"; columns: string[]; rows: unknown[][]; note: string };

export interface RunResult { ok: boolean; error?: string; stopped?: boolean; ms: number }

interface WorkerMessage { type: string; id?: string; [key: string]: unknown }

let frame: HTMLIFrameElement | null = null;
let frameReady: Promise<HTMLIFrameElement> | null = null;
const listeners = new Map<Runtime, (message: WorkerMessage) => void>();
const ready = new Map<Runtime, Promise<void>>();
/** One run at a time per language; a run waits for the one before it. */
const queue = new Map<Runtime, Promise<unknown>>();
let typescriptLoaded: Promise<void> | null = null;
let runCount = 0;

const HOST = `<!doctype html><meta charset="utf-8"><script>
const workers = new Map();
addEventListener("message", (event) => {
  if (event.source !== parent) return;
  const message = event.data || {};
  if (message.type === "start") {
    workers.get(message.runtime)?.terminate();
    try {
      const worker = new Worker(URL.createObjectURL(new Blob([message.source], { type: "text/javascript" })));
      worker.onmessage = (inner) => parent.postMessage({ runtime: message.runtime, message: inner.data }, "*");
      worker.onerror = (inner) => { inner.preventDefault(); parent.postMessage({ runtime: message.runtime, message: { type: "crashed", error: inner.message || "The runner stopped." } }, "*"); };
      workers.set(message.runtime, worker);
    } catch (error) {
      parent.postMessage({ runtime: message.runtime, message: { type: "failed", error: String(error && error.message || error) } }, "*");
    }
  } else if (message.type === "send") {
    workers.get(message.runtime)?.postMessage(message.message, message.transfer || []);
  } else if (message.type === "stop") {
    workers.get(message.runtime)?.terminate();
    workers.delete(message.runtime);
  }
});
parent.postMessage({ type: "host-ready" }, "*");
<\/script>`;

function hostFrame() {
  if (frameReady && frame?.isConnected) return frameReady;
  frame?.remove();
  const element = document.createElement("iframe");
  element.sandbox.add("allow-scripts");
  element.setAttribute("aria-hidden", "true");
  element.tabIndex = -1;
  element.title = "Code runner";
  element.style.cssText = "position:fixed;width:0;height:0;border:0;opacity:0;pointer-events:none;left:-10px;top:-10px";
  frame = element;
  ready.clear();
  frameReady = new Promise((resolve) => {
    const onMessage = (event: MessageEvent) => {
      if (event.source !== element.contentWindow) return;
      const data = event.data as { type?: string; runtime?: Runtime; message?: WorkerMessage };
      if (data?.type === "host-ready") { resolve(element); return; }
      if (data?.runtime && data.message) listeners.get(data.runtime)?.(data.message);
    };
    window.addEventListener("message", onMessage);
  });
  element.srcdoc = HOST;
  document.body.appendChild(element);
  return frameReady;
}

function post(runtime: Runtime, message: unknown, transfer: Transferable[] = []) {
  frame?.contentWindow?.postMessage({ type: "send", runtime, message, transfer }, "*", transfer);
}

function stopRuntime(runtime: Runtime) {
  frame?.contentWindow?.postMessage({ type: "stop", runtime }, "*");
  ready.delete(runtime);
  if (runtime === "javascript") typescriptLoaded = null;
}

async function fetchText(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Couldn't download ${url.split("/").pop()} (${response.status}).`);
  return response.text();
}
async function fetchBytes(url: string) {
  const response = await fetch(url);
  if (!response.ok) throw new Error(`Couldn't download ${url.split("/").pop()} (${response.status}).`);
  return response.arrayBuffer();
}

/** Waits for one message from a runtime's worker that `accept` returns a value for. */
function nextMessage<T>(runtime: Runtime, accept: (message: WorkerMessage) => T | undefined): Promise<T> {
  return new Promise((resolve, reject) => {
    listeners.set(runtime, (message) => {
      if (message.type === "failed" || message.type === "crashed" || message.type === "init-error") { reject(new Error(String(message.error ?? "The runner failed to start."))); return; }
      const value = accept(message);
      if (value !== undefined) resolve(value);
    });
  });
}

function startRuntime(runtime: Runtime, status: (text: string) => void): Promise<void> {
  const existing = ready.get(runtime);
  if (existing) return existing;
  const starting = (async () => {
    const host = await hostFrame();
    const assets = __CODE_RUNNER_ASSETS__;
    if (runtime === "java") {
      status("Loading Java (about 8 MB the first time)…");
      const [worker, compiler, deobfuscator, compileLib, runtimeLib] = await Promise.all([
        fetchText(assets.javaWorker), fetchBytes(`${assets.javaFiles}compiler.wasm`), fetchBytes(`${assets.javaFiles}compiler.wasm-deobfuscator.wasm`),
        fetchBytes(`${assets.javaFiles}compile-classlib-teavm.bin`), fetchBytes(`${assets.javaFiles}runtime-classlib-teavm.bin`),
      ]);
      const loaded = nextMessage(runtime, (message) => message.type === "initialized" ? true : undefined);
      host.contentWindow?.postMessage({ type: "start", runtime, source: JAVA_FILE_SHIM + worker }, "*");
      post(runtime, { type: "java-files", files: { "compiler.wasm": compiler, "compiler.wasm-deobfuscator.wasm": deobfuscator, "compile-classlib-teavm.bin": compileLib, "runtime-classlib-teavm.bin": runtimeLib } }, [compiler, deobfuscator, compileLib, runtimeLib]);
      status("Starting the Java compiler…");
      post(runtime, { cmd: "init", baseUrl: "https://code-runner.invalid/teavm/", persistFiles: false });
      await loaded;
      return;
    }
    const source = runtime === "javascript" ? JAVASCRIPT_WORKER : runtime === "sql" ? SQL_WORKER : PYTHON_WORKER;
    const loaded = nextMessage(runtime, (message) => message.type === "loaded" ? true : undefined);
    host.contentWindow?.postMessage({ type: "start", runtime, source }, "*");
    await loaded;
    if (runtime === "sql") {
      status("Loading SQLite…");
      const [glue, wasm] = await Promise.all([fetchText(assets.sqlGlue), fetchBytes(assets.sqlWasm)]);
      const initialized = nextMessage(runtime, (message) => message.type === "ready" ? true : undefined);
      post(runtime, { type: "init", glue, wasm }, [wasm]);
      await initialized;
    } else if (runtime === "python") {
      status("Loading Python (about 10 MB the first time)…");
      const initialized = nextMessage(runtime, (message) => message.type === "ready" ? true : undefined);
      post(runtime, { type: "init", indexURL: PYODIDE_URL });
      await initialized;
    }
  })();
  ready.set(runtime, starting);
  starting.catch(() => { if (ready.get(runtime) === starting) stopRuntime(runtime); });
  return starting;
}

function loadTypescript(status: (text: string) => void) {
  if (typescriptLoaded) return typescriptLoaded;
  typescriptLoaded = (async () => {
    status("Loading TypeScript (about 3 MB the first time)…");
    const source = await fetchText(__CODE_RUNNER_ASSETS__.typescript);
    const loaded = nextMessage("javascript", (message) => message.type === "typescript-ready" ? true : message.type === "typescript-failed" ? Promise.reject(new Error(String(message.error))) as never : undefined);
    post("javascript", { type: "load-typescript", source });
    await loaded;
  })();
  typescriptLoaded.catch(() => { typescriptLoaded = null; });
  return typescriptLoaded;
}

export interface RunOptions {
  /** SQL run before the cell, so it sees the tables the cells above it made. */
  setup?: string[];
  onEvent: (event: RunEvent) => void;
  signal?: AbortSignal;
}

/** Runs one cell. Resolves when it finishes, fails, is stopped, or runs out of time. */
export function runCode(language: Exclude<CodeLanguage, "html" | "css">, code: string, options: RunOptions): Promise<RunResult> {
  const runtime = RUNTIME[language];
  const previous = queue.get(runtime) ?? Promise.resolve();
  const run = previous.catch(() => undefined).then(() => runNow(runtime, language, code, options));
  queue.set(runtime, run);
  return run;
}

async function runNow(runtime: Runtime, language: CodeLanguage, code: string, { setup = [], onEvent, signal }: RunOptions): Promise<RunResult> {
  const started = performance.now();
  const status = (text: string) => onEvent({ type: "status", text });
  if (signal?.aborted) return { ok: false, stopped: true, ms: 0 };
  try {
    const loading = (async () => {
      await startRuntime(runtime, status);
      if (language === "typescript") await loadTypescript(status);
    })();
    await abortable(loading, signal);
  } catch (error) {
    if (signal?.aborted) return { ok: false, stopped: true, ms: performance.now() - started };
    return { ok: false, error: error instanceof Error ? error.message : String(error), ms: performance.now() - started };
  }
  status("Running…");
  const id = `run-${++runCount}`;
  const began = performance.now();
  return new Promise<RunResult>((resolve) => {
    let settled = false;
    const finish = (result: Omit<RunResult, "ms">) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      listeners.delete(runtime);
      resolve({ ...result, ms: performance.now() - began });
    };
    const onAbort = () => { stopRuntime(runtime); finish({ ok: false, stopped: true }); };
    const timer = setTimeout(() => {
      stopRuntime(runtime);
      finish({ ok: false, error: `Stopped after ${TIME_LIMIT_S[runtime]} seconds. Is there an endless loop?` });
    }, TIME_LIMIT_S[runtime] * 1000);
    signal?.addEventListener("abort", onAbort, { once: true });
    listeners.set(runtime, (message) => {
      if (message.type === "crashed" || message.type === "failed") { stopRuntime(runtime); finish({ ok: false, error: String(message.error) }); return; }
      if (runtime === "java") {
        if (message.type === "progress") { if (message.stage === "compile") status("Compiling…"); return; }
        if (message.type !== "result") return;
        const stdout = String(message.stdout ?? "");
        const stderr = String(message.stderr ?? message.error ?? "");
        if (stdout) onEvent({ type: "out", stream: "stdout", text: stdout.replace(/\n$/u, "") });
        if (message.ok) { if (stderr) onEvent({ type: "out", stream: "stderr", text: stderr.replace(/\n$/u, "") }); finish({ ok: true }); }
        else finish({ ok: false, error: stderr.replace(/\n$/u, "") || `Exited with code ${String(message.exitCode ?? 1)}.` });
        return;
      }
      if (message.id !== id) return;
      if (message.type === "out") onEvent({ type: "out", stream: message.stream === "stderr" ? "stderr" : "stdout", text: String(message.text) });
      else if (message.type === "table") onEvent({ type: "table", columns: message.columns as string[], rows: message.rows as unknown[][], note: String(message.note ?? "") });
      else if (message.type === "done") finish({ ok: Boolean(message.ok), error: message.error ? String(message.error) : undefined });
    });
    if (runtime === "java") post(runtime, { cmd: "run", source: javaProgram(code), input: "", platform: "posix" });
    else post(runtime, { type: "run", id, code, typescript: language === "typescript", setup });
  });
}

function abortable<T>(promise: Promise<T>, signal?: AbortSignal): Promise<T> {
  if (!signal) return promise;
  return new Promise<T>((resolve, reject) => {
    const onAbort = () => reject(new Error("Stopped."));
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}
