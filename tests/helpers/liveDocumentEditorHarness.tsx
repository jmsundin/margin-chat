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
const caretMenus: any[] = [];
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
    onCaretMenu(menu: any) { caretMenus.push(menu); },
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

// A click past a line's end that lands in the hidden blank line after it stays on that line;
// the keyboard moving forward goes on to the next line.
const introEnd = text().indexOf("\n\n");
await act(async () => { view.focus(); view.dispatch({ selection: EditorSelection.cursor(introEnd + 1), userEvent: "select.pointer" }); });
assert.equal(view.state.selection.main.head, introEnd, "a click in the hidden gap puts the caret at the end of the line above");
await act(async () => { view.dispatch({ selection: EditorSelection.cursor(introEnd + 1), userEvent: "select" }); });
assert.equal(view.state.selection.main.head, introEnd + 2, "moving right through the gap reaches the next line");
await act(async () => { view.dispatch({ selection: EditorSelection.cursor(introEnd + 1), userEvent: "select" }); });
assert.equal(view.state.selection.main.head, introEnd, "moving left through the gap reaches the line above");

// Shift+Enter at the end of a line breaks it inside the same block; Enter on that empty line starts a new block instead.
await select(text().indexOf("# Plan") + "# Plan".length);
await key("Enter", { shiftKey: true });
await type("x");
assert.equal(latest[0].content, "# Plan\nx", "a line break typed at a block's end stays in that block");
await key("Enter", { shiftKey: true });
await key("Enter");
assert.equal(latest[0].content, "# Plan\nx", "Enter on the empty broken line leaves no blank line behind");
assert.equal(latest[1].content, "", "and starts a new line");
await key("Backspace");
await key("Backspace");
await key("Backspace");
assert.equal(latest[0].content, "# Plan", "the line break and its text delete again");

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

// Alt+Enter at the caret opens the action menu on the paragraph around it; Select there selects that paragraph.
const menuAt = text().indexOf("words");
await select(menuAt);
await key("Enter", { altKey: true });
assert.equal(caretMenus.length, 1, "Alt+Enter with nothing selected opens the caret menu");
assert.equal(caretMenus[0].paragraph?.sourceBlockId, "body");
assert.equal(caretMenus[0].paragraph?.startOffset, 0);
assert.equal(caretMenus[0].paragraph?.quote, latest.find((item) => item.id === "body")?.content, "the menu's paragraph is the whole block's Markdown");
await act(async () => { caretMenus[0].selectParagraph(); });
const paragraphSelection = selections.filter(Boolean).at(-1);
assert.equal(paragraphSelection?.sourceBlockId, "body");
assert.equal(paragraphSelection?.startOffset, 0, "Select picks the paragraph from its start");
await select(menuAt, menuAt + 3);
await key("Enter", { altKey: true });
assert.equal(caretMenus.length, 1, "Alt+Enter with text selected leaves the selection toolbar to it");

// Space on the empty line asks AI there.
const draftStart = text().length;
await select(draftStart);
await type(" ");
assert.equal(invocations.length, 1, "Space on an empty line opens Ask AI");
assert.equal(invocations[0].markdown, "");
assert.ok(latest.some((item) => item.id === invocations[0].blockId), "the empty line is saved before AI writes there");

// Closing Ask AI keeps only the next Space plain; Space on another empty line still opens it.
await act(async () => { invocations[0].restoreFocus(); });
await type(" ");
assert.equal(invocations.length, 1, "the first Space after closing Ask AI types a space");
await act(async () => { setBlocks([...latest, block("list", "- one\n\n- two")]); });
await select(text().indexOf("- one") + "- one\n".length);
await type(" ");
assert.equal(invocations.length, 2, "Space on a blank line inside a list opens Ask AI, even right after closing it");

// Changes from outside (another tab, AI streaming) update the editor without becoming edits.
const outsideCount = changes.length;
await act(async () => { setBlocks(latest.map((item) => item.id === "intro" ? { ...item, content: "# Plan for Q4" } : item)); });
assert.ok(text().startsWith("# Plan for Q4\n\n"));
assert.equal(changes.length, outsideCount, "outside updates are not saved back as edits");

// An AI answer mid-stream with a code fence it hasn't closed yet keeps Live Preview on, then and after.
const styled = () => !!container.querySelector(".cm-lp-strong") && !container.querySelector(".cm-content")?.textContent?.includes("**");
assert.ok(styled(), "bold is styled before streaming");
await act(async () => { setBlocks([...latest, block("streaming", "```python\ndef shard_for(user_id):", { authorship: "ai" })]); });
assert.ok(styled(), "an open code fence doesn't turn Live Preview off");
await act(async () => { setBlocks(latest.map((item) => item.id === "streaming" ? { ...item, content: "```python\ndef shard_for(user_id):\n    return 0\n```" } : item)); });
assert.ok(styled(), "Live Preview stays on once the answer finishes");
await act(async () => { setBlocks([...latest, block("math", "Pick a shard:\n$$\nhash(k) \\bmod N\n$$", { authorship: "ai" })]); });
assert.ok(styled(), "display math written over several lines doesn't break Live Preview");

// ⌘E switches to Reading, which can't be edited.
await key("e", { ctrlKey: true });
assert.equal(container.querySelector(".live-document-editor")?.getAttribute("data-mode"), "reading");
assert.equal(view.state.readOnly, true);

await act(async () => { root.unmount(); });
console.log("live document editor ok");
process.exit(0);
