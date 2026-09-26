import { describe, expect, test } from "bun:test";
import { findLatexStart, latexMarkdownLexer, readLatexAtStart, renderLatexToHtml } from "../client/src/lib/latex";
import { splitDocumentMarkdown } from "../client/src/lib/editableDocument";
import { parseMarkdownBlocks } from "../client/src/lib/markdownBlocks";

describe("LaTeX Markdown", () => {
  test("recognizes inline and display delimiters without losing the original source", () => {
    for (const [raw, latex, displayMode] of [
      ["$x^2$", "x^2", false], [String.raw`\(\frac{a}{b}\)`, String.raw`\frac{a}{b}`, false],
      ["$$\nx^2 + y^2 = z^2\n$$", "\nx^2 + y^2 = z^2\n", true],
      [String.raw`\[\sum_{i=1}^{n} i\]`, String.raw`\sum_{i=1}^{n} i`, true],
    ] as const) expect(readLatexAtStart(raw + " after")).toMatchObject({ raw, latex, displayMode });
    expect(readLatexAtStart("$x$", true)).toBeNull();
    expect(readLatexAtStart("$$x$$", false)).toBeNull();
  });

  test("keeps ordinary currency, escaped dollars, and code literal", () => {
    for (const source of ["Prices are $5 and $10.", String.raw`Escaped \$x\$ and \\(x\\).`, "`$x$`", "```latex\n$$x$$\n```", "    $x$"]) {
      expect(latexMarkdownLexer.parse(source)).not.toContain('class="katex"');
    }
    expect(findLatexStart(String.raw`\$5 and $x$`)).toBe(8);
    const mixed = latexMarkdownLexer.parse("Costs $5 and $10; equation $x^2$.") as string;
    expect(mixed).toContain("Costs $5 and $10; equation");
    expect(mixed).toContain('class="katex"');
    expect(readLatexAtStart("$x\ny$")).toBeNull();
    expect(readLatexAtStart("$ x $")).toBeNull();
    expect(readLatexAtStart("$unfinished")).toBeNull();
  });

  test("renders safe accessible math and leaves malformed formulas readable", () => {
    const html = renderLatexToHtml(String.raw`\frac{a}{b} + \sqrt{c}`, true);
    expect(html).toContain('class="katex-display"');
    expect(html).toContain("<math");
    expect(html).toContain('encoding="application/x-tex"');
    const invalid = renderLatexToHtml(String.raw`\frac{`, false);
    expect(invalid).toContain("document-math-error");
    expect(invalid).toContain(String.raw`$\frac{$`);
    const injection = renderLatexToHtml(String.raw`\href{javascript:alert(1)}{click} \htmlStyle{color:red}{text} <script>`, false);
    expect(injection).not.toContain('href="javascript:');
    expect(injection).not.toContain('style="color:red"');
    expect(injection).not.toContain("<script>");
    expect(renderLatexToHtml(String.raw`\gdef\loop{\loop}\loop`)).toContain("document-math-error");
  });

  test("keeps multiline display math together during document block creation", () => {
    for (const formula of ["$$\n\\begin{aligned}\nx &= 1 \\\\\n\ny &= 2\n\\end{aligned}\n$$", "\\[\nx^2\n\n+ y^2\n\\]"]) {
      const source = `Before\n\n${formula}\n\nAfter`;
      const chunks = splitDocumentMarkdown(source);
      expect(chunks.join("")).toBe(source);
      expect(chunks.some((chunk) => chunk.trim() === formula)).toBe(true);
      expect(parseMarkdownBlocks(source).find((block) => block.kind === "math")?.value).toBe(formula);
    }
    expect(parseMarkdownBlocks("  $$x^2$$")).toMatchObject([{ kind: "math", value: "  $$x^2$$" }]);
    expect(parseMarkdownBlocks("$$x^2$$ and text")[0].kind).toBe("line");
    expect(parseMarkdownBlocks("Text  \n$$\nx^2\n$$").map((block) => block.kind)).toEqual(["line", "math"]);
  });
});

test("shared sanitized Markdown renderers retain equations without allowing unsafe HTML", async () => {
  const child = Bun.spawn([process.execPath, "tests/helpers/latexRenderingHarness.ts"], {
    cwd: new URL("..", import.meta.url).pathname, stdout: "pipe", stderr: "pipe",
  });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  if (code !== 0) throw new Error(`LaTeX renderer regression:\n${stdout}\n${stderr}`);
  expect(stdout.trim()).toBe("LaTeX renderers passed");
});
