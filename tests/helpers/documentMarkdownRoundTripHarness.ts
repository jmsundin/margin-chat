import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://document-markdown.test" });
browser.document.write("<!doctype html><html><head></head><body></body></html>");
Object.defineProperty(browser.document, "compatMode", { value: "CSS1Compat" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "NodeFilter", "Text", "Document", "DocumentFragment", "MutationObserver", "ResizeObserver", "Event", "MouseEvent", "KeyboardEvent", "ClipboardEvent", "Range", "DOMRect", "DOMParser", "getComputedStyle", "HTMLInputElement", "HTMLTextAreaElement", "ShadowRoot"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value: name === "getComputedStyle" ? value.bind(browser) : value });
}
const { Editor } = await import("@tiptap/core");
const { createRichDocumentExtensions } = await import("../../client/src/components/RichDocumentEditor");
const { getRichDocumentFallbackReason } = await import("../../client/src/lib/richDocumentMarkdown");
const { renderObsidianMarkdownToHtml } = await import("../../client/src/lib/markdown");

const checks: string[] = [];
function open(markdown: string) {
  const element = browser.document.createElement("div");
  browser.document.body.append(element);
  return new Editor({ element: element as unknown as HTMLElement, extensions: createRichDocumentExtensions(), content: markdown, contentType: "markdown" });
}
function nodeTypes(editor: InstanceType<typeof Editor>) {
  const types: string[] = [];
  editor.state.doc.descendants((node) => { types.push(node.type.name); });
  return types;
}
/** Saves, reopens and saves again, as a reload between two edits would. */
function reload(markdown: string) {
  const editor = open(markdown);
  const saved = editor.getMarkdown();
  const types = nodeTypes(editor);
  editor.destroy();
  const again = open(saved);
  assert.equal(again.getMarkdown(), saved, `Saving ${JSON.stringify(markdown)} twice must not change it again.`);
  again.destroy();
  return { saved, types };
}
function type(editor: InstanceType<typeof Editor>, text: string) {
  for (const character of text) {
    const { from, to } = editor.state.selection;
    const handled = editor.view.someProp("handleTextInput", (handler) => handler(editor.view, from, to, character, () => editor.state.tr.insertText(character, from, to)));
    if (!handled) editor.view.dispatch(editor.state.tr.insertText(character, from, to));
  }
}

// Typed wiki links become link nodes and are saved as written, not as escaped brackets.
{
  const editor = open("");
  type(editor, "See [[Project plan|the plan]] and [[Notes]]");
  const saved = editor.getMarkdown();
  assert.equal(saved, "See [[Project plan|the plan]] and [[Notes]]");
  assert.equal(nodeTypes(editor).filter((name) => name === "wikiLink").length, 2);
  const link = editor.view.dom.querySelector(".obsidian-wikilink");
  assert.equal(link?.textContent, "the plan");
  assert.equal(link?.getAttribute("data-note-target"), "Project plan");
  assert.equal(getRichDocumentFallbackReason(saved), null, "A block with a wiki link stays in the rich editor.");
  editor.destroy();
  checks.push("typed wiki links are saved as wiki links");
}

// Pasted plain text with a wiki link becomes a link node too.
{
  const editor = open("");
  editor.view.pasteText("Read [[Reading list]] first");
  assert.equal(editor.getMarkdown(), "Read [[Reading list]] first");
  assert(nodeTypes(editor).includes("wikiLink"));
  editor.destroy();
  checks.push("pasted wiki links are saved as wiki links");
}

// Brackets typed as text never come back as display math.
for (const text of ["see [1] and [2]", "array[i]", "[x]", "[^1]", "[[unfinished", "> [!note] x"]) {
  const editor = open("");
  editor.commands.insertContent({ type: "text", text });
  const { saved, types } = reload(editor.getMarkdown());
  editor.destroy();
  assert(!types.includes("blockMath") && !types.includes("inlineMath"), `${JSON.stringify(text)} reopened as math: ${saved}`);
  assert.doesNotMatch(renderObsidianMarkdownToHtml(saved), /document-math/, `${JSON.stringify(text)} renders as math: ${saved}`);
}
checks.push("typed brackets stay text after reload");

// Documents saved before this fix wrote [[Title]] as \[\[Title\]\]; they reopen as links.
{
  const { saved, types } = reload(String.raw`See \[\[my\_note|alias\]\] here`);
  assert.equal(saved, "See [[my_note|alias]] here");
  assert(types.includes("wikiLink") && !types.includes("blockMath"));
  assert.doesNotMatch(renderObsidianMarkdownToHtml(String.raw`\[\[Title\]\]`), /document-math/);
  checks.push("escaped wiki links from older saves are repaired");
}

// Literal dollars stay literal; real equations stay equations.
{
  const editor = open("");
  editor.commands.insertContent({ type: "text", text: "costs $x$ dollars" });
  const { saved, types } = reload(editor.getMarkdown());
  editor.destroy();
  assert.equal(saved, String.raw`costs \$x\$ dollars`);
  assert(!types.includes("inlineMath"));
  assert.equal(reload("Prices are $5 and $10.").saved, "Prices are $5 and $10.");
  assert(reload("Inline $E=mc^2$ ok").types.includes("inlineMath"));
  assert(reload(String.raw`\[ x^2 \]`).types.includes("blockMath"));
  assert(reload("Before\n\n\\[\n\\sum_i i\n\\]").types.includes("blockMath"));
  checks.push("dollar signs and equations keep their meaning");
}

// Display math only opens at the start of a line, so it never splits a paragraph.
{
  const { types } = reload(String.raw`Text \[x\] more`);
  assert.deepEqual(types.filter((name) => name !== "text"), ["paragraph"]);
  checks.push("mid-line brackets do not split paragraphs");
}

// A pipe inside a table cell stays inside that cell.
{
  const { saved } = reload("| a | b\\|c |\n| --- | --- |\n| `x\\|y` | 2 |");
  assert.match(saved, /b\\\|c/);
  assert.match(saved, /`x\\\|y`/);
  const editor = open(saved);
  const cells = [...editor.view.dom.querySelectorAll("th, td")].map((cell) => cell.textContent);
  editor.destroy();
  assert.deepEqual(cells, ["a", "b|c", "x|y", "2"]);
  checks.push("table cells keep escaped pipes");
}

// Link text still escapes closing brackets.
assert.equal(reload(String.raw`[a\]b](https://example.com)`).saved, String.raw`[a\]b](https://example.com)`);
checks.push("link text keeps escaped brackets");

console.log(JSON.stringify({ checks }));
