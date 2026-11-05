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

const { wikiLinkSuggestions } = await import("../../client/src/lib/wikiLinkSuggestions");

const now = "2026-11-05T00:00:00.000Z";
const block = (id: string, content: string): DocumentBlock => ({ id, kind: "markdown", content, createdAt: now, updatedAt: now, authorship: "user" });
const doc = (id: string, title: string, updatedAt: string) => ({ id, title, parentId: null, updatedAt, createdAt: updatedAt, messages: [] }) as any;
const conversations = {
  doc: doc("doc", "This document", now),
  senolytics: doc("senolytics", "Senolytics overview", "2026-11-01T00:00:00Z"),
  sleep: doc("sleep", "Sleep and longevity", "2026-11-03T00:00:00Z"),
  seneca: doc("seneca", "Seneca letters", "2026-10-01T00:00:00Z"),
};
let latest: DocumentBlock[] = [block("body", "Start")];

function Host() {
  const [blocks, update] = useState(latest);
  return createElement(LiveDocumentEditor, {
    conversationId: "doc", blocks,
    onChangeBlocks(next: DocumentBlock[]) { latest = next; update(next); },
    linkSuggestions: (query: string) => wikiLinkSuggestions({ conversations, currentId: "doc" }, query),
  });
}

const container = document.createElement("div");
document.body.appendChild(container);
const root = createRoot(container);
await act(async () => { root.render(createElement(Host)); });
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
const view = EditorView.findFromDOM(container.querySelector(".cm-content") as HTMLElement)!;
assert.ok(view, "the editor mounts");
// happy-dom has no focus tracking CodeMirror trusts, so the editor reports focus here.
Object.defineProperty(view, "hasFocus", { get: () => true });

function key(name: string) {
  const event = new KeyboardEvent("keydown", { key: name, bubbles: true, cancelable: true });
  return act(async () => { runScopeHandlers(view, event as any, "editor"); });
}
async function type(value: string) {
  await act(async () => {
    const { from, to } = view.state.selection.main;
    view.dispatch({ changes: { from, to, insert: value }, selection: { anchor: from + value.length }, userEvent: "input.type" });
  });
}
async function caret(at: number) { await act(async () => { view.dispatch({ selection: EditorSelection.cursor(at) }); }); }
const options = () => [...container.querySelectorAll(".wiki-link-option")].map((item) => item.querySelector(".wiki-link-option-title")?.textContent);
const selected = () => container.querySelector('.wiki-link-option[aria-selected="true"] .wiki-link-option-title')?.textContent;
const menu = () => container.querySelector(".wiki-link-menu");
const body = () => latest.find((item) => item.id === "body")?.content;

await caret(5);
await type(" see [");
assert.equal(menu(), null, "one bracket is just a bracket");
await type("[");
assert.ok(menu(), "typing [[ opens the list");
assert.deepEqual(options(), ["Sleep and longevity", "Senolytics overview", "Seneca letters"], "recent documents first, without the open one");
await type("sen");
assert.deepEqual(options(), ["Senolytics overview", "Seneca letters"], "typing searches titles");
assert.equal(selected(), "Senolytics overview");
await key("ArrowDown");
assert.equal(selected(), "Seneca letters", "ArrowDown moves through the list");
await key("ArrowDown");
assert.equal(selected(), "Senolytics overview", "and wraps around");
await key("ArrowUp");
assert.equal(selected(), "Seneca letters");
await key("Enter");
assert.equal(body(), "Start see [[Seneca letters]]", "Enter inserts the link and closes the brackets");
assert.equal(menu(), null, "the list closes after picking");
assert.equal(view.state.selection.main.head, view.state.doc.toString().indexOf("]]") + 2, "the caret goes after the link");

// Escape closes the list until another [[ is typed.
await type(" and [[sl");
assert.deepEqual(options(), ["Sleep and longevity"]);
await key("Escape");
assert.equal(menu(), null, "Escape closes the list");
await type("e");
assert.equal(menu(), null, "it stays closed for that link");
await key("Enter");
assert.ok(body()?.includes("[[sle"), "Enter types normally once the list is closed");

// Clicking an option picks it; picking inside an existing link replaces its whole name.
await act(async () => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "Read [[Old name]] today" }, userEvent: "input.type" }); });
await caret("Read [[Old".length);
assert.ok(menu(), "the list opens inside an existing link");
assert.deepEqual(options(), [], "nothing matches yet");
assert.equal(container.querySelector(".wiki-link-empty")?.textContent, "No matching documents");
await act(async () => { view.dispatch({ changes: { from: "Read [[".length, to: "Read [[Old".length, insert: "slee" }, selection: { anchor: "Read [[slee".length }, userEvent: "input.type" }); });
const option = container.querySelector(".wiki-link-option") as HTMLElement;
await act(async () => { option.dispatchEvent(new MouseEvent("click", { bubbles: true })); });
assert.equal(view.state.doc.toString().split("\n")[0], "Read [[Sleep and longevity]] today", "a click inserts the link without leaving stray brackets");

// Code keeps [[ as text.
await act(async () => { view.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: "Code `[[x` here" }, selection: { anchor: 9 }, userEvent: "input.type" }); });
assert.equal(menu(), null, "no list inside inline code");

await act(async () => root.unmount());
console.log("wiki link autocomplete ok");
process.exit(0);
