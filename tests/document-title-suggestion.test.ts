import { describe, expect, test } from "bun:test";
import { stripInlineMarkdown, suggestLocalDocumentTitle, toPlainDocumentTitle } from "../client/src/lib/documentTitleSuggestion";

const MARKDOWN_SYNTAX = /[#*_`[\]|<>~\\]|==|\]\(/u;

describe("suggested document names", () => {
  test("uses the first heading without its markers", () => {
    expect(suggestLocalDocumentTitle("## **Senolytics** and `mTOR` _trials_\n\nBody text here.")).toBe("Senolytics and mTOR trials");
    expect(suggestLocalDocumentTitle("Kidney regrowth\n===\n\nNotes")).toBe("Kidney regrowth");
  });

  test("falls back to the first sentence of the first paragraph", () => {
    expect(suggestLocalDocumentTitle("Organoids can grow from stem cells in a dish. They are small.\n\n# Later heading"))
      .toBe("Organoids can grow from stem cells in a dish");
    expect(suggestLocalDocumentTitle("- [ ] Ask about [rapamycin dosing](https://example.com) with [[Dr Lee|my doctor]]"))
      .toBe("Ask about rapamycin dosing with my doctor");
  });

  test("skips front matter, code, rules, images and tables", () => {
    const markdown = "---\ntags: [a]\n---\n```js\nconst x = 1;\n```\n---\n![chart](a.png)\n| a | b |\n|---|---|\n\n> Partial reprogramming *reverses* age markers";
    expect(suggestLocalDocumentTitle(markdown)).toBe("Partial reprogramming reverses age markers");
  });

  test("is empty when there is nothing to name the document from", () => {
    expect(suggestLocalDocumentTitle("")).toBe("");
    expect(suggestLocalDocumentTitle("\n\n---\n\n```\nonly code\n```\n")).toBe("");
  });

  test("cuts long text at a word and never leaves Markdown", () => {
    const title = suggestLocalDocumentTitle("This is a very long opening line about **cellular senescence** and the immune system clearing old cells over decades");
    expect(title.length).toBeLessThanOrEqual(60);
    expect(title.endsWith(" ")).toBe(false);
    expect(title).toBe("This is a very long opening line about cellular senescence");
    for (const sample of ["# `code` [[link]] ==mark== ~~gone~~ <b>bold</b> #tag snake_case \\*", "**\"Title: Rapamycin.\"**", "1. [x] __Done__ | table |"]) {
      expect(toPlainDocumentTitle(sample)).not.toMatch(MARKDOWN_SYNTAX);
    }
    expect(toPlainDocumentTitle("Title: Rapamycin and mTOR.")).toBe("Rapamycin and mTOR");
    expect(stripInlineMarkdown("snake_case and _emphasis_")).toBe("snake case and emphasis");
  });
});

test("rename fields suggest a name for untitled documents without overwriting typing", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/documentTitleSuggestionHarness.tsx"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const timeout = setTimeout(() => child.kill(), 20000);
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  clearTimeout(timeout);
  if (code !== 0) throw new Error(`Document title suggestion harness failed:\n${stdout}\n${stderr}`);
  expect(JSON.parse(stdout.trim().split("\n").at(-1)!).checks).toHaveLength(5);
}, 25000);
