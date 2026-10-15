import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { DocumentBlock } from "../../client/src/lib/editableDocument";

const browser = new Window({ url: "http://live-document.test" });
for (const name of ["window", "Window", "document", "navigator", "localStorage", "HTMLElement", "Element", "Node", "Text", "Document", "DocumentFragment", "MutationObserver", "ResizeObserver", "Event", "MouseEvent", "KeyboardEvent", "Range", "DOMRect", "DOMParser", "ShadowRoot", "getComputedStyle", "HTMLInputElement", "HTMLTextAreaElement"]) {
  const value = name === "window" ? browser : name === "Window" ? Window : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value: name === "getComputedStyle" ? value.bind(browser) : value });
}
// Layout measurement has no screen here; these checks cover the editor's transactions and saved blocks.
browser.requestAnimationFrame = () => 1;
browser.cancelAnimationFrame = () => undefined;
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: browser.requestAnimationFrame });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: browser.cancelAnimationFrame });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { EditorView, runScopeHandlers } = await import("@codemirror/view");
const { EditorSelection } = await import("@codemirror/state");
const { default: LiveDocumentEditor } = await import("../../client/src/components/LiveDocumentEditor");

const now = "2026-10-15T00:00:00.000Z";
const block = (id: string, content: string, extra: Partial<DocumentBlock> = {}): DocumentBlock => ({ id, kind: "markdown", content, createdAt: now, updatedAt: now, authorship: "user", ...extra });
let latest: DocumentBlock[] = [
  block("intro", "# Plan"),
  block("body", "Some **bold** words and a [[Link]]."),
  block("answer", "An answer from the AI.", { authorship: "ai" }),
];
const changes: DocumentBlock[][] = [];
const selections: any[] = [];
const invocations: any[] = [];
let setBlocks!: (blocks: DocumentBlock[]) => void;

function Host() {
  const [blocks, update] = useState(latest);
  setBlocks = (next) => { latest = next; update(next); };
  return createElement(LiveDocumentEditor, {
    conversationId: "doc", blocks,
    decorations: { body: [{ from: 5, to: 13, branchIds: ["branch-1"], noteIds: [] }] },
    onChangeBlocks(next: DocumentBlock[]) { changes.push(next); latest = next; update(next); },
    onSelectionChange(selection: any) { selections.push(selection); },
    onInvokeAI(invocation: any) { invocations.push(invocation); },
    renderAfterBlock: (item: DocumentBlock) => item.id === "answer" ? createElement("span", { className: "after-probe" }, "after answer") : null,
  });
}

const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
await act(async () => { root.render(createElement(Host)); });
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });

const content = container.querySelector(".cm-content") as HTMLElement;
assert.ok(content, "the Live Preview editor mounts");
const view = EditorView.findFromDOM(content)!;
assert.ok(view);
const text = () => view.state.doc.toString();
assert.equal(text(), "# Plan\n\nSome **bold** words and a [[Link]].\n\nAn answer from the AI.\n\n", "the editor holds the Markdown file plus a blank line for typing");

// Blocks keep the attributes the margin, outline and search use.
const lines = [...container.querySelectorAll(".cm-line[data-document-block-id]")].map((line) => line.getAttribute("data-document-block-id"));
assert.deepEqual(lines.slice(0, 3), ["intro", "body", "answer"]);
assert.equal(container.querySelector('[data-document-block-id="answer"]')?.getAttribute("data-authorship"), "ai");
assert.ok(container.querySelector('.message-anchor[data-annotation-branches]'), "saved passages show as highlights");
assert.equal(container.querySelector(".after-probe")?.textContent, "after answer", "content after a block renders beneath it");
// Syntax is hidden away from the cursor.
assert.ok(container.querySelector(".cm-lp-heading"), "headings are styled");
assert.ok(!container.querySelector(".cm-line")?.textContent?.includes("#"), "heading marks are hidden off the active line");

function key(name: string, options: KeyboardEventInit = {}) {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...options });
  return act(async () => { runScopeHandlers(view, event as any, "editor"); });
}
async function type(value: string) {
  await act(async () => {
    const { from, to } = view.state.selection.main;
    const handled = view.state.facet(EditorView.inputHandler).some((handler) => handler(view, from, to, value, () => view.state.update({ changes: { from, to, insert: value } })));
    if (!handled) view.dispatch({ changes: { from, to, insert: value }, selection: { anchor: from + value.length }, userEvent: "input.type" });
  });
}
async function select(anchor: number, head = anchor) {
  await act(async () => { view.focus(); view.dispatch({ selection: EditorSelection.single(anchor, head) }); });
}

// Typing in a block changes only that block.
const bodyStart = text().indexOf("Some");
await select(bodyStart + 4);
await type(" more");
assert.equal(latest[1].id, "body");
assert.equal(latest[1].content, "Some more **bold** words and a [[Link]].");
assert.equal(latest[0], changes.at(-1)![0], "untouched blocks keep their objects");

// Enter splits a block; the new line keeps the original's provenance.
const answerStart = text().indexOf("An answer");
await select(answerStart + "An answer".length);
await key("Enter");
const answerIndex = latest.findIndex((item) => item.id === "answer");
assert.equal(latest[answerIndex].content, "An answer");
assert.equal(latest[answerIndex + 1].content, " from the AI.");
assert.notEqual(latest[answerIndex + 1].id, "answer");
assert.equal(text().slice(answerStart, answerStart + 24), "An answer\n\n from the AI.", "a new block is a new paragraph in the file");

// Backspace at the start of a block joins it to the one before.
const splitStart = text().indexOf(" from the AI.");
await select(splitStart);
await key("Backspace");
assert.equal(latest.find((item) => item.id === "answer")?.content, "An answer from the AI.");
assert.equal(latest.length, 3);

// Selecting a passage reports Markdown offsets in its block.
const selectionStart = text().indexOf("**bold**");
await select(selectionStart, selectionStart + 8);
const reported = selections.filter(Boolean).at(-1);
assert.equal(reported?.sourceBlockId, "body");
assert.equal(reported?.quote, "**bold**");
assert.equal(reported?.startOffset, "Some more ".length);
assert.equal(reported?.endOffset, "Some more **bold**".length);

// A passage across two blocks is reported in the blocks joined with a blank line.
const crossFrom = text().indexOf("Plan");
const crossTo = text().indexOf("more");
await select(crossFrom, crossTo);
const cross = selections.filter(Boolean).at(-1);
assert.equal(cross?.sourceBlockId, "intro");
assert.deepEqual(cross?.joinBlockIds, ["body"]);
assert.equal(cross?.quote, "Plan\n\nSome ");

// Space on the empty line asks AI there.
const draftStart = text().length;
await select(draftStart);
await type(" ");
assert.equal(invocations.length, 1, "Space on an empty line opens Ask AI");
assert.equal(invocations[0].markdown, "");
assert.ok(latest.some((item) => item.id === invocations[0].blockId), "the empty line is saved before AI writes there");

// Changes from outside (another tab, AI streaming) update the editor without becoming edits.
const outsideCount = changes.length;
await act(async () => { setBlocks(latest.map((item) => item.id === "intro" ? { ...item, content: "# Plan for Q4" } : item)); });
assert.ok(text().startsWith("# Plan for Q4\n\n"));
assert.equal(changes.length, outsideCount, "outside updates are not saved back as edits");

// ⌘E switches to Reading, which can't be edited.
await key("e", { ctrlKey: true });
assert.equal(container.querySelector(".live-document-editor")?.getAttribute("data-mode"), "reading");
assert.equal(view.state.readOnly, true);

await act(async () => { root.unmount(); });
console.log("live document editor ok");
process.exit(0);
