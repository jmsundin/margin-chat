import assert from "node:assert/strict";
import { Window } from "happy-dom";
const browser = new Window({ url: "http://child-tabs.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "PointerEvent", "KeyboardEvent"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: DocumentChildTabs } = await import("../../client/src/components/DocumentChildTabs");
const { default: DocumentSiblingTabs } = await import("../../client/src/components/DocumentSiblingTabs");
const { createMainConversation } = await import("../../client/src/initialState");
const parent = { ...createMainConversation({ id: "parent" }), title: "Angular" };
const children = ["Components", "Services", "Routing"].map((title, i) => ({ ...createMainConversation({ id: `child-${i}` }), parentId: parent.id, title }));
children[0].messages = [{ id: "preview", role: "assistant", content: "**Component** preview text.", createdAt: parent.createdAt }];
const selected: string[] = [];
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const nav = () => container.querySelector("nav");
const toggle = () => container.querySelector<HTMLButtonElement>(".document-child-tabs-toggle")!;
const items = () => [...container.querySelectorAll<HTMLButtonElement>(".document-child-tab")];
async function click(node: any) { await act(async () => node.click()); }
async function key(node: any, key: string) { await act(async () => node.dispatchEvent(new browser.KeyboardEvent("keydown", { bubbles: true, key, cancelable: true }))); }
try {
  browser.localStorage.clear();
  await act(async () => root.render(createElement(DocumentChildTabs, { parent, documents: children, currentDocumentId: children[0].id, minimizedDocumentIds: [children[2].id], openDocumentIds: [children[0].id], onSelect: id => selected.push(id) })));
  assert.equal(nav()?.getAttribute("aria-label"), "Child documents of Angular");
  assert.deepEqual(items().map((item) => item.querySelector(".document-child-title")?.textContent), ["Components", "Services", "Routing"], "Every child title is visible without opening a menu.");
  assert(items()[0].textContent.includes("Open"));
  assert(items()[0].title.includes("Component preview text."));
  assert(items()[1].textContent.includes("Not open"));
  assert(items()[2].textContent.includes("Minimized"));
  assert.equal(items()[0].getAttribute("aria-current"), "page");
  assert.equal(toggle().getAttribute("aria-label"), "Hide children of Angular (3)");
  await click(items()[2]);
  assert.deepEqual(selected, [children[2].id], "Selecting a minimized child delegates to document restoration.");
  await act(async () => items()[0].focus());
  await key(items()[0], "ArrowDown");
  assert.equal(browser.document.activeElement, items()[1]);
  await key(items()[1], "End");
  assert.equal(browser.document.activeElement, items()[2]);
  await key(items()[2], "ArrowDown");
  assert.equal(browser.document.activeElement, items()[0], "Arrow keys wrap around the list.");
  await click(toggle());
  assert.equal(items().length, 0, "Collapsing hides the titles.");
  assert(nav()?.classList.contains("is-collapsed"));
  assert.equal(toggle().getAttribute("aria-expanded"), "false");
  assert.equal(browser.localStorage.getItem("margin-chat:child-tabs-collapsed"), "1", "The collapsed choice is remembered.");
  await click(toggle());
  assert.equal(items().length, 3);
  await act(async () => root.render(createElement(DocumentChildTabs, { parent, documents: [], currentDocumentId: parent.id, minimizedDocumentIds: [], onSelect: id => selected.push(id) })));
  assert.equal(nav(), null, "Documents without children have no child tabs.");

  selected.length = 0;
  await act(async () => root.render(createElement(DocumentSiblingTabs, { parent, documents: children, currentDocumentId: children[1].id, onSelect: id => selected.push(id) })));
  const tabs = () => [...container.querySelectorAll<HTMLButtonElement>('[role="tab"]')];
  assert.equal(container.querySelector('[role="tablist"]')?.getAttribute("aria-label"), "Children of Angular");
  assert.deepEqual(tabs().map((tab) => tab.textContent), ["Components", "Services", "Routing"]);
  assert.deepEqual(tabs().map((tab) => tab.getAttribute("aria-selected")), ["false", "true", "false"]);
  await click(tabs()[1]);
  assert.deepEqual(selected, [], "The current tab does nothing.");
  await click(tabs()[2]);
  assert.deepEqual(selected, [children[2].id]);
  await act(async () => tabs()[1].focus());
  await key(tabs()[1], "ArrowRight");
  assert.equal(browser.document.activeElement, tabs()[2]);
  await key(tabs()[2], "Home");
  assert.equal(browser.document.activeElement, tabs()[0]);
  console.log(JSON.stringify({ passed: true }));
} finally { await act(async () => root.unmount()); await browser.happyDOM.close(); }
