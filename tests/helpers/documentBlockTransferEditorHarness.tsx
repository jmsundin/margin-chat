import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { DocumentBlock } from "@margin-chat/workspace-contracts";

const browser = new Window({ url: "http://block-transfer-editor.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Text", "Document", "DocumentFragment", "MutationObserver", "ResizeObserver", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "Range", "DOMRect", "DOMParser", "getComputedStyle", "ShadowRoot"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value: name === "getComputedStyle" ? value.bind(browser) : value });
}
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: clearTimeout });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: RichDocumentEditor } = await import("../../client/src/components/RichDocumentEditor");
const date = "2026-09-25T00:00:00.000Z";
function block(id: string, content: string): DocumentBlock { return { id, content, kind: "markdown", createdAt: date, updatedAt: date }; }
const initial = { a: [block("alpha", "**Exact** [source](https://example.com)."), block("beta", "Second paragraph."), block("stream", "Writing response…")], b: [block("first", "Destination first."), block("last", "Destination last.")], blank: [block("empty", "")], note: [block("note-block", "A note can reorder its own blocks.")], hidden: [] };
let latest: Record<string, DocumentBlock[]> = initial;
const moves: Array<{ source: string; blockId: string; target: string; before: string | null }> = [];
const reorders: Array<{ documentId: string; blockId: string; before: string | null }> = [];
function Host() {
  const [documents, setDocuments] = useState<Record<string, DocumentBlock[]>>(initial);
  latest = documents;
  function move(source: string, blockId: string, target: string, before: string | null) {
    moves.push({ source, blockId, target, before });
    setDocuments((current) => {
      const moved = current[source].find((item) => item.id === blockId)!;
      const destination = [...current[target]];
      const index = before ? destination.findIndex((item) => item.id === before) : destination.length;
      destination.splice(index < 0 ? destination.length : index, 0, moved);
      return { ...current, [source]: current[source].filter((item) => item.id !== blockId), [target]: destination };
    });
  }
  return createElement("div", null, ["a", "b", "blank", "note"].map((id) => createElement(RichDocumentEditor, {
    key: id, conversationId: id, blocks: documents[id], readOnlyBlockIds: ["stream"],
    moveTargets: [{ id: "a", title: "Source document" }, { id: "b", title: "Target document" }, { id: "blank", title: "Empty document" }, { id: "hidden", title: "Closed document" }], onMoveBlock: id === "note" ? undefined : move,
    onUpdateBlock(blockId, content) { setDocuments((current) => ({ ...current, [id]: current[id].map((item) => item.id === blockId ? { ...item, content } : item) })); },
    onInsertBlock() { return "unused-draft"; },
    onReorderBlock(blockId, before) {
      reorders.push({ documentId: id, blockId, before });
      setDocuments((current) => {
        const moved = current[id].find((item) => item.id === blockId)!;
        const next = current[id].filter((item) => item.id !== blockId);
        next.splice(before ? next.findIndex((item) => item.id === before) : next.length, 0, moved);
        return { ...current, [id]: next };
      });
    },
  })));
}
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const checks: string[] = [];
function element(selector: string): any { const found = container.querySelector(selector); assert(found, `Missing ${selector}`); return found; }
function surface(id: string) { return element(`[data-block-editor-conversation-id="${id}"]`); }
function shell(id: string) { return element(`[data-document-block-id="${id}"]`); }
function editor(id: string): any { return shell(id).querySelector(".tiptap").editor; }
function grip(id: string) { return shell(id).querySelector(".rich-document-grip"); }
async function click(target: any) { await act(async () => target.click()); }
function geometry() {
  for (const id of ["a", "b", "blank", "note"]) {
    const root = surface(id);
    const left = id === "a" ? 0 : id === "b" ? 500 : id === "blank" ? 1000 : 1500;
    root.getBoundingClientRect = () => new browser.DOMRect(left, 0, 400, 1000);
    [...root.querySelectorAll(".rich-document-block")].forEach((node: any, index) => { node.getBoundingClientRect = () => new browser.DOMRect(left, 100 + index * 160, 400, 160); });
  }
}
let paintedTarget: any = null;
browser.document.elementFromPoint = () => paintedTarget;
const transfer = { types: [] as string[], values: {} as Record<string, string>, effectAllowed: "", dropEffect: "",
  setData(type: string, value: string) { this.values[type] = value; this.types = Object.keys(this.values); }, getData(type: string) { return this.values[type] ?? ""; } };
async function drag(target: any, type: string, x = 600, y = 110) {
  const event = new browser.MouseEvent(type, { clientX: x, clientY: y, bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: transfer });
  await act(async () => target.dispatchEvent(event));
  return event;
}
async function pointer(target: any, type: string, x: number, y: number) {
  const event = new browser.PointerEvent(type, { pointerId: 3, isPrimary: true, button: 0, clientX: x, clientY: y, bubbles: true, cancelable: true });
  await act(async () => target.dispatchEvent(event));
  return event;
}
try {
  await act(async () => root.render(createElement(Host)));
  geometry();
  await click(grip("alpha"));
  const picker = element('[aria-label="Move block to document"]');
  assert.deepEqual([...picker.options].map((option: any) => option.value), ["", "b", "blank", "hidden"], "Picker excludes the source while including documents outside the visible panes.");
  await act(async () => { picker.value = "hidden"; picker.dispatchEvent(new browser.Event("change", { bubbles: true })); });
  assert.deepEqual(moves.at(-1), { source: "a", blockId: "alpha", target: "hidden", before: null });
  assert.equal(latest.hidden[0].content, initial.a[0].content);
  assert(!latest.a.some((item) => item.id === "alpha"));
  assert.equal(container.querySelector('[data-document-block-id="alpha"]'), null);
  checks.push("block picker appends exact content to a hidden document and excludes its current document");

  geometry();
  const targetContent = editor("first").getMarkdown();
  await drag(grip("beta"), "dragstart");
  assert.deepEqual(JSON.parse(transfer.values["application/x-margin-document-block"]), { sourceConversationId: "a", blockId: "beta" });
  assert.equal((await drag(editor("first").view.dom, "dragover")).defaultPrevented, true);
  assert(shell("first").classList.contains("is-drop-before"));
  const moveCount = moves.length;
  assert.equal((await drag(editor("first").view.dom, "drop")).defaultPrevented, true);
  assert.equal(moves.length, moveCount + 1);
  assert.deepEqual(moves.at(-1), { source: "a", blockId: "beta", target: "b", before: "first" });
  assert.deepEqual(latest.b.map((item) => item.id), ["beta", "first", "last"]);
  assert.equal(editor("first").getMarkdown(), targetContent, "TipTap must not insert the drag payload into the existing destination block.");
  assert.equal(latest.b.filter((item) => item.id === "beta").length, 1);
  assert.equal(container.querySelector(".is-drop-before, .is-drop-after, .rich-document-drop-end"), null);
  checks.push("native transfer inserts before the target once and stops TipTap from duplicating content");

  geometry();
  await drag(grip("beta"), "dragstart");
  await drag(editor("first").view.dom, "dragover", 600, 400);
  assert(shell("first").classList.contains("is-drop-after"));
  await drag(editor("first").view.dom, "drop", 600, 400);
  assert.deepEqual(reorders.at(-1), { documentId: "b", blockId: "beta", before: "last" });
  assert.deepEqual(latest.b.map((item) => item.id), ["first", "beta", "last"]);
  checks.push("same-document dragging still reorders and uses the lower half to insert after a block");

  geometry();
  const continuation = surface("a").querySelector(".is-continuation");
  assert(continuation);
  assert.equal(continuation.querySelector(".rich-document-grip").disabled, true);
  assert.equal(grip("stream").disabled, true);
  assert.equal((await drag(grip("stream"), "dragstart")).defaultPrevented, true);
  await drag(grip("last"), "dragstart");
  await drag(continuation.querySelector(".tiptap"), "dragover", 100, 280);
  assert(surface("a").querySelector(".rich-document-drop-end"));
  await drag(continuation.querySelector(".tiptap"), "drop", 100, 280);
  assert.deepEqual(moves.at(-1), { source: "b", blockId: "last", target: "a", before: null });
  assert.deepEqual(latest.a.map((item) => item.id), ["stream", "last"]);
  geometry();
  const beforeBlocked = moves.length;
  await drag(grip("first"), "dragstart");
  await drag(editor("stream").view.dom, "dragover", 100, 110);
  assert.equal(transfer.dropEffect, "none");
  await drag(editor("stream").view.dom, "drop", 100, 110);
  assert.equal(moves.length, beforeBlocked);
  checks.push("continuation targets append while streaming blocks and unsaved drafts cannot be dragged or overwritten");

  geometry();
  paintedTarget = editor("last").view.dom;
  const firstGrip = grip("first");
  await pointer(firstGrip, "pointerdown", 520, 120);
  assert.equal((await drag(firstGrip, "dragstart")).defaultPrevented, true, "Native dragging cannot take over the pointer gesture.");
  await pointer(browser, "pointermove", 100, 280);
  assert(shell("last").classList.contains("is-drop-before"));
  await pointer(browser, "pointerup", 100, 280);
  assert.deepEqual(moves.at(-1), { source: "b", blockId: "first", target: "a", before: "last" });
  assert.deepEqual(latest.a.map((item) => item.id), ["stream", "first", "last"]);
  assert.equal(container.querySelector(".is-dragging, .is-drop-before, .is-drop-after"), null);
  checks.push("pointer drag uses the painted destination to move across editors without native drag events");

  geometry();
  const betaGrip = grip("beta");
  const beforeCancel = moves.length;
  await pointer(betaGrip, "pointerdown", 520, 120);
  await pointer(browser, "pointermove", 100, 280);
  await pointer(browser, "pointercancel", 100, 280);
  assert.equal(moves.length, beforeCancel);
  await click(betaGrip);
  assert.equal(shell("beta").querySelector(".rich-document-toolbar"), null, "Releasing a drag must not open the formatting toolbar.");
  await pointer(betaGrip, "pointerdown", 520, 120);
  await pointer(browser, "pointermove", 522, 121);
  await pointer(browser, "pointerup", 522, 121);
  await click(betaGrip);
  assert(shell("beta").querySelector(".rich-document-toolbar"), "A normal grip click continues to open formatting controls.");
  assert.equal(moves.length, beforeCancel);
  await pointer(betaGrip, "pointerdown", 520, 120);
  await pointer(browser, "pointermove", 100, 280);
  await act(async () => { betaGrip.focus(); betaGrip.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })); });
  await pointer(browser, "pointerup", 100, 280);
  assert.equal(moves.length, beforeCancel, "Escape on the focused grip cancels even though the editor stops bubbling keyboard events.");
  assert.equal(container.querySelector(".is-dragging, .is-drop-before, .is-drop-after"), null);
  checks.push("canceled gestures and small pointer movement preserve normal formatting clicks without accidental moves");

  await click(betaGrip);
  geometry();
  // The painted pinned destination can cover a different pane's rectangle.
  paintedTarget = editor("beta").view.dom;
  await pointer(grip("last"), "pointerdown", 20, 450);
  await pointer(browser, "pointermove", 100, 110);
  await pointer(browser, "pointerup", 100, 110);
  assert.deepEqual(moves.at(-1), { source: "a", blockId: "last", target: "b", before: "beta" });
  assert.deepEqual(latest.b.map((item) => item.id), ["last", "beta"]);
  checks.push("pointer hit testing chooses the painted pinned pane rather than an overlapping clipped editor rectangle");

  geometry();
  await drag(grip("beta"), "dragstart");
  await drag(editor("empty").view.dom, "dragover", 1100, 110);
  assert(surface("blank").querySelector(".rich-document-drop-end"));
  await drag(editor("empty").view.dom, "drop", 1100, 110);
  assert.deepEqual(moves.at(-1), { source: "b", blockId: "beta", target: "blank", before: null });
  assert.equal(latest.blank.at(-1)?.content, "Second paragraph.");
  checks.push("an existing empty destination block accepts an append without editing its text");

  geometry();
  const beforeNoteDrop = moves.length;
  await drag(grip("note-block"), "dragstart");
  await drag(editor("last").view.dom, "dragover", 600, 110);
  assert.equal(transfer.dropEffect, "none");
  await drag(editor("last").view.dom, "drop", 600, 110);
  assert.equal(moves.length, beforeNoteDrop, "An editor that only supports internal reordering cannot initiate a cross-document transfer.");
  assert.equal(latest.note[0].id, "note-block");
  checks.push("reorder-only note editors cannot transfer their synthetic blocks into documents");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
