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
const { createMainConversation } = await import("../../client/src/initialState");
const parent = { ...createMainConversation({ id: "parent" }), title: "Angular" };
const children = ["Components", "Services", "Routing"].map((title, i) => ({ ...createMainConversation({ id: `child-${i}` }), parentId: parent.id, title }));
const selected: string[] = [];
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const trigger = () => container.querySelector("button")!;
const panel = () => container.querySelector("nav");
const items = () => [...panel()!.querySelectorAll("button")];
const wait = (ms: number) => act(async () => { await new Promise(resolve => setTimeout(resolve, ms)); });
async function pointer(type: string, pointerType = "mouse", buttons = 0) {
  await act(async () => trigger().dispatchEvent(new browser.PointerEvent(type, { bubbles: true, pointerType, buttons, relatedTarget: browser.document.body })));
}
async function click(node: any) { await act(async () => node.click()); }
async function key(node: any, key: string) { await act(async () => node.dispatchEvent(new browser.KeyboardEvent("keydown", { bubbles: true, key, cancelable: true }))); }
try {
  await act(async () => root.render(createElement(DocumentChildTabs, { parent, documents: children, currentDocumentId: children[0].id, minimizedDocumentIds: [children[2].id], onSelect: id => selected.push(id) })));
  assert.equal(panel(), null);
  await pointer("pointerover");
  await wait(100);
  await pointer("pointerout");
  await wait(500);
  assert.equal(panel(), null, "Passing through the hot zone does not reveal tabs.");
  await pointer("pointerover");
  await wait(500);
  assert(panel(), "Pausing over the hot zone reveals tabs.");
  assert.equal(items().length, 3);
  assert.equal(items()[0].getAttribute("aria-current"), "page");
  assert(items()[2].textContent.includes("Minimized"));
  await pointer("pointerout");
  await wait(300);
  assert.equal(panel(), null, "Leaving the strip closes it after a short grace period.");
  await pointer("pointerover", "mouse", 1);
  await wait(500);
  assert.equal(panel(), null, "Dragging through the edge does not open navigation.");
  await pointer("pointerout");
  await pointer("pointerover", "touch");
  await wait(500);
  assert.equal(panel(), null, "Touch hover does not schedule opening.");
  await click(trigger());
  assert(panel(), "Click and touch activation can reveal tabs immediately.");
  await click(items()[2]);
  assert.deepEqual(selected, [children[2].id], "Selecting a minimized child delegates to document restoration.");
  assert.equal(panel(), null);
  await act(async () => trigger().focus());
  assert(panel(), "Keyboard focus reveals navigation.");
  await act(async () => items()[0].focus());
  await key(items()[0], "ArrowRight");
  assert.equal(browser.document.activeElement, items()[1]);
  await key(items()[1], "End");
  assert.equal(browser.document.activeElement, items()[2]);
  await key(items()[2], "Escape");
  assert.equal(panel(), null);
  assert.equal(browser.document.activeElement, trigger());
  await click(trigger());
  await click(browser.document.body);
  assert.equal(panel(), null, "Clicking outside dismisses the strip.");
  await pointer("pointerover");
  await act(async () => root.unmount());
  await wait(500);
  assert.equal(panel(), null, "Unmount cancels pending hover work.");
  console.log(JSON.stringify({ passed: true }));
} finally { await act(async () => root.unmount()); await browser.happyDOM.close(); }
