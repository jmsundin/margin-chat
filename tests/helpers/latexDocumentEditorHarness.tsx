import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { DocumentBlock } from "@margin-chat/workspace-contracts";

const browser = new Window({ url: "http://latex-document.test" });
browser.document.write("<!doctype html><html><head></head><body></body></html>");
// happy-dom does not expose compatMode; KaTeX requires a standards-mode document.
Object.defineProperty(browser.document, "compatMode", { value: "CSS1Compat" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Text", "Document", "DocumentFragment", "MutationObserver", "ResizeObserver", "Event", "MouseEvent", "KeyboardEvent", "Range", "DOMRect", "DOMParser", "getComputedStyle", "HTMLInputElement", "HTMLTextAreaElement", "HTMLSelectElement", "ShadowRoot"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value: name === "getComputedStyle" ? value.bind(browser) : value });
}
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: clearTimeout });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { Editor } = await import("@tiptap/core");
const { default: RichDocumentEditor, createRichDocumentExtensions } = await import("../../client/src/components/RichDocumentEditor");
const { getRichDocumentFallbackReason } = await import("../../client/src/lib/richDocumentMarkdown");
const { default: DocumentPanel } = await import("../../client/src/components/DocumentPanel");
const { createMainConversation } = await import("../../client/src/initialState");
const { getEditableDocument } = await import("../../client/src/lib/editableDocument");

const date = "2026-09-25T00:00:00.000Z";
const checks: string[] = [];
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const updates: string[] = [];
let latest: DocumentBlock[] = [];
let scenario = 0;
let replaceSource: (source: string) => void;

function Host({ source, readOnly = false }: { source: string; readOnly?: boolean }) {
  const [blocks, setBlocks] = useState<DocumentBlock[]>([{ id: "math", kind: "markdown", content: source, createdAt: date, updatedAt: date }]);
  latest = blocks;
  replaceSource = (content) => setBlocks((items) => items.map((item) => item.id === "math" ? { ...item, content } : item));
  return createElement(RichDocumentEditor, {
    conversationId: "equations", blocks, readOnlyBlockIds: readOnly ? ["math"] : [],
    onUpdateBlock(id: string, markdown: string) {
      updates.push(markdown);
      setBlocks((items) => items.map((item) => item.id === id ? { ...item, content: markdown } : item));
    },
  });
}

function PanelHost() {
  const [conversation, setConversation] = useState(() => {
    const value = createMainConversation({ id: "equation-history", createdAt: date });
    return { ...value, document: { ...getEditableDocument(value), blocks: [{ id: "math", kind: "markdown" as const, content: "Original $x^2$", createdAt: date, updatedAt: date }] } };
  });
  latest = conversation.document.blocks;
  return createElement(DocumentPanel, {
    conversation, isActive: true, isSubmitting: false, aiControls: null, recentModelSelections: [], anchors: [], theme: "light",
    onChange: (document) => setConversation((current) => ({ ...current, document })),
    onRename: (title) => setConversation((current) => ({ ...current, title })),
    onSubmit() {}, onStop() {}, onSelection() {}, onClearSelection() {}, onOpenBranch() {}, onOpenNote() {}, onModelChange() {},
    onUpload() {}, onRemoveAttachment() {}, onAcceptVersion() {}, onUndoInsertion() {}, registerPanelRef() {}, registerAnchorRef() {}, registerBranchOriginRef() {},
  });
}

function element(selector: string, parent: ParentNode = browser.document as unknown as Document): any {
  const found = parent.querySelector(selector); assert(found, `Missing ${selector}`); return found;
}
function block(): any { return element('[data-document-block-id="math"]', container as unknown as Element); }
function editor(): InstanceType<typeof Editor> { return element(".tiptap", block()).editor; }
function equation(parent: ParentNode = block()): any { return element('[data-type="inline-math"], [data-type="block-math"]', parent); }
function dialog(): any { return element('[role="dialog"]'); }
function button(label: string, parent: ParentNode = browser.document as unknown as Document): any {
  const found = [...parent.querySelectorAll("button")].find((node) => (node.getAttribute("aria-label") ?? node.textContent?.trim()) === label);
  assert(found, `Missing button ${label}`); return found;
}
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }); }
async function mount(source: string, readOnly = false) {
  await act(async () => root.render(createElement(Host, { key: ++scenario, source, readOnly })));
  await settle();
}
async function click(node: any) { await act(async () => node.click()); await settle(); }
async function key(node: any, name: string, options: Record<string, boolean> = {}) {
  const event = new browser.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...options });
  await act(async () => node.dispatchEvent(event)); await settle(); return event;
}
async function fill(value: string) {
  const field = element('textarea[aria-label="LaTeX equation"]', dialog());
  await act(async () => {
    field.focus();
    Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value")!.set!.call(field, value);
    field.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  await settle();
}
async function layout(label: "Inline" | "Display") {
  const select = element('select[aria-label="Equation layout"]', dialog());
  const option = [...select.options].find((node: any) => node.value === label.toLowerCase()) as any;
  assert(option, `Missing ${label} layout`);
  await act(async () => { select.value = option.value; select.dispatchEvent(new browser.Event("change", { bubbles: true })); });
  await settle();
}
async function openInsert() {
  await act(async () => { editor().commands.focus(); editor().commands.setTextSelection(editor().state.doc.content.size - 1); });
  await click(element(".rich-document-grip", block()));
  await click(button("Math", block()));
  assert.equal(dialog().getAttribute("aria-label"), "Insert equation");
}
async function typeText(text: string) {
  await act(async () => {
    for (const character of text) {
      const view = editor().view;
      const { from, to } = view.state.selection;
      // Exercise the actual input-rule handlers used by browser text input.
      const handled = view.someProp("handleTextInput", (handler) => handler(view, from, to, character, () => view.state.tr.insertText(character, from, to)));
      if (!handled) view.dispatch(view.state.tr.insertText(character, from, to));
    }
  });
  await settle();
}
function mathNodes(value: InstanceType<typeof Editor>) {
  const nodes: Array<{ type: string; latex: string }> = [];
  value.state.doc.descendants((node) => { if (node.type.name === "inlineMath" || node.type.name === "blockMath") nodes.push({ type: node.type.name, latex: node.attrs.latex }); });
  return nodes;
}

try {
  const source = String.raw`# Equations

Keep **bold** before $E = mc^2$ and *emphasis* after \(a^2 + b^2 = c^2\).

$$
\frac{1}{2} + \sum_{i=1}^{n} i
$$

\[
\int_0^1 x^2\,dx = \frac{1}{3}
\]`;
  const parsed = new Editor({ extensions: createRichDocumentExtensions(), content: source, contentType: "markdown" });
  try {
    assert.deepEqual(mathNodes(parsed).map((node) => node.type), ["inlineMath", "inlineMath", "blockMath", "blockMath"]);
    const reloaded = new Editor({ extensions: createRichDocumentExtensions(), content: parsed.getMarkdown(), contentType: "markdown" });
    try { assert.deepEqual(reloaded.getJSON(), parsed.getJSON(), "Saving and reopening preserves every equation, its layout, and surrounding formatting."); }
    finally { reloaded.destroy(); }
    assert.equal(getRichDocumentFallbackReason(source), null, "Supported math stays in the rich editor.");
  } finally { parsed.destroy(); }
  checks.push("inline and display dollar/backslash syntax roundtrips with surrounding Markdown");

  const writesBeforeMount = updates.length;
  await mount(source);
  assert.equal(block().querySelectorAll(".katex").length, 4, "All four source equations render math, not literal source.");
  assert.equal(updates.length, writesBeforeMount, "Rendering must not rewrite the original source.");
  assert.equal(latest[0].content, source);
  const formulasBefore = mathNodes(editor());
  await act(async () => {
    let boldPosition = -1;
    editor().state.doc.descendants((node, position) => { if (node.isText && node.text === "bold") boldPosition = position; });
    assert(boldPosition >= 0);
    editor().commands.setTextSelection({ from: boldPosition, to: boldPosition + 4 });
    editor().commands.toggleItalic();
  });
  assert.deepEqual(mathNodes(editor()), formulasBefore, "Formatting nearby text preserves equation attributes.");
  const editedReload = new Editor({ extensions: createRichDocumentExtensions(), content: latest[0].content, contentType: "markdown" });
  try { assert.deepEqual(editedReload.getJSON(), editor().getJSON()); } finally { editedReload.destroy(); }
  checks.push("rendering is lossless and surrounding formatting edits preserve every formula");

  await mount([
    String.raw`Prices are $5 and $10; escaped \$20 stays literal.`,
    "Inline code: `$x^2$`.",
    "```tex\n$y^2$\n\\[z\\]\n```",
  ].join("\n\n"));
  assert.equal(mathNodes(editor()).length, 0, "Currency, escaped dollars, and code must not become equations.");
  assert(editor().getText().includes("$5 and $10"));
  assert(block().querySelector("code")?.textContent?.includes("$x^2$"));
  checks.push("currency, escaped delimiters, and literal code remain ordinary text");

  await mount("");
  await typeText("Energy $E=mc^2$ remains inline.");
  assert.deepEqual(mathNodes(editor()), [{ type: "inlineMath", latex: "E=mc^2" }]);
  assert(editor().getText().includes("Energy "));
  assert(editor().getText().includes(" remains inline."));
  await mount("");
  await typeText(String.raw`$$\frac{a}{b}$$`);
  assert.deepEqual(mathNodes(editor()), [{ type: "blockMath", latex: String.raw`\frac{a}{b}` }]);
  assert.equal(editor().state.doc.firstChild?.type.name, "blockMath", "Typing display delimiters replaces the whole paragraph.");
  await mount("");
  await typeText(String.raw`\(\alpha + \beta\)`);
  assert.deepEqual(mathNodes(editor()), [{ type: "inlineMath", latex: String.raw`\alpha + \beta` }]);
  await mount("");
  await typeText(String.raw`\[\int_0^1 x\,dx\]`);
  assert.deepEqual(mathNodes(editor()), [{ type: "blockMath", latex: String.raw`\int_0^1 x\,dx` }]);
  await mount("");
  await act(async () => editor().commands.setCodeBlock());
  await typeText("$literal$ and $$code$$");
  assert.equal(mathNodes(editor()).length, 0, "Typing math-like syntax inside code stays literal.");
  checks.push("typing either delimiter style creates inline/display math while code input stays literal");

  await mount("Energy: ");
  const beforeInsert = latest[0].content;
  await openInsert();
  await fill(String.raw`E = mc^2`);
  assert.equal(element('select[aria-label="Equation layout"]', dialog()).value, "inline", "New equations default to inline without selecting a layout.");
  await click(button("Insert equation", dialog()));
  assert.equal(browser.document.querySelector('[role="dialog"]'), null);
  assert.equal(equation().getAttribute("data-type"), "inline-math");
  assert.equal(equation().getAttribute("data-latex"), "E = mc^2");
  assert(equation().querySelector(".katex"));
  const afterInsert = latest[0].content;
  assert(afterInsert.includes("$E = mc^2$"));
  await act(async () => { assert(editor().commands.undo()); });
  assert.equal(latest[0].content.trimEnd(), beforeInsert.trimEnd());
  assert.equal(mathNodes(editor()).length, 0);
  await act(async () => { assert(editor().commands.redo()); });
  assert.equal(latest[0].content, afterInsert);
  assert.equal(equation().getAttribute("data-latex"), "E = mc^2");
  checks.push("the Math toolbar inserts a rendered inline equation and participates in undo/redo");

  await click(equation());
  assert.equal(dialog().getAttribute("aria-label"), "Edit equation");
  assert.equal(element('textarea[aria-label="LaTeX equation"]', dialog()).value, "E = mc^2");
  await fill("x + y");
  await click(element('textarea[aria-label="LaTeX equation"]', dialog()));
  assert(dialog(), "Interacting inside the dialog keeps it open.");
  await click(button("Cancel", dialog()));
  assert.equal(latest[0].content, afterInsert);
  await click(equation());
  await fill("discarded");
  await click(browser.document.body);
  assert.equal(browser.document.querySelector('[role="dialog"]'), null, "Outside click dismisses the equation dialog.");
  assert.equal(latest[0].content, afterInsert);
  await click(equation());
  await fill("discarded again");
  await key(element('textarea[aria-label="LaTeX equation"]', dialog()), "Escape");
  assert.equal(browser.document.querySelector('[role="dialog"]'), null);
  assert.equal(latest[0].content, afterInsert);
  checks.push("equation cancellation, outside click, and Escape discard draft changes");

  await click(equation());
  await fill(String.raw`\frac{a}{b}`);
  await layout("Display");
  await click(button("Save equation", dialog()));
  assert.equal(equation().getAttribute("data-type"), "block-math");
  assert.equal(equation().getAttribute("data-latex"), String.raw`\frac{a}{b}`);
  assert(latest[0].content.includes("$$"));
  assert(latest[0].content.includes("Energy:"), "Changing layout keeps neighboring prose.");
  const afterEdit = latest[0].content;
  await act(async () => { assert(editor().commands.undo()); });
  assert.equal(latest[0].content, afterInsert, "Saving the equation is one reversible edit.");
  await act(async () => { assert(editor().commands.redo()); });
  assert.equal(latest[0].content, afterEdit);
  checks.push("existing equations can change both source and layout in one undoable edit");

  await key(equation(), "Enter");
  assert.equal(dialog().getAttribute("aria-label"), "Edit equation");
  await click(button("Cancel", dialog()));
  checks.push("rendered equations can be opened from the keyboard");

  await mount("Read only $x^2$", true);
  assert.equal(editor().isEditable, false);
  const beforeReadOnly = updates.length;
  await click(equation());
  await key(equation(), "Enter");
  assert.equal(browser.document.querySelector('[role="dialog"]'), null, "Streaming/read-only formulas cannot open editing controls.");
  assert.equal(updates.length, beforeReadOnly);
  checks.push("read-only equations render without allowing edits");

  await mount(String.raw`A malformed formula $\frac{1}{$ remains editable.

An unsafe link $\href{javascript:alert(1)}{click}$ is not trusted.`);
  assert.equal(mathNodes(editor()).length, 2, "Invalid LaTeX remains a recoverable equation node.");
  assert.equal(block().querySelector('a[href^="javascript:"]'), null);
  assert.equal(equation().getAttribute("data-latex"), String.raw`\frac{1}{`);
  await click(equation());
  assert.equal(element('textarea[aria-label="LaTeX equation"]', dialog()).value, String.raw`\frac{1}{`);
  await fill(String.raw`\frac{1}{2}`);
  await click(button("Save equation", dialog()));
  assert(equation().querySelector(".katex"), "A malformed equation can be corrected without reloading the document.");
  checks.push("invalid LaTeX stays editable and unsafe commands cannot create active links");

  for (const editing of [false, true]) {
    await mount(editing ? "Original $x^2$" : "Original prose");
    if (editing) await click(equation()); else await openInsert();
    await fill(String.raw`\frac{draft}{equation}`);
    const remoteSource = "Changed elsewhere $z^3$";
    await act(async () => replaceSource(remoteSource));
    await click(button(editing ? "Save equation" : "Insert equation", dialog()));
    assert.equal(latest[0].content, remoteSource, "Stale equation positions must never overwrite newer document content.");
    assert.equal(element('textarea[aria-label="LaTeX equation"]', dialog()).value, String.raw`\frac{draft}{equation}`, "The unsaved equation stays available to copy after a conflict.");
    assert(element('[role="alert"]', dialog()).textContent.includes("changed"));
    await click(button("Cancel", dialog()));
    assert.equal(latest[0].content, remoteSource);
    assert.equal(equation().getAttribute("data-latex"), "z^3");
  }
  checks.push("incoming document changes preserve new and edited equation drafts without applying stale offsets");

  await act(async () => root.render(createElement(PanelHost, { key: ++scenario })));
  await settle();
  await click(equation());
  await fill("y^3");
  await click(button("Save equation", dialog()));
  assert.equal(equation().getAttribute("data-latex"), "y^3");
  const revisedDocument = latest[0].content;
  assert.equal((await key(editor().view.dom, "z", { ctrlKey: true })).defaultPrevented, true);
  assert.equal(equation().getAttribute("data-latex"), "x^2");
  await key(editor().view.dom, "z", { ctrlKey: true, shiftKey: true });
  assert.equal(latest[0].content, revisedDocument);
  assert.equal(equation().getAttribute("data-latex"), "y^3");
  await click(equation());
  await key(element('textarea[aria-label="LaTeX equation"]', dialog()), "z", { metaKey: true });
  assert.equal(latest[0].content, revisedDocument, "Undo inside the equation draft must not undo the document behind the dialog.");
  const layoutSelect = element('select[aria-label="Equation layout"]', dialog());
  await act(async () => layoutSelect.focus());
  await key(layoutSelect, "z", { metaKey: true });
  assert.equal(latest[0].content, revisedDocument, "Undo while choosing equation layout must not reach document history.");
  const saveButton = button("Save equation", dialog());
  await act(async () => saveButton.focus());
  await key(saveButton, "z", { ctrlKey: true });
  assert.equal(latest[0].content, revisedDocument, "Undo while a dialog button is focused must not reach document history.");
  await click(button("Cancel", dialog()));
  await key(editor().view.dom, "z", { metaKey: true });
  assert.equal(equation().getAttribute("data-latex"), "x^2");
  await key(editor().view.dom, "z", { metaKey: true, shiftKey: true });
  assert.equal(equation().getAttribute("data-latex"), "y^3");
  checks.push("equation edits participate in document keyboard history while the draft keeps its own shortcuts");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
