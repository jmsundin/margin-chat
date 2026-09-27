import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://margin-resize.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: MarginDocumentFrame } = await import("../../client/src/components/MarginDocumentFrame");
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const commits: { width: number; height: number }[] = [];
function Fixture() {
  const [size, setSize] = useState({ width: 280, height: 380 });
  return createElement(MarginDocumentFrame, { size, label: "Research note", onResize(next) { commits.push(next); setSize(next); } }, createElement("p", null, "Preserved note content"));
}
await act(async () => root.render(createElement(Fixture)));
const frame = () => container.querySelector(".margin-document-frame") as unknown as HTMLDivElement;
const handle = () => container.querySelector(".margin-document-resize") as unknown as HTMLButtonElement;
const dimensions = () => ({ width: parseInt(frame().style.width), height: parseInt(frame().style.height) });
async function pointer(type: string, x: number, y: number, id = 1) {
  await act(async () => (type === "pointerdown" ? handle() : browser).dispatchEvent(new browser.PointerEvent(type, { bubbles: true, pointerId: id, isPrimary: true, button: 0, clientX: x, clientY: y }) as unknown as Event));
}
async function key(key: string, shiftKey = false) {
  await act(async () => handle().dispatchEvent(new browser.KeyboardEvent("keydown", { bubbles: true, key, shiftKey }) as unknown as Event));
}
try {
  assert.deepEqual(dimensions(), { width: 280, height: 380 });
  await pointer("pointerdown", 280, 380);
  await pointer("pointermove", 420, 560);
  assert.deepEqual(dimensions(), { width: 420, height: 560 });
  assert.equal(commits.length, 0, "Preview must not persist every pointer move");
  await pointer("pointerup", 420, 560);
  assert.deepEqual(commits, [{ width: 420, height: 560 }]);
  assert.equal(browser.document.body.style.cursor, "");
  assert.equal(browser.document.body.style.userSelect, "");

  await key("ArrowLeft");
  await key("ArrowDown", true);
  assert.deepEqual(dimensions(), { width: 400, height: 640 });
  await key("Home");
  await key("ArrowLeft");
  await key("ArrowUp");
  assert.deepEqual(dimensions(), { width: 220, height: 180 });
  await key("End");
  await key("ArrowRight");
  await key("ArrowDown");
  assert.deepEqual(dimensions(), { width: 640, height: 1000 });

  await act(async () => handle().dispatchEvent(new browser.MouseEvent("dblclick", { bubbles: true }) as unknown as Event));
  assert.deepEqual(dimensions(), { width: 280, height: 380 });
  const countBeforeCancel = commits.length;
  await pointer("pointerdown", 280, 380);
  await pointer("pointermove", 500, 800);
  await pointer("pointercancel", 500, 800);
  assert.deepEqual(dimensions(), { width: 280, height: 380 });
  assert.equal(commits.length, countBeforeCancel);
  assert.equal(container.querySelector("p")!.textContent, "Preserved note content");
  assert.equal(browser.document.body.style.cursor, "");
  console.log(JSON.stringify({ checks: ["pointer preview and commit", "keyboard resize and bounds", "reset", "cancellation preserves size and content"] }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
