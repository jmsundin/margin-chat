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
const policies: Array<[string, string | null]> = [];
const revealed: string[] = [];
let toggleRename: (enabled: boolean) => void;
function Host() {
  const [conversation, setConversation] = useState({ ...createMainConversation({ id: "main" }), title: "Research notes" });
  const [enabled, setEnabled] = useState(true);
  toggleRename = setEnabled;
  return createElement(DocumentMenu, {
    conversation,
    onRevealInFolder: enabled ? (id: string) => { revealed.push(id); } : undefined,
    fileManager: "Explorer",
    onRename: enabled ? (id, title) => { changes.push([id, title]); setConversation((current) => ({ ...current, title })); } : undefined,
    onSetAgentEdit: (id: string, policy: "locked" | "open" | null) => {
      policies.push([id, policy]);
      setConversation((current) => { const { agentEdit: _agentEdit, ...rest } = current as any; return { ...rest, ...(policy ? { agentEdit: policy } : {}) }; });
    },
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

  await click(trigger());
  const agentRow = () => browser.document.querySelector('[aria-label^="Agent editing:"]') as any;
  assert.equal(agentRow().getAttribute("aria-label"), "Agent editing: Only what I didn't write");
  assert.equal(browser.document.querySelector('[role="menuitemradio"]'), null);
  await click(agentRow());
  const radios = () => [...browser.document.querySelectorAll('[role="menuitemradio"]')] as any[];
  assert.deepEqual(radios().map((node) => [node.textContent.replace("✓", "").trim(), node.getAttribute("aria-checked")]),
    [["Only what I didn't write", "true"], ["Locked", "false"], ["Open", "false"]]);
  await click(radios()[1]);
  assert.deepEqual(policies, [["main", "locked"]]);
  assert.equal(browser.document.querySelector('[role="menu"]'), null);
  await click(trigger());
  assert.equal(agentRow().getAttribute("aria-label"), "Agent editing: Locked");
  await click(agentRow());
  await click(radios()[0]);
  assert.deepEqual(policies.at(-1), ["main", null]);
  checks.push("agent editing is chosen in the menu, and only there");

  await click(trigger());
  await click(button("Show in Explorer"));
  assert.deepEqual(revealed, ["main"]);
  assert.equal(browser.document.querySelector('[role="menu"]'), null);
  checks.push("the desktop app's menu shows the document's file in its folder");

  await act(async () => toggleRename(false));
  await click(trigger());
  assert(![...browser.document.querySelectorAll('[role="menuitem"]')].some((node) => node.textContent === "Rename document"));
  assert(![...browser.document.querySelectorAll('[role="menuitem"]')].some((node) => node.textContent?.startsWith("Show in")));
  checks.push("read-only menus omit renaming, and browsers have no Show in Finder");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
