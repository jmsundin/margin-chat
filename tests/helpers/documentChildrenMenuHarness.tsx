import assert from "node:assert/strict";
import { Window } from "happy-dom";
const browser = new Window({ url: "http://child-tabs.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "PointerEvent", "KeyboardEvent"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: DocumentChildrenMenu } = await import("../../client/src/components/DocumentChildrenMenu");
const { createMainConversation } = await import("../../client/src/initialState");
const parent = { ...createMainConversation({ id: "parent" }), title: "Angular" };
const children = ["Components", "Services", "Routing"].map((title, i) => ({ ...createMainConversation({ id: `child-${i}` }), parentId: parent.id, title }));
children[0].messages = [{ id: "preview", role: "assistant", content: "**Component** preview text.", createdAt: parent.createdAt }];
const selected: string[] = [];
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const trigger = () => container.querySelector<HTMLButtonElement>(".document-children-trigger")!;
const items = () => [...container.querySelectorAll<HTMLButtonElement>(".document-child-item")];
async function click(node: any) { await act(async () => node.click()); }
async function key(node: any, key: string) { await act(async () => node.dispatchEvent(new browser.KeyboardEvent("keydown", { bubbles: true, key, cancelable: true }))); }
try {
  const note = { ...createMainConversation({ id: "note" }), parentId: parent.id, title: "Why DI?", branchAnchor: { messageId: "m", quote: "Dependency injection wires services", startOffset: 0, endOffset: 35 } } as any;
  const render = (documents: any[], marginNoteIds: string[] = []) => act(async () => root.render(createElement(DocumentChildrenMenu, { parent, documents, currentDocumentId: children[0].id, minimizedDocumentIds: [children[2].id], openDocumentIds: [children[0].id], marginNoteIds, onSelect: (id: string) => selected.push(id) })));
  await render([...children, note], [note.id]);
  assert.equal(trigger().getAttribute("aria-label"), "Children of Angular (4)");
  assert.equal(trigger().getAttribute("aria-expanded"), "false");
  assert.equal(items().length, 0, "The list stays closed until the menu opens.");
  await click(trigger());
  assert.equal(trigger().getAttribute("aria-expanded"), "true");
  assert.deepEqual(items().map((item) => item.querySelector(".document-child-title")?.textContent), ["Why DI?", "Components", "Services", "Routing"], "Margin notes come first, then the other children in saved order.");
  assert.deepEqual([...container.querySelectorAll(".document-children-heading")].map((item) => item.textContent), ["Margin notes", "Documents"]);
  assert(items()[0].classList.contains("is-margin-note"));
  assert(items()[0].textContent.includes("Dependency injection wires services"), "A margin note shows its passage.");
  assert(items()[1].textContent.includes("Open"));
  assert(items()[1].title.includes("Component preview text."));
  assert(items()[2].textContent.includes("Not open"));
  assert(items()[3].textContent.includes("Minimized"));
  assert.equal(items()[1].getAttribute("aria-current"), "page");
  await act(async () => items()[0].focus());
  await key(items()[0], "ArrowUp");
  assert.equal(browser.document.activeElement, items()[3], "Arrow keys wrap around the list.");
  await key(items()[3], "Home");
  assert.equal(browser.document.activeElement, items()[0]);
  await click(items()[3]);
  assert.deepEqual(selected, [children[2].id], "Selecting a minimized child delegates to document restoration.");
  assert.equal(items().length, 0, "Choosing a child closes the menu.");
  await render(children);
  await click(trigger());
  assert.equal(container.querySelector(".document-children-heading"), null, "Without margin notes the list has no headings.");
  await render([]);
  assert.equal(container.querySelector(".document-children-menu"), null, "Documents without children have no Children menu.");

  console.log(JSON.stringify({ passed: true }));
} finally { await act(async () => root.unmount()); await browser.happyDOM.close(); }
