import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://document-views.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: DocumentViewsMenu } = await import("../../client/src/components/DocumentViewsMenu");
let setDocument: (id: string) => void;
let setEmpty: (empty: boolean) => void;
let setBranchesEnabled: (enabled: boolean) => void;
const selected: string[] = [];
let branchToggles = 0;
function Host() {
  const [id, updateId] = useState("main");
  const [empty, updateEmpty] = useState(false);
  const [branchesOpen, updateBranchesOpen] = useState(false);
  const [branchesEnabled, updateBranchesEnabled] = useState(true);
  setDocument = updateId;
  setEmpty = updateEmpty;
  setBranchesEnabled = updateBranchesEnabled;
  return createElement(DocumentViewsMenu, {
    currentDocumentId: id, relatedItems: empty ? [] : [{ id: "note", title: "Reference note", kind: "note" }, { id: "chat", title: "Supporting chat", kind: "chat" }],
    relatedWarning: "Results may be incomplete.", onSelectRelated: (id) => selected.push(id),
    branchCount: empty ? 0 : 3, branchesOpen, branchesEnabled,
    onToggleBranches() { branchToggles += 1; updateBranchesOpen((open) => !open); },
  });
}
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const checks: string[] = [];
function trigger(): any { return container.querySelector('[aria-label="Document views"]'); }
function menu(): any { return browser.document.querySelector('[role="menu"]'); }
function items(): any[] { return [...menu().querySelectorAll('[role^="menuitem"]')]; }
async function click(element: any) { await act(async () => element.click()); }
async function key(target: any, key: string) {
  await act(async () => target.dispatchEvent(new browser.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
}

try {
  await act(async () => root.render(createElement(Host)));
  assert.equal(container.querySelectorAll("button").length, 1, "Only the views icon remains in the toolbar.");
  assert.equal(trigger().getAttribute("aria-expanded"), "false");
  await click(trigger());
  assert.equal(menu().parentElement, browser.document.body, "The menu avoids toolbar clipping.");
  assert.equal(menu().getAttribute("aria-label"), "Document views");
  assert.equal(trigger().getAttribute("aria-expanded"), "true");
  assert.equal(items().length, 2);
  assert.equal(items()[0].getAttribute("aria-label"), "Related notes and chats (2)");
  assert.equal(items()[1].getAttribute("aria-label"), "Branches 3");
  assert.equal(items()[1].getAttribute("aria-checked"), "false");
  assert.equal(browser.document.activeElement, items()[0]);
  checks.push("one portaled views menu retains related and branch counts");

  await key(browser.document.activeElement, "ArrowDown");
  assert.equal(browser.document.activeElement, items()[1]);
  await click(items()[1]);
  assert.equal(branchToggles, 1);
  assert.equal(menu(), null);
  assert.equal(browser.document.activeElement, trigger());
  await key(trigger(), "ArrowUp");
  assert.equal(browser.document.activeElement, items()[1]);
  assert.equal(items()[1].getAttribute("aria-checked"), "true");
  await key(browser.document.activeElement, "ArrowDown");
  assert.equal(browser.document.activeElement, items()[0], "Arrow navigation wraps.");
  checks.push("branch actions toggle the view and restore focus with checked state");

  await key(items()[0], "ArrowRight");
  assert.equal(menu().getAttribute("aria-label"), "Related notes and chats");
  assert.equal(items().length, 3);
  assert.equal(browser.document.activeElement, items()[0]);
  assert(menu().textContent.includes("Results may be incomplete."));
  await key(browser.document.activeElement, "End");
  assert.equal(browser.document.activeElement, items()[2]);
  await click(items()[2]);
  assert.deepEqual(selected, ["chat"]);
  assert.equal(menu(), null);
  assert.equal(browser.document.activeElement, trigger());
  checks.push("related submenu selects documents and retains warnings");

  await click(trigger());
  await click(items()[0]);
  await key(browser.document.activeElement, "Escape");
  assert.equal(menu().getAttribute("aria-label"), "Document views");
  assert.equal(browser.document.activeElement, items()[0]);
  await key(browser.document.activeElement, "Escape");
  assert.equal(menu(), null);
  assert.equal(browser.document.activeElement, trigger());
  checks.push("Escape returns through the submenu then to the toolbar trigger");

  await click(trigger());
  await act(async () => browser.document.body.dispatchEvent(new browser.PointerEvent("pointerdown", { bubbles: true })));
  assert.equal(menu(), null);
  await click(trigger());
  await key(browser.document.activeElement, "Tab");
  assert.equal(menu(), null);
  await click(trigger());
  const outside = browser.document.createElement("button");
  browser.document.body.append(outside);
  await act(async () => outside.focus());
  assert.equal(menu(), null);
  assert.equal(browser.document.activeElement, outside, "Dismissal does not steal outside focus.");
  checks.push("outside interaction, Tab, and focus leaving dismiss the menu");

  await click(trigger());
  await click(items()[0]);
  await act(async () => setDocument("different"));
  assert.equal(menu(), null);
  checks.push("switching active documents closes stale related results");

  await click(trigger());
  await click(items()[1]); // Close the branch view before removing all counts.
  await act(async () => setEmpty(true));
  await click(trigger());
  assert(items().every((item) => item.disabled));
  assert.equal(browser.document.activeElement, menu(), "An empty menu stays keyboard dismissible.");
  assert.equal(items()[0].title, "No related notes or chats available");
  await key(menu(), "Escape");
  assert.equal(menu(), null);
  checks.push("empty views expose disabled entries and still support keyboard dismissal");

  await act(async () => { setEmpty(false); setBranchesEnabled(false); });
  await click(trigger());
  assert.equal(items().length, 1);
  assert.equal(items()[0].getAttribute("aria-label"), "Related notes and chats (2)");
  checks.push("unavailable branch access is omitted without hiding related results");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
