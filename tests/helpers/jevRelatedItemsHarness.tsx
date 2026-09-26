import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://related-items.test", width: 375, height: 667 });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement: el } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: JevRelatedItems } = await import("../../client/src/components/JevRelatedItems");
const { createStandaloneNoteConversation } = await import("../../client/src/initialState");
const conversations = Object.fromEntries(["current", "first", "second"].map((id) => [id, { ...createStandaloneNoteConversation({ id, noteId: `${id}-body` }), title: id }]));
const selected: string[] = [];
const props = {
  conversations, currentId: "current", status: "ready" as const, warning: "Some suggestions were unavailable.",
  related: [{ id: "current", score: 1 }, { id: "deleted", score: 1 }, { id: "first", score: 0.9 }, { id: "second", score: 0.8 }],
  onSelect(id: string) { selected.push(id); },
};
const container = browser.document.createElement("div");
const outside = browser.document.createElement("button");
outside.textContent = "Outside";
browser.document.body.append(container, outside);
const root = createRoot(container as unknown as Element);
const trigger = () => container.querySelector<HTMLButtonElement>(".jev-related-trigger")!;
const popup = () => browser.document.querySelector(".jev-related-popover");
const links = () => Array.from(browser.document.querySelectorAll(".jev-related-links button"));
async function click(element: any) { await act(async () => element.click()); }
async function press(element: any, key: string) {
  await act(async () => element.dispatchEvent(new browser.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
}

try {
  await act(async () => root.render(el(JevRelatedItems, props)));
  assert.equal(trigger().getAttribute("aria-label"), "Related notes and chats (2)");
  assert.equal(popup(), null, "Related suggestions use no content row while closed");
  trigger().getBoundingClientRect = () => ({ left: 315, right: 367, top: 10, bottom: 42, width: 52, height: 32, x: 315, y: 10, toJSON() {} });
  await click(trigger());
  assert.equal(trigger().getAttribute("aria-expanded"), "true");
  assert.equal(popup()?.parentElement, browser.document.body, "Popup escapes toolbar clipping");
  assert.equal((popup() as any).style.left, "47px", "Popup aligns with trigger and stays within narrow viewport");
  assert.equal(links().length, 2);
  assert.equal(browser.document.activeElement, links()[0], "Opening moves keyboard focus to related items");
  assert.equal(popup()?.querySelector('[role="status"]')?.textContent, props.warning);
  await press(links()[0], "ArrowDown");
  assert.equal(browser.document.activeElement, links()[1]);
  await press(links()[1], "Escape");
  assert.equal(popup(), null);
  assert.equal(browser.document.activeElement, trigger(), "Escape returns focus to the trigger");
  await click(trigger());
  await click(outside);
  assert.equal(popup(), null, "An outside click dismisses the popup");
  await click(trigger());
  await click(trigger());
  assert.equal(popup(), null, "Clicking the trigger again closes without reopening");
  await click(trigger());
  await click(links()[1]);
  assert.deepEqual(selected, ["second"]);
  assert.equal(popup(), null, "Navigation closes the popup");
  await click(trigger());
  await act(async () => root.render(el(JevRelatedItems, { ...props, currentId: "first" })));
  assert.equal(popup(), null, "Changing context dismisses old suggestions");
  await click(trigger());
  await act(async () => root.render(el(JevRelatedItems, { ...props, status: "loading" })));
  assert.equal(container.innerHTML, "");
  assert.equal(popup(), null, "Unavailable suggestions remove their portal too");
  console.log("Related items checks passed.");
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
