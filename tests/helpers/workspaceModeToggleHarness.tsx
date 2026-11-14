import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { MainViewMode } from "../../client/src/types";

const browser = new Window({ url: "http://workspace-mode.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: WorkspaceModeToggle } = await import("../../client/src/components/WorkspaceModeToggle");
let changeMode: (mode: MainViewMode) => void;
const selected: MainViewMode[] = [];
function Host() {
  const [mode, setMode] = useState<MainViewMode>("chat");
  changeMode = setMode;
  return createElement(WorkspaceModeToggle, {
    mainViewMode: mode,
    onSetMainViewMode(next) { selected.push(next); setMode(next); },
  });
}
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const checks: string[] = [];
function group(): any { return container.querySelector('[role="radiogroup"]'); }
function options(): any[] { return [...container.querySelectorAll('[role="radio"]')]; }
async function click(element: any) { await act(async () => element.click()); }
async function key(target: any, key: string) {
  await act(async () => target.dispatchEvent(new browser.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
}

try {
  await act(async () => root.render(createElement(Host)));
  assert.equal(group().getAttribute("aria-label"), "Workspace view");
  assert.deepEqual(options().map((option) => option.getAttribute("aria-label")), ["Document View", "Tile View"], "The map is not a view of its own.");
  assert.deepEqual(options().map((option) => option.getAttribute("aria-checked")), ["true", "false"]);
  assert.deepEqual(options().map((option) => option.tabIndex), [0, -1], "Only the active view is in the tab order.");
  assert.equal(container.querySelectorAll('[role="menu"], [aria-haspopup]').length, 0, "No dropdown remains.");
  checks.push("two icon radios show Document and Tile with the active one checked");

  assert.deepEqual(options().map((option) => option.getAttribute("title")), ["Document View (Ctrl+Shift+D)", "Tile View (Ctrl+Shift+L)"]);
  assert.equal(options()[1].getAttribute("aria-keyshortcuts"), "Meta+Shift+L Control+Shift+L");
  checks.push("tooltips and aria-keyshortcuts name each view's shortcut");

  await click(options()[1]);
  assert.deepEqual(selected, ["tiles"]);
  assert.deepEqual(options().map((option) => option.getAttribute("aria-checked")), ["false", "true"]);
  await click(options()[0]);
  assert.deepEqual(selected, ["tiles", "chat"]);
  checks.push("one click switches to any view");

  await act(async () => options()[0].focus());
  await key(options()[0], "ArrowRight");
  assert.equal(selected.at(-1), "tiles");
  assert.equal(browser.document.activeElement, options()[1]);
  await key(options()[1], "ArrowRight");
  assert.equal(selected.at(-1), "chat", "Arrow navigation wraps.");
  assert.equal(browser.document.activeElement, options()[0]);
  await key(options()[0], "End");
  assert.equal(selected.at(-1), "tiles");
  await key(options()[1], "Home");
  assert.equal(selected.at(-1), "chat");
  checks.push("arrow, Home and End keys move between views like a radio group");

  await act(async () => changeMode("tiles"));
  assert.deepEqual(options().map((option) => option.getAttribute("aria-checked")), ["false", "true"]);
  await act(async () => changeMode("graph"));
  assert.deepEqual(options().map((option) => option.getAttribute("aria-checked")), ["true", "false"], "A map request still reads as the document.");
  checks.push("outside view changes update the checked icon");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
