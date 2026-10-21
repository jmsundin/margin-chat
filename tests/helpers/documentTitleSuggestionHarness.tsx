import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://document-title-suggestion.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: DocumentMenu } = await import("../../client/src/components/DocumentMenu");
const { DocumentTitleSuggestionContext } = await import("../../client/src/lib/documentTitleSuggestion");
const { createMainConversation } = await import("../../client/src/initialState");

let resolveAI: (title: string) => void = () => {};
let aiRequests = 0;
let aiAllowed = true;
let setTitle: (title: string) => void;
const changes: string[] = [];
function Host() {
  const [conversation, setConversation] = useState({ ...createMainConversation({ id: "main" }), title: "Untitled document" });
  setTitle = (title) => setConversation((current) => ({ ...current, title }));
  const suggest = (id: string) => id === "main" && conversation.title === "Untitled document" ? {
    local: "Organoids grow from stem cells",
    ai: aiAllowed ? () => { aiRequests += 1; return new Promise<string>((resolve) => { resolveAI = resolve; }); } : null,
  } : null;
  return createElement(DocumentTitleSuggestionContext.Provider, { value: suggest },
    createElement(DocumentMenu, { conversation, onRename: (_id: string, title: string) => { changes.push(title); setConversation((current) => ({ ...current, title })); } }));
}
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const checks: string[] = [];
function input(): any { return browser.document.querySelector('[aria-label="Document name"]'); }
function hint(): any { return browser.document.querySelector(".document-rename-hint"); }
function button(label: string): any {
  const result = [...browser.document.querySelectorAll("button")].find((node) => node.textContent.trim() === label);
  assert(result, `Missing button: ${label}`);
  return result;
}
async function click(node: any) { await act(async () => node.click()); }
async function fill(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
}
async function openRename() { await click(browser.document.querySelector(".document-menu-trigger")); await click(button("Rename document")); }
function allSelected() { return input().selectionStart === 0 && input().selectionEnd === input().value.length; }

try {
  await act(async () => root.render(createElement(Host)));
  await openRename();
  assert.equal(input().value, "Organoids grow from stem cells");
  assert(allSelected());
  assert(hint());
  assert.equal(changes.length, 0);
  checks.push("an untitled document opens rename with a selected local suggestion that isn't saved yet");

  await act(async () => { resolveAI("**Growing organs from stem cells**"); await Promise.resolve(); });
  assert.equal(input().value, "Growing organs from stem cells");
  assert(allSelected());
  checks.push("the AI title replaces the untouched suggestion, without Markdown, still selected");

  await click(button("Cancel"));
  await openRename();
  await fill("My own name");
  await act(async () => { resolveAI("Something else"); await Promise.resolve(); });
  assert.equal(input().value, "My own name");
  assert.equal(hint(), null);
  await click(button("Save"));
  assert.deepEqual(changes, ["My own name"]);
  checks.push("a late AI title never overwrites what was typed");

  await openRename();
  assert.equal(input().value, "My own name");
  assert.equal(hint(), null);
  await click(button("Cancel"));
  checks.push("named documents keep their name in the field");

  aiAllowed = false;
  const before = aiRequests;
  await act(async () => setTitle("Untitled document"));
  await openRename();
  assert.equal(input().value, "Organoids grow from stem cells");
  assert.equal(aiRequests, before);
  await click(button("Cancel"));
  checks.push("documents hidden from AI get only the local suggestion");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
