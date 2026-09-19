import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://note-editor.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Text", "Document", "DocumentFragment", "MutationObserver", "ResizeObserver", "Event", "MouseEvent", "KeyboardEvent", "Range", "DOMRect", "getComputedStyle"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value: typeof value === "function" && name === "getComputedStyle" ? value.bind(browser) : value });
}
// This fixture checks actual editor transactions; layout measurement has no screen to measure.
browser.requestAnimationFrame = () => 1;
browser.cancelAnimationFrame = () => undefined;
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: browser.requestAnimationFrame });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: browser.cancelAnimationFrame });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, useState } = await import("../../client/node_modules/react/index.js");
const { createRoot } = await import("../../client/node_modules/react-dom/client.js");
const { EditorView } = await import("@codemirror/view");
const { default: StandaloneNotePanel } = await import("../../client/src/components/StandaloneNotePanel");
const { default: MarginNoteTreeNode } = await import("../../client/src/components/MarginNoteTreeNode");
const { createStandaloneNoteConversation } = await import("../../client/src/initialState");

const standalone = createStandaloneNoteConversation({ id: "note-conversation", noteId: "standalone-note" });
standalone.notes![0].content = "Original standalone text.";
const margin = { ...standalone.notes![0], id: "margin-note", kind: "comment" as const, content: "Original margin text." };
const updates: Array<{ kind: string; content: string; id: string }> = [];
const uses: Array<{ conversationId: string; content: string }> = [];
let setStandalone!: (update: any) => void;
let setMargin!: (update: any) => void;
let latestStandalone = standalone;
let latestMargin = margin;
let renameCalls = 0;
let activationCalls = 0;

function Host() {
  const [conversation, updateConversation] = useState(standalone);
  const [note, updateNote] = useState(margin);
  setStandalone = updateConversation;
  setMargin = updateNote;
  latestStandalone = conversation;
  latestMargin = note;
  return createElement("div", null,
    createElement(StandaloneNotePanel, {
      conversation, isActive: false, onActivate() { activationCalls++; }, registerPanelRef() {}, onRename() { renameCalls++; },
      onUpdate(_conversationId: string, id: string, content: string) {
        updates.push({ kind: "standalone", id, content });
        updateConversation((current: any) => ({ ...current, notes: current.notes.map((entry: any) => entry.id === id ? { ...entry, content } : entry) }));
      },
    }),
    createElement(MarginNoteTreeNode, {
      conversationId: conversation.id, note, onDelete() {},
      onUse(conversationId: string, content: string) {
        uses.push({ conversationId, content });
      },
      onUpdate(_conversationId: string, id: string, content: string) {
        updates.push({ kind: "margin", id, content });
        updateNote((current: any) => ({ ...current, content }));
      },
    }),
  );
}

const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
function editor(selector: string) {
  const element = container.querySelector(`${selector} .cm-editor`);
  assert(element, `Missing actual CodeMirror editor at ${selector}`);
  const view = EditorView.findFromDOM(element as unknown as HTMLElement);
  assert(view, "The real CodeMirror instance was not found.");
  return view;
}
function replace(view: any, content: string) {
  view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: content }, userEvent: "input.type" });
}

try {
  await act(async () => { root.render(createElement(Host)); });
  await act(async () => { (container.querySelector(".margin-note-tree-summary") as any).click(); });
  assert.equal(editor(".standalone-note-panel").state.doc.toString(), "Original standalone text.");
  assert.equal(editor(".margin-note-tree-node").state.doc.toString(), "Original margin text.");

  await act(async () => {
    setStandalone((current: any) => ({ ...current, title: "Remote title", notes: current.notes.map((note: any) => ({ ...note, content: "Newer remote standalone text." })) }));
    setMargin((current: any) => ({ ...current, content: "Newer remote margin text." }));
  });
  assert.equal(editor(".standalone-note-panel").state.doc.toString(), "Newer remote standalone text.");
  assert.equal(editor(".margin-note-tree-node").state.doc.toString(), "Newer remote margin text.");
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 380)); });
  assert.deepEqual(updates, [], "A remote prop update was incorrectly emitted as local typing.");
  assert.equal(renameCalls, 0, "Remote title changes triggered a rename.");

  const title = container.querySelector<HTMLInputElement>(".standalone-note-title")!;
  await act(async () => {
    title.dispatchEvent(new browser.PointerEvent("pointerdown", { bubbles: true }));
    title.click(); title.focus();
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(title, "Edited ancestor title");
    title.dispatchEvent(new browser.Event("input", { bubbles: true }));
    title.blur();
    const content = container.querySelector(".standalone-note-panel .cm-content")!;
    content.dispatchEvent(new browser.PointerEvent("pointerdown", { bubbles: true }));
    content.click();
  });
  assert.equal(renameCalls, 1, "An inactive ancestor title remains editable.");
  assert.equal(activationCalls, 0, "Editing an ancestor note must not replace the active child path.");

  await act(async () => {
    replace(editor(".standalone-note-panel"), "Typed into the actual standalone editor.");
    assert.equal(updates.at(-1)?.content, "Typed into the actual standalone editor.", "Standalone typing waited for a timer or blur before entering app state.");
  });
  assert.equal(latestStandalone.notes![0].content, "Typed into the actual standalone editor.");
  assert.equal(activationCalls, 0);
  await act(async () => {
    replace(editor(".margin-note-tree-node"), "Typed into the actual margin editor.");
    assert.equal(updates.at(-1)?.content, "Typed into the actual margin editor.", "Margin typing waited for blur before entering app state.");
  });
  assert.equal(latestMargin.content, "Typed into the actual margin editor.");

  const useButton = container.querySelector<HTMLButtonElement>(".margin-note-tree-use")!;
  assert.equal(useButton.disabled, false, "A nonempty note should be available to add to a message.");
  await act(async () => { useButton.click(); });
  assert.deepEqual(uses, [{ conversationId: standalone.id, content: "Typed into the actual margin editor." }], "Use in message must pass the latest note to its own conversation exactly once.");
  assert.equal(useButton.textContent?.trim(), "Added to draft", "Adding a note needs visible feedback.");
  assert.equal(container.querySelector(".margin-note-tree-editor [role='status']")?.textContent, "Note added to your message draft.", "Adding a note needs announced feedback.");
  assert.equal(useButton.disabled, true, "The confirmation state must prevent an immediate duplicate insertion.");
  await act(async () => { useButton.click(); });
  assert.equal(uses.length, 1, "Clicking the confirmation must not add the note twice.");

  const marginView = editor(".margin-note-tree-node");
  const escape = new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true });
  await act(async () => {
    marginView.focus();
    assert.equal(browser.document.activeElement, marginView.contentDOM, "Escape must start inside the actual CodeMirror editor.");
    marginView.contentDOM.dispatchEvent(escape);
  });
  assert.equal(escape.defaultPrevented, true, "The card must capture Escape before CodeMirror consumes it.");
  assert.equal(container.querySelector(".margin-note-tree-editor"), null, "Escape must minimize the editor.");
  const toggle = container.querySelector<HTMLButtonElement>(".margin-note-tree-summary")!;
  assert.equal(toggle.getAttribute("aria-expanded"), "false");
  assert.equal(browser.document.activeElement, toggle, "Escape must restore focus to the edit toggle.");
  assert.equal(latestMargin.content, "Typed into the actual margin editor.", "Minimizing must retain the latest saved content.");

  await act(async () => { toggle.click(); });
  assert.equal(editor(".margin-note-tree-node").state.doc.toString(), latestMargin.content, "Reopening must show the current saved note.");
  const done = container.querySelector<HTMLButtonElement>(".margin-note-tree-done")!;
  await act(async () => {
    done.focus();
    assert.equal(browser.document.activeElement, done);
    done.click();
  });
  assert.equal(container.querySelector(".margin-note-tree-editor"), null, "Done must minimize the editor.");
  assert.equal(browser.document.activeElement, toggle, "Done must restore focus instead of leaving it on an unmounted control.");
  await act(async () => { toggle.click(); });

  await act(async () => { replace(editor(".margin-note-tree-node"), ""); });
  assert.equal(latestMargin.content, "", "Clearing a margin note restored old content.");
  const emptyUseButton = container.querySelector<HTMLButtonElement>(".margin-note-tree-use")!;
  assert.equal(emptyUseButton.textContent?.trim(), "Use in message", "Editing the note must clear the old insertion confirmation.");
  assert.equal(emptyUseButton.disabled, true, "An empty note cannot be added to a message.");
  assert.equal(container.querySelector(".margin-note-tree-editor [role='status']")?.textContent, "");
  await act(async () => { emptyUseButton.click(); });
  assert.equal(uses.length, 1, "An empty note must never invoke insertion.");
  await act(async () => { replace(editor(".standalone-note-panel"), ""); });
  assert.equal(latestStandalone.notes![0].content, "", "Clearing a standalone note restored old content.");
  const realEditCount = updates.length;
  await act(async () => { container.querySelector<HTMLElement>(".standalone-note-header p")!.click(); });
  assert.equal(activationCalls, 1, "Clicking the note background can still activate that conversation.");

  await act(async () => {
    setStandalone((current: any) => ({ ...current, notes: current.notes.map((note: any) => ({ ...note, content: "Remote after local typing." })) }));
    setMargin((current: any) => ({ ...current, content: "Remote after margin typing." }));
  });
  await act(async () => { (container.querySelector(".margin-note-tree-summary") as any).click(); });
  await act(async () => { root.unmount(); });
  await new Promise((resolve) => setTimeout(resolve, 380));
  assert.equal(updates.length, realEditCount, "Closing or unmounting an editor re-uploaded a stale draft.");
  assert.equal(renameCalls, 1, "Remote updates must not repeat the explicit local rename.");
  console.log(JSON.stringify({ checks: ["remote props update actual CodeMirror without local writes", "standalone typing updates immediately", "margin typing updates immediately", "empty content remains empty", "closing and unmounting cannot flush stale drafts", "ancestor note title and editor remain usable without activating its conversation", "Escape from CodeMirror minimizes and restores toggle focus", "Done minimizes and restores toggle focus", "Use in message inserts latest content once with visible and announced feedback", "empty notes cannot be inserted"] }));
} finally {
  await act(async () => { root.unmount(); });
  await browser.happyDOM.abort();
}
