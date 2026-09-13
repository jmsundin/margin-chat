import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { extractArticle, extractSelection } from "../src/extraction";

describe("web clipping", () => {
  test("extracts readable Markdown, resolves links, and excludes form values and page chrome without mutating the page", () => {
    const window = new Window({ url: "https://example.com/research/article" });
    window.document
      .write(`<!doctype html><html><head><title>A useful article</title></head><body><nav>Site navigation</nav><article><h1>A useful article</h1>
      ${Array.from({ length: 8 }, (_, i) => `<p>Paragraph ${i} explains why keeping the original source alongside a quotation helps a reader understand its context. There is enough information here to form a readable article, with useful details and examples.</p>`).join("")}
      <p><a href="../source">Original research</a></p><form><input value="PRIVATE FORM VALUE"><textarea>PRIVATE DRAFT</textarea></form><script>alert("bad")</script><iframe src="https://tracker.example"></iframe><img src="https://tracker.example/image"><a href="javascript:alert(1)">Unsafe link</a></article></body></html>`);
    const before = window.document.documentElement.outerHTML;
    const result = extractArticle(window.document as unknown as Document);
    expect(result.title).toContain("A useful article");
    expect(result.content).toContain("Paragraph 0");
    expect(result.content).toContain("https://example.com/source");
    for (const unwanted of [
      "PRIVATE FORM VALUE",
      "PRIVATE DRAFT",
      "javascript:",
      "tracker.example",
      "<script",
      "Site navigation",
    ])
      expect(result.content).not.toContain(unwanted);
    expect(window.document.documentElement.outerHTML).toBe(before);
    window.happyDOM.abort();
  });
  test("selection capture preserves literal text, with useful errors for empty or oversized selections", () => {
    expect(extractSelection("<script>alert(1)</script> **literal**")).toContain(
      "\\<script\\>",
    );
    expect(() => extractSelection(" ")).toThrow("Highlight a passage");
    expect(() => extractSelection("a".repeat(200001))).toThrow("too large");
  });
});
