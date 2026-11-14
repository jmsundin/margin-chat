import { afterEach, describe, expect, test } from "bun:test";
import { EditorState } from "@codemirror/state";
import { createChatService } from "../server/chat/index.mjs";
import { buildChatTitleInstruction, sanitizeCodeSuggestion, validateChatTitleRequest } from "../server/chat/title.mjs";
import { matchApiRoute } from "../server/routes/registry.mjs";
import { buildSuggestionPrompt, commentText, findSuggestionTrigger, shapeSuggestion } from "../client/src/lib/codeRunner/codeSuggestion";
import { codeSuggestions, ghostIn, setGhost } from "../client/src/lib/codeRunner/ghostText";

const originalFetch = globalThis.fetch;
afterEach(() => { globalThis.fetch = originalFetch; });

describe("comments in each language", () => {
  test("reads whole-line comments in each cell language's own syntax", () => {
    expect(commentText("python", "    # load the csv")).toBe("load the csv");
    expect(commentText("sql", "-- top five customers")).toBe("top five customers");
    expect(commentText("sql", "/* top five customers */")).toBe("top five customers");
    expect(commentText("javascript", "// sum the list")).toBe("sum the list");
    expect(commentText("typescript", "/** a typed fetch */")).toBe("a typed fetch");
    expect(commentText("java", "  // reverse a string")).toBe("reverse a string");
    expect(commentText("css", "/* center the card */")).toBe("center the card");
    expect(commentText("html", "<!-- a signup form -->")).toBe("a signup form");
  });

  test("ignores another language's comments and code with a comment after it", () => {
    expect(commentText("python", "// not python")).toBeNull();
    expect(commentText("javascript", "# not js")).toBeNull();
    expect(commentText("css", "// not css")).toBeNull();
    expect(commentText("html", "<!-- unclosed")).toBeNull();
    expect(commentText("python", "x = 1  # set x")).toBeNull();
  });
});

describe("when a suggestion is asked for", () => {
  test("at the end of a comment line, the code starts on the next line", () => {
    const doc = "import csv\n# read rows from data.csv";
    const trigger = findSuggestionTrigger("python", doc, doc.length);
    expect(trigger).toMatchObject({ comment: "read rows from data.csv", at: doc.length, newLine: true, indent: "" });
  });

  test("on an empty line right under a comment (after Enter)", () => {
    const doc = "def f(rows):\n    # count the rows\n    ";
    const trigger = findSuggestionTrigger("python", doc, doc.length);
    expect(trigger).toMatchObject({ comment: "count the rows", at: doc.length, newLine: false, indent: "    " });
  });

  test("not in the middle of a line, under code, or for a comment with no words", () => {
    expect(findSuggestionTrigger("python", "# load data", 3)).toBeNull();
    expect(findSuggestionTrigger("python", "x = 1\n", 6)).toBeNull();
    expect(findSuggestionTrigger("javascript", "// ----", 7)).toBeNull();
    expect(findSuggestionTrigger("python", "#!/usr/bin/env python", 21)).toBeNull();
    expect(findSuggestionTrigger("python", "", 0)).toBeNull();
  });

  test("the same comment has the same key, so it isn't asked again once answered", () => {
    const a = findSuggestionTrigger("sql", "-- all users", 12);
    const b = findSuggestionTrigger("sql", "-- all users\n", 13);
    expect(a?.key).toBe(b?.key);
  });
});

describe("what the model is shown", () => {
  test("the language, the other cells, and this cell with the cursor marked", () => {
    const prompt = buildSuggestionPrompt({
      language: "sql", doc: "-- top customers\n", at: 17, own: 1,
      siblings: [{ language: "sql", source: "CREATE TABLE customers(id, spend);" }, { language: "sql", source: "-- top customers" }],
    });
    expect(prompt).toContain("Language: SQL");
    expect(prompt).toContain("[SQL cell]\nCREATE TABLE customers(id, spend);");
    expect(prompt).not.toContain("[SQL cell]\n-- top customers");
    expect(prompt.endsWith("-- top customers\n<CURSOR>")).toBe(true);
  });

  test("stays under the server's limit for a very long cell", () => {
    const doc = "x = 1\n".repeat(5_000);
    const siblings = Array.from({ length: 20 }, () => ({ language: "python" as const, source: "y = 2\n".repeat(500) }));
    expect(buildSuggestionPrompt({ language: "python", doc, at: doc.length / 2, siblings }).length).toBeLessThan(12_000);
  });
});

describe("shaping the model's code to fit", () => {
  const endOfComment = { comment: "count rows", at: 0, newLine: true, indent: "    ", key: "k" };
  const underComment = { ...endOfComment, newLine: false };

  test("indents like the comment and starts a new line after it", () => {
    expect(shapeSuggestion("total = 0\nfor row in rows:\n    total += 1", endOfComment, "python"))
      .toBe("\n    total = 0\n    for row in rows:\n        total += 1");
  });

  test("under the comment, the first line goes at the cursor (already indented)", () => {
    expect(shapeSuggestion("        return len(rows)", underComment, "python")).toBe("return len(rows)");
  });

  test("drops a repeat of the comment and blank edges", () => {
    expect(shapeSuggestion("\n# count rows\nn = len(rows)\n\n", endOfComment, "python")).toBe("\n    n = len(rows)");
    expect(shapeSuggestion("  \n", endOfComment, "python")).toBe("");
  });
});

describe("ghost text in the editor", () => {
  function editor(doc: string) {
    return EditorState.create({ doc, selection: { anchor: doc.length }, extensions: codeSuggestions({ language: "python", request: async () => "" }) });
  }

  test("typing what it shows keeps the rest; typing something else dismisses it", () => {
    let state = editor("# say hi\n").update({ effects: setGhost.of({ at: 9, text: "print('hi')" }) }).state;
    state = state.update({ changes: { from: 9, insert: "pri" }, selection: { anchor: 12 } }).state;
    expect(ghostIn(state)).toEqual({ at: 12, text: "nt('hi')" });
    state = state.update({ changes: { from: 12, insert: "x" }, selection: { anchor: 13 } }).state;
    expect(ghostIn(state)).toBeNull();
  });

  test("moving the cursor away dismisses it", () => {
    let state = editor("# say hi\n").update({ effects: setGhost.of({ at: 9, text: "print('hi')" }) }).state;
    state = state.update({ selection: { anchor: 2 } }).state;
    expect(ghostIn(state)).toBeNull();
  });

  test("the document holds none of it until it's accepted", () => {
    const state = editor("# say hi\n").update({ effects: setGhost.of({ at: 9, text: "print('hi')" }) }).state;
    expect(state.doc.toString()).toBe("# say hi\n");
  });
});

describe("the server's code suggestions", () => {
  test("go through the metered title route on the fast model", () => {
    expect(matchApiRoute("POST", "/api/chat/title")?.id).toBe("chatTitle");
    const request = validateChatTitleRequest({ kind: "code", prompt: "Language: Python\n# add two numbers\n<CURSOR>", serviceId: "anthropic-api", modelId: "claude-opus-5-5" });
    expect(request).toMatchObject({ kind: "code", serviceId: "openai-api", modelId: "gpt-6-luna" });
    expect(buildChatTitleInstruction("code")).toContain("<CURSOR>");
  });

  test("accept a cell's worth of context but not more", () => {
    expect(() => validateChatTitleRequest({ kind: "code", prompt: "x".repeat(11_000) })).not.toThrow();
    expect(() => validateChatTitleRequest({ kind: "code", prompt: "x".repeat(12_001) })).toThrow();
  });

  test("strip fences and the cursor marker but keep indentation", () => {
    expect(sanitizeCodeSuggestion("```python\n    return a + b\n```")).toBe("    return a + b");
    expect(sanitizeCodeSuggestion("<CURSOR>SELECT 1;\n\n")).toBe("SELECT 1;");
    expect(sanitizeCodeSuggestion(null)).toBe("");
    expect(sanitizeCodeSuggestion("NONE")).toBe("");
  });

  test("returns the code, and an empty answer is not an error", async () => {
    const bodies: any[] = [];
    let reply = "```js\nconst sum = a + b;\n```";
    globalThis.fetch = (async (_url: string, init: RequestInit) => { bodies.push(JSON.parse(String(init.body))); return Response.json({ output_text: reply }); }) as typeof fetch;
    const service = createChatService({
      database: {}, env: { OPENAI_API_KEY: "openai-test-key" },
      runtimeConfig: { defaultBackendProvider: "openai-api", openaiModel: "gpt-5.6", geminiModel: "gemini-3.1-pro-preview", huggingFaceModel: "openai/gpt-oss-120b", xaiModel: "grok-4.5" },
    });
    expect(await service.generateTitle({ kind: "code", prompt: "Language: JavaScript\n// add a and b\n<CURSOR>" })).toEqual({ code: "const sum = a + b;" });
    expect(bodies[0].model).toBe("gpt-6-luna");
    expect(bodies[0].instructions).toContain("code completion engine");
    reply = "NONE";
    expect(await service.generateTitle({ kind: "code", prompt: "Language: JavaScript\n// hello\n<CURSOR>" })).toEqual({ code: "" });
  });
});
