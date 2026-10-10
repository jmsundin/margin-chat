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
  assert.deepEqual(options().map((option) => option.getAttribute("aria-label")), ["Document View", "Tile View", "Map View"]);
  assert.deepEqual(options().map((option) => option.getAttribute("aria-checked")), ["true", "false", "false"]);
  assert.deepEqual(options().map((option) => option.tabIndex), [0, -1, -1], "Only the active view is in the tab order.");
  assert.equal(container.querySelectorAll('[role="menu"], [aria-haspopup]').length, 0, "No dropdown remains.");
  checks.push("three icon radios show every view with the active one checked");

  assert.deepEqual(options().map((option) => option.getAttribute("title")), ["Document View (Ctrl+Shift+D)", "Tile View (Ctrl+Shift+L)", "Map View (Ctrl+G)"]);
  assert.equal(options()[2].getAttribute("aria-keyshortcuts"), "Meta+G Control+G");
  checks.push("tooltips and aria-keyshortcuts name each view's shortcut");

  await click(options()[2]);
  assert.deepEqual(selected, ["graph"]);
  assert.deepEqual(options().map((option) => option.getAttribute("aria-checked")), ["false", "false", "true"]);
  await click(options()[1]);
  assert.deepEqual(selected, ["graph", "tiles"]);
  checks.push("one click switches to any view");

  await act(async () => options()[1].focus());
  await key(options()[1], "ArrowRight");
  assert.equal(selected.at(-1), "graph");
  assert.equal(browser.document.activeElement, options()[2]);
  await key(options()[2], "ArrowRight");
  assert.equal(selected.at(-1), "chat", "Arrow navigation wraps.");
  assert.equal(browser.document.activeElement, options()[0]);
  await key(options()[0], "End");
  assert.equal(selected.at(-1), "graph");
  await key(options()[2], "Home");
  assert.equal(selected.at(-1), "chat");
  checks.push("arrow, Home and End keys move between views like a radio group");

  await act(async () => changeMode("tiles"));
  assert.deepEqual(options().map((option) => option.getAttribute("aria-checked")), ["false", "true", "false"]);
  checks.push("outside view changes update the checked icon");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
