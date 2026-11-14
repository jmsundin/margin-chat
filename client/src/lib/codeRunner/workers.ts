/**
 * The code of the workers that run a code cell. Each is written as a function
 * with no outside references, turned into a script with toString(), and
 * started inside the sandboxed runner frame (runner.ts), so code from a
 * document never runs with the app's origin, cookies or page.
 *
 * Messages a worker sends: {type: "loaded"} when its script runs, then {type: "ready"}
 * after the "init" message gave it its runtime (or {type: "failed", error});
 * then for each run {id, type: "out", stream, text}, {id, type: "table", columns, rows, note},
 * and finally {id, type: "done", ok, error?}.
 */

/* eslint-disable @typescript-eslint/no-explicit-any */
declare const self: any;
declare function importScripts(...urls: string[]): void;

/** JavaScript and TypeScript. TypeScript is turned into JavaScript here, with the compiler sent in once. */
function javascriptWorker() {
  let ts: any = null;
  const show = (value: unknown, depth = 0, seen = new Set<unknown>()): string => {
    if (typeof value === "string") return depth ? JSON.stringify(value) : value;
    if (typeof value === "function") return `[Function ${(value as { name?: string }).name || "anonymous"}]`;
    if (typeof value === "bigint") return `${value}n`;
    if (typeof value === "symbol") return value.toString();
    if (value === null || typeof value !== "object") return String(value);
    if (seen.has(value)) return "[Circular]";
    if (value instanceof Error) return `${value.name}: ${value.message}`;
    if (value instanceof Date) return value.toISOString();
    if (value instanceof RegExp) return String(value);
    if (depth > 3) return Array.isArray(value) ? "[Array]" : "[Object]";
    seen.add(value);
    try {
      if (Array.isArray(value)) return `[ ${value.map((item) => show(item, depth + 1, seen)).join(", ")} ]`;
      if (value instanceof Map) return `Map(${value.size}) { ${[...value].map(([key, item]) => `${show(key, depth + 1, seen)} => ${show(item, depth + 1, seen)}`).join(", ")} }`;
      if (value instanceof Set) return `Set(${value.size}) { ${[...value].map((item) => show(item, depth + 1, seen)).join(", ")} }`;
      const entries = Object.entries(value as Record<string, unknown>).map(([key, item]) => `${/^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key)}: ${show(item, depth + 1, seen)}`);
      const name = (value as { constructor?: { name?: string } }).constructor?.name;
      return `${name && name !== "Object" ? `${name} ` : ""}{ ${entries.join(", ")} }`.replace("{  }", "{}");
    } finally { seen.delete(value); }
  };
  self.onmessage = async (event: MessageEvent) => {
    const message = event.data;
    if (message.type === "load-typescript") {
      try {
        (0, eval)(message.source);
        ts = self.ts;
        self.postMessage({ type: "typescript-ready" });
      } catch (error) { self.postMessage({ type: "typescript-failed", error: String(error) }); }
      return;
    }
    if (message.type !== "run") return;
    const { id } = message;
    const out = (stream: string, parts: unknown[]) => self.postMessage({ id, type: "out", stream, text: parts.map((part) => show(part)).join(" ") });
    let code: string = message.code;
    if (message.typescript) {
      if (!ts) { self.postMessage({ id, type: "done", ok: false, error: "The TypeScript compiler did not load." }); return; }
      const result = ts.transpileModule(code, { reportDiagnostics: true, compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, strict: true } });
      const problems = (result.diagnostics ?? []).map((diagnostic: any) => {
        const text = ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n");
        if (!diagnostic.file || diagnostic.start === undefined) return text;
        const { line, character } = diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start);
        return `Line ${line + 1}, column ${character + 1}: ${text}`;
      });
      if (problems.length) { self.postMessage({ id, type: "done", ok: false, error: problems.join("\n") }); return; }
      code = result.outputText.replace(/^export \{\};?\s*$/m, "");
    }
    const console = {
      log: (...parts: unknown[]) => out("stdout", parts), info: (...parts: unknown[]) => out("stdout", parts), debug: (...parts: unknown[]) => out("stdout", parts),
      warn: (...parts: unknown[]) => out("stderr", parts), error: (...parts: unknown[]) => out("stderr", parts),
      table: (data: unknown) => out("stdout", [data]),
    };
    try {
      // An async function, so top-level `await` works. `console` is this run's console.
      const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor;
      await new AsyncFunction("console", `"use strict";\n${code}`)(console);
      // Let promises the code started without awaiting print before the run ends.
      await new Promise((resolve) => setTimeout(resolve, 0));
      self.postMessage({ id, type: "done", ok: true });
    } catch (error) {
      const failure = error as { name?: string; message?: string };
      self.postMessage({ id, type: "done", ok: false, error: failure && failure.message !== undefined ? `${failure.name ?? "Error"}: ${failure.message}` : String(error) });
    }
  };
  self.postMessage({ type: "loaded" });
}

/** SQLite through sql.js. Every run starts from an empty database, then the cells above it, then the query. */
function sqlWorker() {
  let SQL: any = null;
  const ROW_LIMIT = 500;
  self.onmessage = async (event: MessageEvent) => {
    const message = event.data;
    if (message.type === "init") {
      try {
        (0, eval)(message.glue);
        SQL = await self.initSqlJs({ wasmBinary: message.wasm });
        self.postMessage({ type: "ready" });
      } catch (error) { self.postMessage({ type: "failed", error: String(error) }); }
      return;
    }
    if (message.type !== "run" || !SQL) return;
    const { id } = message;
    const db = new SQL.Database();
    try {
      for (const setup of message.setup as string[]) {
        try { db.exec(setup); } catch { /* A cell above that fails is that cell's problem, not this one's. */ }
      }
      const results = db.exec(message.code);
      if (!results.length) self.postMessage({ id, type: "out", stream: "stdout", text: `Done. ${db.getRowsModified()} row${db.getRowsModified() === 1 ? "" : "s"} changed.` });
      for (const result of results) {
        const rows = result.values.slice(0, ROW_LIMIT);
        self.postMessage({ id, type: "table", columns: result.columns, rows, note: result.values.length > ROW_LIMIT ? `Showing ${ROW_LIMIT} of ${result.values.length} rows.` : `${result.values.length} row${result.values.length === 1 ? "" : "s"}` });
      }
      self.postMessage({ id, type: "done", ok: true });
    } catch (error) {
      self.postMessage({ id, type: "done", ok: false, error: String((error as Error)?.message ?? error) });
    } finally { db.close(); }
  };
  self.postMessage({ type: "loaded" });
}

/** Python through Pyodide, loaded from its CDN the first time a Python cell runs. */
function pythonWorker() {
  let pyodide: any = null;
  let current: string | null = null;
  self.onmessage = async (event: MessageEvent) => {
    const message = event.data;
    if (message.type === "init") {
      try {
        importScripts(`${message.indexURL}pyodide.js`);
        pyodide = await self.loadPyodide({ indexURL: message.indexURL });
        const write = (stream: string) => ({ batched: (text: string) => { if (current) self.postMessage({ id: current, type: "out", stream, text }); } });
        pyodide.setStdout(write("stdout"));
        pyodide.setStderr(write("stderr"));
        pyodide.setStdin({ stdin: () => { throw new Error("input() is not available in code blocks."); } });
        self.postMessage({ type: "ready" });
      } catch (error) { self.postMessage({ type: "failed", error: String((error as Error)?.message ?? error) }); }
      return;
    }
    if (message.type !== "run" || !pyodide) return;
    const { id } = message;
    current = id;
    const globals = pyodide.toPy({ __name__: "__main__" });
    try {
      // Packages the code imports (numpy, pandas…) load on first use.
      await pyodide.loadPackagesFromImports(message.code, { messageCallback: () => undefined, errorCallback: () => undefined }).catch(() => undefined);
      await pyodide.runPythonAsync(message.code, { globals });
      self.postMessage({ id, type: "done", ok: true });
    } catch (error) {
      const text = String((error as Error)?.message ?? error);
      // Keep the traceback from the cell's own code: drop Pyodide's internal frames.
      const lines = text.split("\n");
      const start = lines.findIndex((line) => line.includes('File "<exec>"'));
      self.postMessage({ id, type: "done", ok: false, error: start > 0 ? ["Traceback (most recent call last):", ...lines.slice(start)].join("\n") : text });
    } finally {
      globals.destroy();
      current = null;
    }
  };
  self.postMessage({ type: "loaded" });
}

/**
 * Runs before the Java compiler's own worker script: it answers that script's
 * requests for its compiler files from bytes the app sent in, since the
 * sandboxed frame cannot fetch them from the app.
 */
function javaFileShim() {
  const files = new Map<string, ArrayBuffer>();
  const realFetch = self.fetch.bind(self);
  self.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    if (url.startsWith("https://code-runner.invalid/")) {
      const name = url.slice(url.lastIndexOf("/") + 1);
      const bytes = files.get(name);
      if (!bytes) return Promise.resolve(new Response(null, { status: 404 }));
      return Promise.resolve(new Response(bytes.slice(0), { headers: { "Content-Type": name.endsWith(".wasm") ? "application/wasm" : "application/octet-stream" } }));
    }
    return realFetch(input, init);
  };
  self.addEventListener("message", (event: MessageEvent) => {
    if (event.data?.type !== "java-files") return;
    for (const [name, bytes] of Object.entries(event.data.files as Record<string, ArrayBuffer>)) files.set(name, bytes);
    event.stopImmediatePropagation();
  });
}

const script = (fn: () => void) => `(${fn.toString()})();\n`;

export const JAVASCRIPT_WORKER = script(javascriptWorker);
export const SQL_WORKER = script(sqlWorker);
export const PYTHON_WORKER = script(pythonWorker);
export const JAVA_FILE_SHIM = script(javaFileShim);
