import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { Window } from "happy-dom";
import { findRunnableFences, javaProgram, previewDocument, previewPage, replaceFenceSource, runnableLanguage, sqlSetup, writeFenceSource } from "../client/src/lib/codeRunner/languages";
import { JAVASCRIPT_WORKER, SQL_WORKER } from "../client/src/lib/codeRunner/workers";

// The Markdown renderer sanitizes with DOMPurify, which needs a window when it loads.
Object.defineProperty(globalThis, "window", { configurable: true, value: new Window({ url: "http://fixture.test" }) });
// When another test loaded DOMPurify first without a window, give its shared instance one.
const { default: DOMPurify } = await import("dompurify");
if (typeof DOMPurify.sanitize !== "function") Object.assign(DOMPurify, DOMPurify(globalThis.window as never));
const { liveBlockInfo } = await import("../client/src/lib/liveDocument");
const { renderObsidianMarkdownToHtml } = await import("../client/src/lib/markdown");

const require = createRequire(import.meta.url);

describe("runnable fences", () => {
  test("languages and their aliases run; others don't", () => {
    expect(runnableLanguage("py")).toBe("python");
    expect(runnableLanguage("ts {title}")).toBe("typescript");
    expect(runnableLanguage("JS")).toBe("javascript");
    expect(runnableLanguage("sqlite")).toBe("sql");
    expect(runnableLanguage("html")).toBe("html");
    expect(runnableLanguage("mermaid")).toBeNull();
    expect(runnableLanguage("bash")).toBeNull();
    expect(runnableLanguage("")).toBeNull();
  });

  test("finds runnable fences in order and skips the inside of other fences", () => {
    const markdown = [
      "Intro", "", "```sql", "SELECT 1;", "```", "",
      "````markdown", "```python", "print('not a cell')", "```", "````", "",
      "~~~js", "console.log(1)", "~~~", "", "```mermaid", "graph TD", "```",
    ].join("\n");
    const fences = findRunnableFences(markdown);
    expect(fences.map((fence) => [fence.language, fence.source])).toEqual([["sql", "SELECT 1;"], ["javascript", "console.log(1)"]]);
    expect(markdown.slice(fences[0].start, fences[0].end)).toBe("```sql\nSELECT 1;\n```");
  });

  test("an unclosed fence runs to the end", () => {
    const fences = findRunnableFences("```python\nprint(1)\nprint(2)");
    expect(fences[0].source).toBe("print(1)\nprint(2)");
  });

  test("an edit replaces only the code, keeping fence lines and the text around", () => {
    const markdown = "Before\n\n```python\nprint(1)\n```\nAfter";
    const [fence] = findRunnableFences(markdown);
    expect(replaceFenceSource(markdown, fence, "print(2)\nprint(3)")).toBe("Before\n\n```python\nprint(2)\nprint(3)\n```\nAfter");
    expect(replaceFenceSource(markdown, fence, "")).toBe("Before\n\n```python\n```\nAfter");
  });

  test("a save only writes over the code it last saw", () => {
    const markdown = "```sql\nSELECT 1;\n```\n\n```sql\nSELECT 2;\n```";
    expect(writeFenceSource(markdown, 0, 1, "SELECT 2;", "SELECT 3;")).toBe("```sql\nSELECT 1;\n```\n\n```sql\nSELECT 3;\n```");
    // The block changed elsewhere: nothing is overwritten.
    expect(writeFenceSource(markdown, 0, 1, "SELECT 9;", "SELECT 3;")).toBeNull();
    // A fence added above shifted the index: the one with the code it saw is still found.
    expect(writeFenceSource(`\`\`\`sql\nSELECT 0;\n\`\`\`\n\n${markdown}`, 0, 1, "SELECT 2;", "SELECT 3;")).toContain("SELECT 3;");
    // An Enter at the end of the code isn't stored, so the next save still finds its fence.
    const typed = writeFenceSource(markdown, 0, 1, "SELECT 2;", "SELECT 3;\n")!;
    expect(writeFenceSource(typed, 0, 1, "SELECT 3;\n", "SELECT 3;\n ")).toContain("SELECT 3;\n \n```");
    // Counting starts at the part of the block the cell sits in.
    const later = markdown.indexOf("```sql\nSELECT 2;");
    expect(writeFenceSource(markdown, later, 0, "SELECT 2;", "SELECT 4;")).toBe("```sql\nSELECT 1;\n```\n\n```sql\nSELECT 4;\n```");
  });
});

describe("cells that use the cells around them", () => {
  const cells = [
    { language: "sql", source: "CREATE TABLE t (x);" },
    { language: "html", source: "<p>One</p>" },
    { language: "css", source: "p { color: red }" },
    { language: "python", source: "print(1)" },
    { language: "css", source: "p { font-weight: bold }" },
    { language: "html", source: "<p>Two</p>" },
    { language: "sql", source: "SELECT * FROM t;" },
  ] as const;

  test("SQL runs after the SQL cells above it", () => {
    expect(sqlSetup(cells, 6)).toEqual(["CREATE TABLE t (x);"]);
    expect(sqlSetup(cells, 0)).toEqual([]);
  });

  test("an HTML cell takes the CSS cells under it, up to the next HTML cell", () => {
    expect(previewPage(cells, 1)).toEqual({ html: "<p>One</p>", css: ["p { color: red }", "p { font-weight: bold }"], htmlIndex: 1 });
    expect(previewPage(cells, 5)).toEqual({ html: "<p>Two</p>", css: [], htmlIndex: 5 });
  });

  test("a CSS cell styles the HTML above it, or a sample page", () => {
    expect(previewPage(cells, 2).htmlIndex).toBe(1);
    const alone = previewPage([{ language: "css", source: "h1 { color: blue }" }], 0);
    expect(alone.htmlIndex).toBeNull();
    expect(alone.css).toEqual(["h1 { color: blue }"]);
    expect(alone.html).toContain("<h1>");
  });

  test("the preview page holds the HTML and its styles", () => {
    const page = previewDocument("<p>Hi</p>", ["p { color: red }"], false);
    expect(page).toContain("<p>Hi</p>");
    expect(page).toContain("p { color: red }");
    const full = previewDocument("<html><head><title>T</title></head><body>x</body></html>", ["b{}"], true);
    expect(full.indexOf("b{}")).toBeLessThan(full.indexOf("</head>"));
    expect(previewDocument("", ["</style><script>"], false)).not.toContain("</style><script>");
  });

  test("Java statements get a main method; full classes are left alone", () => {
    const wrapped = javaProgram("import java.time.*;\nSystem.out.println(1 + 2);");
    expect(wrapped).toContain("public class Main");
    expect(wrapped).toContain("import java.time.*;");
    expect(wrapped).toContain("        System.out.println(1 + 2);");
    const full = "public class Hello { public static void main(String[] a) {} }";
    expect(javaProgram(full)).toBe(full);
  });
});

describe("documents show runnable code as cells", () => {
  test("a code block in a document renders as a cell; other code stays text", () => {
    expect(liveBlockInfo("```python\nprint(1)\n```").kind).toBe("rendered");
    expect(liveBlockInfo("```bash\nls\n```").kind).toBe("text");
    const mixed = "Some words.\n\n```sql\nSELECT 1;\n```\n\nMore words.";
    const info = liveBlockInfo(mixed);
    expect(info.parts.map((part) => mixed.slice(part.from, part.to))).toEqual(["```sql\nSELECT 1;\n```"]);
  });

  test("rendered Markdown marks runnable blocks", () => {
    expect(renderObsidianMarkdownToHtml("```java\nint x = 1;\n```")).toContain('data-runnable="java"');
    expect(renderObsidianMarkdownToHtml("```html\n<p>x</p>\n```")).toContain('data-runnable="html"');
    expect(renderObsidianMarkdownToHtml("```bash\nls\n```")).not.toContain("data-runnable");
  });
});

/** Runs a worker script in this process, with `self` standing in for the worker's global. */
function startWorker(source: string) {
  const messages: Array<Record<string, unknown>> = [];
  const waiters: Array<() => void> = [];
  const self = new Proxy({ postMessage: (message: Record<string, unknown>) => { messages.push(message); waiters.splice(0).forEach((wake) => wake()); } } as Record<string, unknown>, {
    get: (target, key) => key in target ? target[key as string] : (globalThis as Record<string | symbol, unknown>)[key],
    set: (target, key, value) => { target[key as string] = value; return true; },
  });
  new Function("self", "importScripts", source)(self, () => { throw new Error("no importScripts"); });
  const send = (data: unknown) => (self.onmessage as (event: { data: unknown }) => unknown)({ data });
  const until = async (test: (message: Record<string, unknown>) => boolean) => {
    for (;;) {
      const found = messages.find(test);
      if (found) return found;
      await new Promise<void>((wake) => waiters.push(wake));
    }
  };
  return { messages, send, until };
}

describe("runners", () => {
  test("JavaScript prints what console.log gets, and reports errors", async () => {
    const worker = startWorker(JAVASCRIPT_WORKER);
    await worker.until((message) => message.type === "loaded");
    await worker.send({ type: "run", id: "a", code: "console.log('sum', 1 + 2, [1, {b: 'c'}], new Map([[1, 2]]));\nconst x = await Promise.resolve(5); console.error(x);" });
    expect((await worker.until((message) => message.id === "a" && message.type === "done")).ok).toBe(true);
    expect(worker.messages.filter((message) => message.id === "a" && message.type === "out").map((message) => [message.stream, message.text]))
      .toEqual([["stdout", "sum 3 [ 1, { b: \"c\" } ] Map(1) { 1 => 2 }"], ["stderr", "5"]]);
    await worker.send({ type: "run", id: "b", code: "null.x" });
    const failed = await worker.until((message) => message.id === "b" && message.type === "done");
    expect(failed.ok).toBe(false);
    expect(String(failed.error)).toContain("TypeError");
  });

  test("TypeScript is checked for syntax, then runs", async () => {
    const worker = startWorker(JAVASCRIPT_WORKER);
    await worker.until((message) => message.type === "loaded");
    await worker.send({ type: "load-typescript", source: readFileSync(require.resolve("typescript/lib/typescript.js"), "utf8") });
    await worker.until((message) => message.type === "typescript-ready");
    await worker.send({ type: "run", id: "t", typescript: true, code: "interface P { n: number }\nconst p: P = { n: 2 };\nconsole.log(p.n * 21);" });
    expect((await worker.until((message) => message.id === "t" && message.type === "done")).ok).toBe(true);
    expect(worker.messages.find((message) => message.id === "t" && message.type === "out")?.text).toBe("42");
    await worker.send({ type: "run", id: "u", typescript: true, code: "const x: = 1;" });
    const bad = await worker.until((message) => message.id === "u" && message.type === "done");
    expect(bad.ok).toBe(false);
    expect(String(bad.error)).toContain("Line 1");
  }, 30000);

  test("SQL runs after its setup and returns tables", async () => {
    const worker = startWorker(SQL_WORKER);
    await worker.until((message) => message.type === "loaded");
    // sql.js sees Node here (in the browser it's a worker) and wants `require`.
    const dist = require.resolve("sql.js/dist/sql-wasm.js").replace(/sql-wasm\.js$/, "");
    Object.assign(globalThis, { require, __dirname: dist });
    await worker.send({ type: "init", glue: readFileSync(`${dist}sql-wasm.js`, "utf8"), wasm: new Uint8Array(readFileSync(`${dist}sql-wasm.wasm`)).buffer });
    const started = await worker.until((message) => message.type === "ready" || message.type === "failed");
    expect(started.error).toBeUndefined();
    await worker.send({ type: "run", id: "q", setup: ["CREATE TABLE t (name TEXT, n INT); INSERT INTO t VALUES ('a', 1), ('b', NULL);", "THIS IS NOT SQL"], code: "SELECT name, n FROM t ORDER BY name;" });
    expect((await worker.until((message) => message.id === "q" && message.type === "done")).ok).toBe(true);
    const table = worker.messages.find((message) => message.id === "q" && message.type === "table");
    expect(table?.columns).toEqual(["name", "n"]);
    expect(table?.rows).toEqual([["a", 1], ["b", null]]);
    await worker.send({ type: "run", id: "e", setup: [], code: "SELECT * FROM missing;" });
    const failed = await worker.until((message) => message.id === "e" && message.type === "done");
    expect(failed.ok).toBe(false);
    expect(String(failed.error)).toContain("no such table");
  }, 30000);
});
