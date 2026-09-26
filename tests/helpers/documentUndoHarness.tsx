import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { Conversation } from "../../client/src/types";

const browser = new Window({ url: "http://document-undo.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Text", "Document", "DocumentFragment", "MutationObserver", "ResizeObserver", "Event", "MouseEvent", "KeyboardEvent", "Range", "DOMRect", "DOMParser", "getComputedStyle", "HTMLInputElement", "HTMLTextAreaElement", "ShadowRoot"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value: name === "getComputedStyle" ? value.bind(browser) : value });
}
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: clearTimeout });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: DocumentPanel } = await import("../../client/src/components/DocumentPanel");
const { createMainConversation } = await import("../../client/src/initialState");
const { getEditableDocument } = await import("../../client/src/lib/editableDocument");
const date = "2026-09-25T00:00:00.000Z";
const checks: string[] = [];
let latest: Record<string, Conversation> = {};
let replace: (id: string, conversation: Conversation) => void;
let scenario = 0;

function conversation(id: string, contents: string[]): Conversation {
  const value = createMainConversation({ id, createdAt: date });
  value.title = `Document ${id}`;
  value.document = { ...getEditableDocument(value), blocks: contents.map((content, index) => ({
    id: `${id}-${index}`, kind: "markdown", content, createdAt: date, updatedAt: date,
  })) };
  return value;
}

function Host({ initial }: { initial: Conversation[] }) {
  const [conversations, setConversations] = useState(Object.fromEntries(initial.map((value) => [value.id, value])));
  latest = conversations;
  replace = (id, value) => setConversations((current) => ({ ...current, [id]: value }));
  return createElement("div", null, Object.values(conversations).map((value) => createElement("div", { key: value.id, "data-test-document": value.id }, createElement(DocumentPanel, {
    conversation: value, isActive: true, isSubmitting: false, aiControls: null, recentModelSelections: [], anchors: [], theme: "light",
    onChange: (document) => setConversations((current) => ({ ...current, [value.id]: { ...current[value.id], document } })),
    onRename: (title) => setConversations((current) => ({ ...current, [value.id]: { ...current[value.id], title } })),
    onSubmit() {}, onStop() {}, onSelection() {}, onClearSelection() {}, onOpenBranch() {}, onOpenNote() {}, onModelChange() {},
    onUpload() {}, onRemoveAttachment() {}, onAcceptVersion() {}, onUndoInsertion() {}, registerPanelRef() {}, registerAnchorRef() {}, registerBranchOriginRef() {},
  }))));
}

const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
function element(selector: string): any { const found = container.querySelector(selector); assert(found, `Missing ${selector}`); return found; }
function block(id: string): any { return element(`[data-document-block-id="${id}"]`); }
function editor(id: string): any { const found = block(id).querySelector(".tiptap"); assert(found, `Missing editor ${id}`); return found.editor; }
function contents(id: string) { return latest[id].document!.blocks.map((value) => value.content); }
function ids(id: string) { return latest[id].document!.blocks.map((value) => value.id); }
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }); }
async function mount(...values: Conversation[]) { await act(async () => root.render(createElement(Host, { key: ++scenario, initial: values }))); await settle(); }
async function click(node: any) { await act(async () => node.click()); await settle(); }
async function focus(id: string, position: number | "end" = "end") {
  await act(async () => { editor(id).commands.focus(); editor(id).commands.setTextSelection(position === "end" ? editor(id).state.doc.content.size - 1 : position); });
  await settle();
}
async function key(node: any, name: string, options: Record<string, boolean> = {}) {
  const event = new browser.KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true, ...options });
  await act(async () => node.dispatchEvent(event));
  await settle();
  return event;
}
async function undo(id: string, modifier: "metaKey" | "ctrlKey" = "metaKey") { return key(editor(id).view.dom, "z", { [modifier]: true }); }
async function redo(id: string, modifier: "metaKey" | "ctrlKey" = "metaKey") { return key(editor(id).view.dom, "z", { [modifier]: true, shiftKey: true }); }
async function type(id: string, text: string) { await focus(id); await act(async () => editor(id).commands.insertContent(text)); await settle(); }
async function toolbar(id: string) { await click(block(id).querySelector(".rich-document-grip")); }
function textButton(id: string, text: string): any {
  const found = [...block(id).querySelectorAll("button")].find((candidate: any) => candidate.textContent.trim() === text);
  assert(found, `Missing ${text} in ${id}`); return found;
}
async function fill(node: any, value: string) {
  await act(async () => {
    node.focus();
    Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  await settle();
}

try {
  await mount(conversation("typing", ["Start end"]));
  await focus("typing-0", 7);
  for (const character of ["m", "i", "d", " "]) {
    await act(async () => editor("typing-0").commands.insertContent(character));
    await settle();
  }
  assert.deepEqual(contents("typing"), ["Start mid end"]);
  assert.equal(editor("typing-0").state.selection.from, 11);
  await undo("typing-0");
  assert.deepEqual(contents("typing"), ["Start end"], "Consecutive characters form one typing undo step.");
  assert.equal(editor("typing-0").state.selection.from, 7, "Undo restores the caret before the first inserted character.");
  assert.equal(editor("typing-0").state.selection.to, 7);
  await redo("typing-0");
  assert.deepEqual(contents("typing"), ["Start mid end"]);
  assert.equal(editor("typing-0").state.selection.from, 11, "Redo restores the caret after the final inserted character.");
  await focus("typing-0", 2);
  await act(async () => editor("typing-0").commands.insertContent("!"));
  await undo("typing-0");
  assert.deepEqual(contents("typing"), ["Start mid end"], "Moving the caret begins a separate typing step.");
  assert.equal(editor("typing-0").state.selection.from, 2);
  checks.push("consecutive typing groups into one undo step and restores the caret at both ends of history");

  const blank = createMainConversation({ id: "blank", createdAt: date });
  await mount(blank);
  const blankId = getEditableDocument(blank).blocks[0].id;
  await focus(blankId);
  for (const character of ["a", "b", "c"]) {
    await act(async () => editor(blankId).commands.insertContent(character));
    await settle();
  }
  assert.deepEqual(contents("blank"), ["abc"]);
  await undo(blankId);
  assert.deepEqual(contents("blank"), [""]);
  assert(browser.document.activeElement === editor(blankId).view.dom, "Undoing first typing keeps focus in the blank editor.");
  assert.equal(editor(blankId).state.selection.from, 1);
  await redo(blankId);
  assert.deepEqual(contents("blank"), ["abc"]);
  assert(browser.document.activeElement === editor(blankId).view.dom, "Redoing first typing keeps focus in the restored editor.");
  assert.equal(editor(blankId).state.selection.from, 4);
  checks.push("first typing in a new document can be undone to blank and redone with the caret restored");

  await mount(conversation("continuation", ["Existing paragraph"]));
  const continuationDraft = element('[data-test-document="continuation"] .rich-document-editor').querySelectorAll("[data-document-block-id]");
  const draftId = continuationDraft[continuationDraft.length - 1].getAttribute("data-document-block-id");
  await focus(draftId);
  await act(async () => editor(draftId).commands.insertContent("a"));
  await settle();
  const materializedId = ids("continuation")[1];
  await act(async () => editor(materializedId).commands.insertContent("b"));
  await settle();
  assert.deepEqual(contents("continuation"), ["Existing paragraph", "ab"]);
  await undo(materializedId);
  assert.deepEqual(contents("continuation"), ["Existing paragraph"], "Undo removes the newly materialized continuation block.");
  const restoredDraft = browser.document.activeElement as any;
  assert(restoredDraft?.classList.contains("tiptap"), "Undoing first draft input keeps focus in an editor.");
  assert.equal(restoredDraft.editor.getText(), "");
  assert.equal(restoredDraft.editor.state.selection.from, 1);
  await key(restoredDraft, "z", { metaKey: true, shiftKey: true });
  assert.deepEqual(contents("continuation"), ["Existing paragraph", "ab"]);
  assert(browser.document.activeElement === editor(materializedId).view.dom, "Redoing draft input restores focus in the materialized editor.");
  assert.equal(editor(materializedId).state.selection.from, 3);
  checks.push("draft continuation materialization undoes and redoes as one step with focus on the correct block");

  await mount(conversation("format", ["Hello"]));
  await type("format-0", " world");
  await act(async () => { editor("format-0").commands.setTextSelection({ from: 7, to: 12 }); });
  await toolbar("format-0");
  await click(block("format-0").querySelector('[aria-label="Bold"]'));
  assert.equal(contents("format")[0], "Hello **world**");
  assert.equal((await undo("format-0", "ctrlKey")).defaultPrevented, true);
  assert.deepEqual(contents("format"), ["Hello world"], "Formatting is a separate undo step from typing.");
  await undo("format-0", "ctrlKey");
  assert.deepEqual(contents("format"), ["Hello"]);
  await redo("format-0", "ctrlKey");
  assert.deepEqual(contents("format"), ["Hello world"]);
  await redo("format-0", "ctrlKey");
  assert.deepEqual(contents("format"), ["Hello **world**"]);
  checks.push("Control+Z and Control+Shift+Z traverse typing and formatting as separate steps");

  await mount(conversation("split", ["Alpha beta"]));
  await type("split-0", " gamma");
  await focus("split-0", 7);
  await key(editor("split-0").view.dom, "Enter");
  assert.equal(latest.split.document!.blocks.length, 2);
  const splitIds = ids("split");
  await undo(splitIds[1]);
  assert.deepEqual(contents("split"), ["Alpha beta gamma"]);
  assert(browser.document.activeElement === editor("split-0").view.dom, "Undoing a split restores focus to the original block.");
  assert.equal(editor("split-0").state.selection.from, 7, "Undoing a split restores the original caret position.");
  await redo("split-0");
  assert.deepEqual(ids("split"), splitIds, "Redo restores the original split block identities.");
  assert.deepEqual(contents("split").map((text) => text.trim()), ["Alpha", "beta gamma"]);
  assert(browser.document.activeElement === editor(splitIds[1]).view.dom, "Redoing a split restores editable focus in the new block.");
  await key(browser.document.activeElement, "z", { metaKey: true });
  await key(browser.document.activeElement, "z", { metaKey: true });
  assert.deepEqual(contents("split"), ["Alpha beta"], "Repeated undo from restored focus can traverse the split and earlier typing.");
  assert(browser.document.activeElement === editor("split-0").view.dom);
  checks.push("Command+Z reverses Enter splits and Command+Shift+Z restores them with editor focus");

  await mount(conversation("delete", ["Keep this", "", "Keep this too"]));
  await focus("delete-1");
  await key(editor("delete-1").view.dom, "Backspace");
  assert.deepEqual(ids("delete"), ["delete-0", "delete-2"]);
  await undo("delete-0");
  assert.deepEqual(ids("delete"), ["delete-0", "delete-1", "delete-2"]);
  assert.deepEqual(contents("delete"), ["Keep this", "", "Keep this too"]);
  await redo("delete-1");
  assert.deepEqual(ids("delete"), ["delete-0", "delete-2"]);
  checks.push("empty-block deletion can be undone and redone without changing neighboring text");

  await mount(conversation("reorder", ["First", "Second", "Third"]));
  await toolbar("reorder-1");
  await click(block("reorder-1").querySelector('[aria-label="Move block up"]'));
  assert.deepEqual(contents("reorder"), ["Second", "First", "Third"]);
  await undo("reorder-1");
  assert.deepEqual(contents("reorder"), ["First", "Second", "Third"]);
  await redo("reorder-1");
  assert.deepEqual(contents("reorder"), ["Second", "First", "Third"]);
  checks.push("block reorder actions participate in the same document undo history");

  await mount(conversation("source", ["Original"]));
  await toolbar("source-0");
  await click(textButton("source-0", "Edit Markdown"));
  const source = element('textarea[aria-label="Markdown for block 1"]');
  await fill(source, "# Revised source");
  assert.deepEqual(contents("source"), ["# Revised source"]);
  await key(source, "z", { metaKey: true });
  assert.deepEqual(contents("source"), ["Original"]);
  assert.equal(source.value, "Original");
  await key(source, "z", { metaKey: true, shiftKey: true });
  assert.deepEqual(contents("source"), ["# Revised source"]);
  await key(source, "z", { ctrlKey: true });
  await fill(source, "A new direction");
  await key(source, "z", { ctrlKey: true, shiftKey: true });
  assert.deepEqual(contents("source"), ["A new direction"], "Editing after undo discards the abandoned redo branch.");
  checks.push("Markdown source has undo and redo, and new edits discard stale redo history");

  await mount(conversation("left", ["Left"]), conversation("right", ["Right"]));
  await type("left-0", " edit");
  await type("right-0", " edit");
  await undo("left-0");
  assert.deepEqual(contents("left"), ["Left"]);
  assert.deepEqual(contents("right"), ["Right edit"]);
  await undo("right-0");
  await redo("left-0");
  assert.deepEqual(contents("left"), ["Left edit"]);
  assert.deepEqual(contents("right"), ["Right"]);
  checks.push("simultaneously open documents maintain independent undo and redo histories");

  await mount(conversation("inputs", ["Body", ""]));
  await type("inputs-0", " edit");
  const title = element('[aria-label="Document title"]');
  await act(async () => title.focus());
  assert.equal((await key(title, "z", { metaKey: true })).defaultPrevented, false, "Title input keeps its native editing shortcut.");
  await focus("inputs-1");
  await key(editor("inputs-1").view.dom, " ");
  const prompt = element('textarea[aria-label="AI prompt"]');
  assert.equal((await key(prompt, "z", { ctrlKey: true })).defaultPrevented, false, "AI prompt keeps its own editing shortcut.");
  await click(element('[aria-label="Close AI prompt"]'));
  await toolbar("inputs-0");
  await click(textButton("inputs-0", "Link"));
  const link = element('[aria-label="Link address"]');
  assert.equal((await key(link, "z", { metaKey: true, shiftKey: true })).defaultPrevented, false, "Link input keeps its own editing shortcut.");
  assert.deepEqual(contents("inputs"), ["Body edit", ""]);
  await undo("inputs-0");
  assert.deepEqual(contents("inputs"), ["Body", ""], "Input shortcuts do not consume document history.");
  checks.push("title, AI prompt, and link fields retain native shortcuts without undoing the document");

  await mount(conversation("external", ["Original"]));
  await type("external-0", " edit");
  const metadata = { id: "new-prompt", content: "A saved prompt", createdAt: date, serviceId: latest.external.serviceId, modelId: latest.external.modelId };
  await act(async () => replace("external", { ...latest.external, title: "Renamed elsewhere", document: { ...latest.external.document!, prompts: [...latest.external.document!.prompts, metadata] } }));
  await undo("external-0");
  assert.deepEqual(contents("external"), ["Original"], "Unrelated metadata changes preserve authored-edit history.");
  assert.equal(latest.external.title, "Renamed elsewhere");
  assert.equal(latest.external.document!.prompts.at(-1)?.id, "new-prompt", "Undo does not revert newly saved generation metadata.");
  await redo("external-0");
  await act(async () => replace("external", { ...latest.external, document: { ...latest.external.document!, blocks: latest.external.document!.blocks.map((value) => ({ ...value, content: "Updated externally" })) } }));
  await undo("external-0");
  assert.deepEqual(contents("external"), ["Updated externally"], "External block replacements invalidate stale document history.");
  checks.push("metadata updates survive undo while external block replacements safely invalidate history");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
