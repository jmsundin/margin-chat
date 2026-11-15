import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { codeShareOf, documentModeOf, editorViewFor, readDocumentModePicks, saveDocumentModePick } from "../client/src/lib/documentModes";
import { FEATURES, FEATURE_PRESETS, parseFeatures } from "../client/src/lib/features";

const store = new Map<string, string>();
const globals = globalThis as { localStorage?: unknown; window?: unknown };
const previous = { localStorage: globals.localStorage, window: globals.window };
afterAll(() => { globals.localStorage = previous.localStorage; globals.window = previous.window; });
globals.localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  setItem: (key: string, value: string) => { store.set(key, value); },
  removeItem: (key: string) => { store.delete(key); },
};
globals.window ??= { addEventListener() {}, removeEventListener() {} };

describe("the mode a document opens in", () => {
  beforeEach(() => store.clear());

  test("what the document holds decides first", () => {
    expect(documentModeOf({ id: "a", nodeType: "board" }, { a: "read" }, "live")).toBe("board");
    expect(documentModeOf({ id: "a", languageLearning: { target: "es", base: "en" } }, { a: "write" }, "live")).toBe("language");
  });

  test("then the pick for that document, then the device's page view", () => {
    expect(documentModeOf({ id: "a" }, { a: "read" }, "live")).toBe("read");
    expect(documentModeOf({ id: "b" }, { a: "read" }, "live")).toBe("write");
    expect(documentModeOf({ id: "b" }, {}, "reading")).toBe("read");
    expect(documentModeOf({ id: "b" }, { b: "write" }, "reading")).toBe("write");
  });

  test("Write keeps Live Preview or Source; Read is Reading", () => {
    expect(editorViewFor("read", "source")).toBe("reading");
    expect(editorViewFor("write", "source")).toBe("source");
    expect(editorViewFor("write", "reading")).toBe("live");
  });

  test("picks are remembered per document and ignore bad saved values", () => {
    saveDocumentModePick("a", "read");
    saveDocumentModePick("b", "write");
    saveDocumentModePick("a", "write");
    expect(readDocumentModePicks()).toEqual({ b: "write", a: "write" });
    store.set("margin-chat:document-modes", JSON.stringify({ a: "board", c: "read" }));
    expect(readDocumentModePicks()).toEqual({ c: "read" });
    store.set("margin-chat:document-modes", "not json");
    expect(readDocumentModePicks()).toEqual({});
  });
});

describe("Code mode", () => {
  const block = (content: string) => ({ kind: "markdown", content });
  test("counts runnable cells and opens a page that is mostly code in Code", () => {
    const code = [block("Kaplan–Meier curves.\n\n```python\nimport pandas as pd\ndf = pd.read_csv('cohort.csv')\nprint(df.describe())\n```")];
    expect(codeShareOf(code)).toEqual({ cells: 1, mostlyCode: true });
    expect(documentModeOf({ id: "a" }, {}, "live", codeShareOf(code))).toBe("code");
    expect(documentModeOf({ id: "a" }, { a: "write" }, "live", codeShareOf(code))).toBe("write");
  });
  test("a page with a snippet stays in Write, and a Code pick needs a cell", () => {
    const prose = [block("A long paragraph about rapamycin dosing and the PEARL trial results over 48 weeks.\n\n```js\n1+1\n```")];
    expect(codeShareOf(prose)).toEqual({ cells: 1, mostlyCode: false });
    expect(documentModeOf({ id: "a" }, {}, "live", codeShareOf(prose))).toBe("write");
    expect(documentModeOf({ id: "b" }, { b: "code" }, "live", codeShareOf([block("No code here.")]))).toBe("write");
    expect(codeShareOf([block("```mermaid\ngraph TD\n```")]).cells).toBe(0);
  });
});

describe("Language learning is an opt-in feature", () => {
  test("off on Simple, on for Student", () => {
    expect(FEATURES.some((feature) => feature.id === "language")).toBe(true);
    expect(parseFeatures(null).language).toBe(false);
    expect(FEATURE_PRESETS.find((preset) => preset.id === "simple")!.features).not.toContain("language");
    expect(FEATURE_PRESETS.find((preset) => preset.id === "student")!.features).toContain("language");
  });
});
