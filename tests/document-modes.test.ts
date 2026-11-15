import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { automaticModeReason, clearDocumentModePick, codeShareOf, documentModeOf, editorViewFor, readDocumentModePicks, saveDocumentModePick } from "../client/src/lib/documentModes";
import { guessTextLanguage } from "../client/src/lib/languageLearning";
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

describe("saying when a mode was chosen automatically", () => {
  beforeEach(() => store.clear());
  const code = { cells: 2, mostlyCode: true };
  test("names why a board, a language page or a page of code opened as it did", () => {
    expect(automaticModeReason({ id: "a", nodeType: "board" }, {})).toEqual({ mode: "board", reason: "this page is a board" });
    expect(automaticModeReason({ id: "a", languageLearning: { target: "es", base: "en" } }, {}, undefined, "Spanish")?.reason).toBe("this page is for learning Spanish");
    expect(automaticModeReason({ id: "a" }, {}, code)).toEqual({ mode: "code", reason: "this page is mostly code" });
  });
  test("says nothing for a pick or a plain page", () => {
    expect(automaticModeReason({ id: "a" }, { a: "write" }, code)).toBeNull();
    expect(automaticModeReason({ id: "a" }, {})).toBeNull();
  });
  test("Back to automatic forgets only that document's pick", () => {
    saveDocumentModePick("a", "write");
    saveDocumentModePick("b", "read");
    clearDocumentModePick("a");
    expect(readDocumentModePicks()).toEqual({ b: "read" });
    expect(documentModeOf({ id: "a" }, readDocumentModePicks(), "live", code)).toBe("code");
  });
});

describe("guessing a page's language for the Language hint", () => {
  test("knows common languages by their small words or script", () => {
    expect(guessTextLanguage("El perro de mi vecino es muy grande y le gusta correr por el parque con los niños. Pero no se lleva bien con los gatos de la casa, que son muy pequeños y están siempre en la ventana.")).toBe("es");
    expect(guessTextLanguage("Le chat de ma voisine est très grand et il aime courir dans le jardin avec les enfants. Mais il ne sort pas quand il pleut, et il reste sur la fenêtre pour regarder les oiseaux.")).toBe("fr");
    expect(guessTextLanguage("The results of the trial were published last week, and they show that the drug is safe for most people who took it over the full year of the study, with few side effects.")).toBe("en");
    expect(guessTextLanguage("Мы долго гуляли по парку, а потом пошли домой пить чай с бабушкой и смотреть старые фотографии из её детства.")).toBe("ru");
  });
  test("stays quiet on short or mixed text", () => {
    expect(guessTextLanguage("Hola, ¿qué tal?")).toBeNull();
    expect(guessTextLanguage("")).toBeNull();
  });
});
