import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://sidebar-resize.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Document", "DocumentFragment", "MutationObserver", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "localStorage"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: ResizableSidebar } = await import("../../client/src/components/ResizableSidebar");
const container = browser.document.createElement("div");
browser.document.body.append(container);
let root = createRoot(container as unknown as Element);
const transitions: boolean[] = [];
let setCollapsed!: (value: boolean) => void;
let setMobile!: (value: boolean) => void;
const capture = new Map<HTMLElement, number>();
const releases: number[] = [];
Object.assign(browser.HTMLElement.prototype, {
  setPointerCapture(this: HTMLElement, id: number) { capture.set(this, id); },
  hasPointerCapture(this: HTMLElement, id: number) { return capture.get(this) === id; },
  releasePointerCapture(this: HTMLElement, id: number) { capture.delete(this); releases.push(id); },
});
const key = "margin-chat-sidebar-width";
const checks: string[] = [];

function Host() {
  const [collapsed, updateCollapsed] = useState(false);
  const [mobile, updateMobile] = useState(false);
  setCollapsed = updateCollapsed;
  setMobile = updateMobile;
  return createElement(ResizableSidebar, {
    collapsed, mobile, onResizingChange(value: boolean) { transitions.push(value); },
    children: createElement("aside", { className: "thread-sidebar" }, "Chats"),
  });
}
const handle = () => {
  const element = container.querySelector<HTMLDivElement>('[role="separator"]');
  assert(element, "Missing resize handle");
  return element;
};
const width = () => Number(handle().getAttribute("aria-valuenow"));
async function keyboard(key: string) {
  const event = new browser.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
  await act(async () => { handle().dispatchEvent(event); });
  return event;
}
async function pointer(type: string, id: number, x = 100, options: { primary?: boolean; button?: number } = {}) {
  const target = type === "pointerdown" ? handle() : browser;
  const event = new browser.PointerEvent(type, { pointerId: id, clientX: x, button: options.button ?? 0, isPrimary: options.primary ?? true, bubbles: true, cancelable: true });
  await act(async () => { target.dispatchEvent(event); });
  return event;
}
async function mount(saved: string | null) {
  await act(async () => { root.unmount(); });
  if (saved === null) browser.localStorage.removeItem(key);
  else browser.localStorage.setItem(key, saved);
  root = createRoot(container as unknown as Element);
  await act(async () => { root.render(createElement(Host)); });
}

try {
  await mount("300");
  assert.equal(width(), 300);
  assert.equal(handle().getAttribute("aria-valuemin"), "220");
  assert.equal(handle().getAttribute("aria-valuemax"), "480");
  assert.equal((await keyboard("ArrowRight")).defaultPrevented, true);
  assert.equal(width(), 324);
  await keyboard("ArrowLeft");
  assert.equal(width(), 300);
  await keyboard("Home");
  await keyboard("ArrowLeft");
  assert.equal(width(), 220);
  await keyboard("End");
  await keyboard("ArrowRight");
  assert.equal(width(), 480);
  assert.equal((await keyboard("Enter")).defaultPrevented, false);
  await act(async () => { handle().dispatchEvent(new browser.MouseEvent("dblclick", { bubbles: true })); });
  assert.equal(width(), 272);
  assert.equal(browser.localStorage.getItem(key), "272");
  checks.push("saved widths, keyboard limits, double-click reset and persistence");

  browser.document.body.style.cursor = "crosshair";
  browser.document.body.style.userSelect = "text";
  await pointer("pointerdown", 9, 100, { primary: false });
  await pointer("pointerdown", 9, 100, { button: 2 });
  assert.deepEqual(transitions, []);
  await pointer("pointerdown", 1);
  const firstHandle = handle();
  assert.equal(capture.get(firstHandle as unknown as HTMLElement), 1);
  assert.equal(browser.document.body.style.cursor, "col-resize");
  assert.equal(browser.document.body.style.userSelect, "none");
  await pointer("pointermove", 2, 450);
  assert.equal(width(), 272);
  await pointer("pointerup", 2);
  assert.equal(transitions.at(-1), true);
  await pointer("pointermove", 1, 600);
  assert.equal(width(), 480);
  await pointer("pointermove", 1, -500);
  assert.equal(width(), 220);
  await pointer("pointercancel", 1);
  assert.equal(capture.size, 0);
  assert.equal(releases.at(-1), 1);
  assert.equal(browser.document.body.style.cursor, "crosshair");
  assert.equal(browser.document.body.style.userSelect, "text");
  assert.deepEqual(transitions, [true, false]);
  await pointer("pointermove", 1, 1000);
  assert.equal(width(), 220);
  checks.push("primary pointer drag clamps width, ignores other pointers and restores capture/body state on cancel");

  await pointer("pointerdown", 3);
  await pointer("pointermove", 3, 150);
  await pointer("pointerup", 3);
  assert.equal(width(), 270);
  await pointer("pointerdown", 4);
  capture.delete(handle() as unknown as HTMLElement);
  await pointer("lostpointercapture", 4);
  assert.equal(transitions.at(-1), false);
  for (const eventType of ["blur", "resize"]) {
    await pointer("pointerdown", 5);
    await act(async () => { browser.dispatchEvent(new browser.Event(eventType)); });
    assert.equal(transitions.at(-1), false);
    assert.equal(capture.size, 0);
    assert.equal(browser.document.body.style.cursor, "crosshair");
  }
  checks.push("pointer up, capture loss, blur and viewport resize all terminate dragging");

  await pointer("pointerdown", 6);
  await act(async () => { setCollapsed(true); });
  assert.equal(container.querySelector('[role="separator"]'), null);
  assert(container.querySelector(".workspace-sidebar-pane.is-collapsed"));
  assert.equal(capture.size, 0);
  assert.equal(transitions.at(-1), false);
  await act(async () => { setCollapsed(false); });
  assert.equal(width(), 270);
  await pointer("pointerdown", 7);
  await act(async () => { setMobile(true); });
  assert.equal(container.querySelector('[role="separator"]'), null);
  assert.equal(capture.size, 0);
  assert.equal(transitions.at(-1), false);
  await act(async () => { setMobile(false); });
  await pointer("pointerdown", 8);
  await act(async () => { root.unmount(); });
  assert.equal(capture.size, 0);
  assert.equal(transitions.at(-1), false);
  assert.equal(browser.document.body.style.cursor, "crosshair");
  assert.equal(browser.document.body.style.userSelect, "text");
  root = createRoot(container as unknown as Element);
  await act(async () => { root.render(createElement(Host)); });
  assert.equal(width(), 270);
  checks.push("collapse, mobile transition and unmount clean up active drags while preserving width");

  await mount("999"); assert.equal(width(), 480);
  await mount("-100"); assert.equal(width(), 220);
  await mount("invalid"); assert.equal(width(), 272);
  await act(async () => { root.unmount(); });
  Object.defineProperty(globalThis, "localStorage", { configurable: true, value: { getItem() { throw new Error("Unavailable"); }, setItem() { throw new Error("Unavailable"); } } });
  root = createRoot(container as unknown as Element);
  await act(async () => { root.render(createElement(Host)); });
  assert.equal(width(), 272);
  await keyboard("ArrowRight");
  assert.equal(width(), 296);
  checks.push("out-of-range, malformed and unavailable storage leave a usable sidebar");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => { root.unmount(); });
  await browser.happyDOM.close();
}
