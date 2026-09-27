import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://document-menu.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: DocumentMenu } = await import("../../client/src/components/DocumentMenu");
const { createMainConversation } = await import("../../client/src/initialState");
const changes: string[][] = [];
let toggleRename: (enabled: boolean) => void;
function Host() {
  const [conversation, setConversation] = useState({ ...createMainConversation({ id: "main" }), title: "Research notes" });
  const [enabled, setEnabled] = useState(true);
  toggleRename = setEnabled;
  return createElement(DocumentMenu, {
    conversation,
    onRename: enabled ? (id, title) => { changes.push([id, title]); setConversation((current) => ({ ...current, title })); } : undefined,
  });
}
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const checks: string[] = [];
function trigger(): any { return container.querySelector(".document-menu-trigger"); }
function input(): any { return browser.document.querySelector('[aria-label="Document name"]'); }
function dialog(): any { return browser.document.querySelector('[role="dialog"]'); }
function button(label: string): any {
  const result = [...browser.document.querySelectorAll("button")].find((node) => node.textContent.trim() === label);
  assert(result, `Missing button: ${label}`);
  return result;
}
async function click(node: any) { await act(async () => node.click()); }
async function key(node: any, value: string, shiftKey = false) {
  await act(async () => node.dispatchEvent(new browser.KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true })));
}
async function fill(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
}
async function openRename() { await click(trigger()); await click(button("Rename document")); }

try {
  await act(async () => root.render(createElement(Host)));
  await openRename();
  assert.equal(browser.document.querySelector('[role="menu"]'), null);
  assert.equal(dialog().getAttribute("aria-label"), "Rename document");
  assert.equal(dialog().getAttribute("aria-modal"), "true");
  assert.equal(input().value, "Research notes");
  assert.equal(browser.document.activeElement, input());
  assert.equal(input().selectionEnd, input().value.length);
  await key(input(), "Tab", true);
  assert.equal(browser.document.activeElement, button("Save"));
  await key(button("Save"), "Tab");
  assert.equal(browser.document.activeElement, input());
  checks.push("rename opens with the current name selected and keyboard focus contained");

  await fill("  Updated title  ");
  await key(input(), "Enter");
  assert.deepEqual(changes, [["main", "Updated title"]]);
  assert.equal(dialog(), null);
  assert.equal(trigger().getAttribute("aria-label"), "Options for Updated title");
  assert.equal(browser.document.activeElement, trigger());
  checks.push("Enter renames the same document and restores focus to the menu trigger");

  await openRename();
  await fill("   ");
  assert.equal(button("Save").disabled, true);
  await key(input(), "Enter");
  assert(dialog());
  await key(input(), "Escape");
  assert.equal(dialog(), null);
  assert.equal(changes.length, 1);
  assert.equal(browser.document.activeElement, trigger());
  checks.push("blank titles cannot be saved and Escape cancels without changing the document");

  await openRename();
  await fill("Discard this");
  await click(button("Cancel"));
  assert.equal(changes.length, 1);
  await openRename();
  assert.equal(input().value, "Updated title");
  await fill("Saved title");
  await click(button("Save"));
  assert.deepEqual(changes.at(-1), ["main", "Saved title"]);
  assert.equal(browser.document.activeElement, trigger());
  checks.push("Cancel discards edits and Save submits the new title");

  await act(async () => toggleRename(false));
  await click(trigger());
  assert(![...browser.document.querySelectorAll('[role="menuitem"]')].some((node) => node.textContent === "Rename document"));
  checks.push("read-only menus omit renaming");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
