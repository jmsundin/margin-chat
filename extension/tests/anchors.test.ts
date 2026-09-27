import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import {
  ANCHOR_MAX_NODES,
  ANCHOR_MAX_TEXT_LENGTH,
  captureTextAnchor,
  resolveTextAnchor,
} from "../src/anchors";

const windows: Window[] = [];
afterEach(() => {
  for (const window of windows.splice(0)) window.happyDOM.abort();
});

function page(html: string): Document {
  const window = new Window({ url: "https://example.com/article" });
  windows.push(window);
  window.document.body.innerHTML = html;
  return window.document as unknown as Document;
}

function select(document: Document, start: Node, from: number, end = start, to = start.textContent!.length) {
  const range = document.createRange();
  range.setStart(start, from);
  range.setEnd(end, to);
  const selection = document.getSelection()!;
  selection.removeAllRanges();
  selection.addRange(range);
  return selection;
}

describe("page text anchors", () => {
  test("preserves exact whitespace and text across inline nodes without mutating the page", () => {
    const document = page("<p>Before: a <strong>useful</strong>  passage. After.</p>");
    const paragraph = document.querySelector("p")!;
    const before = document.body.innerHTML;
    const anchor = captureTextAnchor(
      select(document, paragraph.firstChild!, 8, paragraph.lastChild!, 9),
      document,
    )!;
    expect(anchor).toEqual({
      exact: "a useful  passage",
      prefix: "Before: ",
      suffix: ". After.",
      start: 8,
      end: 25,
    });
    const restored = resolveTextAnchor(document, anchor)!;
    expect(restored.toString()).toBe(anchor.exact);
    expect(restored.startContainer).toBe(paragraph.firstChild);
    expect(restored.endContainer).toBe(paragraph.lastChild);
    expect(document.body.innerHTML).toBe(before);
  });

  test("supports element boundary selections and UTF-16 offsets", () => {
    const document = page("<p><b>🌎 reading</b><i> together</i></p>");
    const paragraph = document.querySelector("p")!;
    const anchor = captureTextAnchor(select(document, paragraph, 0, paragraph, 2), document)!;
    expect(anchor.exact).toBe("🌎 reading together");
    expect(anchor.end).toBe(anchor.exact.length);
    expect(resolveTextAnchor(document, anchor)?.toString()).toBe(anchor.exact);
  });

  test("recovers a quote after earlier content shifts and inline markup changes", () => {
    const document = page("<p>Research introduction. Read this passage carefully. End of article.</p>");
    const text = document.querySelector("p")!.firstChild!;
    const anchor = captureTextAnchor(select(document, text, 23, text, 40), document)!;
    expect(anchor.exact).toBe("Read this passage");
    document.body.innerHTML = "<nav>New navigation content</nav><p>Research introduction. Read <em>this passage</em> carefully. End of article.</p>";
    expect(resolveTextAnchor(document, anchor)?.toString()).toBe(anchor.exact);
  });

  test("uses both surrounding contexts to distinguish duplicate passages", () => {
    const document = page("<p>First context. Same quote. First ending.</p><p>Second context. Same quote. Second ending.</p>");
    const text = document.querySelectorAll("p")[1]!.firstChild!;
    const anchor = captureTextAnchor(select(document, text, 16, text, 26), document)!;
    expect(anchor.exact).toBe("Same quote");
    const restored = resolveTextAnchor(document, anchor)!;
    expect(restored.startContainer).toBe(text);
    expect(restored.toString()).toBe("Same quote");
  });

  test("does not use old offsets to choose between identical passages", () => {
    const context = "shared context ".repeat(5);
    const passage = `<p>${context}Same quote${context}</p>`;
    const document = page(passage + passage);
    const text = document.querySelector("p")!.firstChild!;
    const anchor = captureTextAnchor(select(document, text, context.length, text, context.length + 10), document)!;
    expect(resolveTextAnchor(document, anchor)).toBeNull();
  });

  test("does not attach a removed quote to another occurrence with different context", () => {
    const document = page("<p>First context. Same quote. First ending.</p><p>Second context. Same quote. Second ending.</p>");
    const first = document.querySelector("p")!;
    const text = first.firstChild!;
    const anchor = captureTextAnchor(select(document, text, 15, text, 25), document)!;
    first.remove();
    expect(resolveTextAnchor(document, anchor)).toBeNull();
    document.body.textContent = "Entirely replaced article.";
    expect(resolveTextAnchor(document, anchor)).toBeNull();
  });

  test("excludes private inputs, editable regions, hidden text, and extension UI", () => {
    for (const markup of [
      "<script>Secret</script>",
      "<style>Secret</style>",
      "<form><p>Secret</p></form>",
      "<textarea>Secret</textarea>",
      "<select><option>Secret</option></select>",
      "<button>Secret</button>",
      "<iframe>Secret</iframe>",
      "<div hidden>Secret</div>",
      "<div aria-hidden='true'>Secret</div>",
      "<div style='display:none'>Secret</div>",
      "<div style='visibility:hidden'>Secret</div>",
      "<div contenteditable>Secret</div>",
      "<div contenteditable='true'><span contenteditable='false'>Secret</span></div>",
      "<div data-margin-overlay><p>Secret</p></div>",
    ]) {
      const document = page(`<p>Public quote</p>${markup}<p>Public ending</p>`);
      const text = document.querySelector("p")!.firstChild!;
      const anchor = captureTextAnchor(select(document, text, 0), document)!;
      expect(anchor.exact).toBe("Public quote");
      expect(anchor.suffix).toBe("Public ending");
      const secret = document.body.children[1]!;
      const selection = document.getSelection()!;
      const range = document.createRange();
      range.selectNodeContents(secret);
      selection.removeAllRanges();
      selection.addRange(range);
      expect(captureTextAnchor(selection, document)).toBeNull();
    }
  });

  test("rejects a selection that crosses an excluded region", () => {
    const document = page("<p>Public before</p><div contenteditable>Private draft</div><p>Public after</p>");
    const paragraphs = document.querySelectorAll("p");
    expect(captureTextAnchor(select(document, paragraphs[0]!.firstChild!, 0, paragraphs[1]!.firstChild!, 12), document)).toBeNull();
  });

  test("does not restore a highlight across a newly inserted editable region", () => {
    const document = page("<p>Public before and after</p>");
    const text = document.querySelector("p")!.firstChild!;
    const anchor = captureTextAnchor(select(document, text, 0), document)!;
    document.body.innerHTML = "<p>Public before <span contenteditable>Private draft</span>and after</p>";
    expect(resolveTextAnchor(document, anchor)).toBeNull();
  });

  test("ignores empty selections, detached nodes, and invalid persisted anchors", () => {
    const document = page("<p>   </p>");
    expect(captureTextAnchor(null, document)).toBeNull();
    expect(captureTextAnchor(document.getSelection(), document)).toBeNull();
    const text = document.querySelector("p")!.firstChild!;
    expect(captureTextAnchor(select(document, text, 0), document)).toBeNull();
    const detached = document.createTextNode("Detached quote");
    expect(captureTextAnchor(select(document, detached, 0), document)).toBeNull();
    expect(resolveTextAnchor(document, { exact: "quote", prefix: "", suffix: "", start: -1, end: 4 })).toBeNull();
    expect(resolveTextAnchor(document, { exact: "quote", prefix: "", suffix: "", start: 0, end: 6 })).toBeNull();
  });

  test("bounds page indexing by both text length and element count", () => {
    const document = page(`<p>${"a".repeat(ANCHOR_MAX_TEXT_LENGTH + 1)}</p>`);
    let text = document.querySelector("p")!.firstChild!;
    expect(captureTextAnchor(select(document, text, 0, text, 1), document)).toBeNull();
    document.body.innerHTML = "<p>quote</p>" + "<span></span>".repeat(ANCHOR_MAX_NODES);
    text = document.querySelector("p")!.firstChild!;
    expect(captureTextAnchor(select(document, text, 0), document)).toBeNull();
  });
});
