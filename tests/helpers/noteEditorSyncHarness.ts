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
const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { EditorView } = await import("@codemirror/view");
const { default: StandaloneNotePanel } = await import("../../client/src/components/StandaloneNotePanel");
const { default: MarginNoteTreeNode } = await import("../../client/src/components/MarginNoteTreeNode");
const { createStandaloneNoteConversation } = await import("../../client/src/initialState");

const standalone = createStandaloneNoteConversation({ id: "note-conversation", noteId: "standalone-note" });
standalone.notes![0].content = "Original standalone text.";
const margin = { ...standalone.notes![0], id: "margin-note", kind: "comment" as const, content: "Original margin text." };
const updates: Array<{ kind: string; content: string; id: string }> = [];
let setStandalone!: (update: any) => void;
let setMargin!: (update: any) => void;
let latestStandalone = standalone;
let latestMargin = margin;
let renameCalls = 0;

function Host() {
  const [conversation, updateConversation] = useState(standalone);
  const [note, updateNote] = useState(margin);
  setStandalone = updateConversation;
  setMargin = updateNote;
  latestStandalone = conversation;
  latestMargin = note;
  return createElement("div", null,
    createElement(StandaloneNotePanel, {
      conversation, isActive: false, onActivate() {}, registerPanelRef() {}, onRename() { renameCalls++; },
      onUpdate(_conversationId: string, id: string, content: string) {
        updates.push({ kind: "standalone", id, content });
        updateConversation((current: any) => ({ ...current, notes: current.notes.map((entry: any) => entry.id === id ? { ...entry, content } : entry) }));
      },
    }),
    createElement(MarginNoteTreeNode, {
      conversationId: conversation.id, note, onDelete() {},
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

  await act(async () => {
    replace(editor(".standalone-note-panel"), "Typed into the actual standalone editor.");
    assert.equal(updates.at(-1)?.content, "Typed into the actual standalone editor.", "Standalone typing waited for a timer or blur before entering app state.");
  });
  assert.equal(latestStandalone.notes![0].content, "Typed into the actual standalone editor.");
  await act(async () => {
    replace(editor(".margin-note-tree-node"), "Typed into the actual margin editor.");
    assert.equal(updates.at(-1)?.content, "Typed into the actual margin editor.", "Margin typing waited for blur before entering app state.");
  });
  assert.equal(latestMargin.content, "Typed into the actual margin editor.");

  await act(async () => { replace(editor(".margin-note-tree-node"), ""); });
  assert.equal(latestMargin.content, "", "Clearing a margin note restored old content.");
  await act(async () => { replace(editor(".standalone-note-panel"), ""); });
  assert.equal(latestStandalone.notes![0].content, "", "Clearing a standalone note restored old content.");
  const realEditCount = updates.length;

  await act(async () => {
    setStandalone((current: any) => ({ ...current, notes: current.notes.map((note: any) => ({ ...note, content: "Remote after local typing." })) }));
    setMargin((current: any) => ({ ...current, content: "Remote after margin typing." }));
  });
  await act(async () => { (container.querySelector(".margin-note-tree-summary") as any).click(); });
  await act(async () => { root.unmount(); });
  await new Promise((resolve) => setTimeout(resolve, 380));
  assert.equal(updates.length, realEditCount, "Closing or unmounting an editor re-uploaded a stale draft.");
  assert.equal(renameCalls, 0, "Remote title changes triggered a rename.");
  console.log(JSON.stringify({ checks: ["remote props update actual CodeMirror without local writes", "standalone typing updates immediately", "margin typing updates immediately", "empty content remains empty", "closing and unmounting cannot flush stale drafts"] }));
} finally {
  await act(async () => { root.unmount(); });
  await browser.happyDOM.abort();
}
