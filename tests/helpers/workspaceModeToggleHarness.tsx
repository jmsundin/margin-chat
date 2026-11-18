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
let mapOpen = false;
let showTiles = true;
const selected: MainViewMode[] = [];
function Host() {
  const [mode, setMode] = useState<MainViewMode>("chat");
  const [, setTick] = useState(0);
  changeMode = (next) => { setMode(next); setTick((tick) => tick + 1); };
  return createElement(WorkspaceModeToggle, {
    mainViewMode: mode,
    mapOpen,
    showTiles,
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
  assert.deepEqual(options().map((option) => option.getAttribute("aria-label")), ["Document View", "Tile View", "Map"], "Map is back in the toggle.");
  assert.deepEqual(options().map((option) => option.getAttribute("aria-checked")), ["true", "false", "false"]);
  assert.deepEqual(options().map((option) => option.tabIndex), [0, -1, -1], "Only the active view is in the tab order.");
  assert.equal(container.querySelectorAll('[role="menu"], [aria-haspopup]').length, 0, "No dropdown remains.");
  checks.push("three icon radios show Document, Tile and Map with the active one checked");

  assert.deepEqual(options().map((option) => option.getAttribute("title")), ["Document View (Ctrl+Shift+D)", "Tile View (Ctrl+Shift+L)", "Map (Ctrl+G)"]);
  assert.equal(options()[1].getAttribute("aria-keyshortcuts"), "Meta+Shift+L Control+Shift+L");
  checks.push("tooltips and aria-keyshortcuts name each view's shortcut");

  await click(options()[1]);
  assert.deepEqual(selected, ["tiles"]);
  assert.deepEqual(options().map((option) => option.getAttribute("aria-checked")), ["false", "true", "false"]);
  await click(options()[2]);
  assert.deepEqual(selected, ["tiles", "graph"]);
  assert.deepEqual(options().map((option) => option.getAttribute("aria-checked")), ["false", "false", "true"], "A map request reads as Map.");
  await click(options()[0]);
  assert.deepEqual(selected, ["tiles", "graph", "chat"]);
  checks.push("one click switches to any view");

  await act(async () => options()[0].focus());
  await key(options()[0], "ArrowRight");
  assert.equal(selected.at(-1), "tiles");
  assert.equal(browser.document.activeElement, options()[1]);
  await key(options()[1], "End");
  assert.equal(selected.at(-1), "graph");
  await key(options()[2], "ArrowRight");
  assert.equal(selected.at(-1), "chat", "Arrow navigation wraps.");
  await key(options()[0], "Home");
  assert.equal(selected.at(-1), "chat");
  checks.push("arrow, Home and End keys move between views like a radio group");

  await act(async () => { mapOpen = true; changeMode("chat"); });
  assert.deepEqual(options().map((option) => option.getAttribute("aria-checked")), ["false", "false", "true"], "The map open beside the document checks Map.");
  await act(async () => { mapOpen = false; showTiles = false; changeMode("tiles"); });
  assert.deepEqual(options().map((option) => option.getAttribute("aria-label")), ["Document View", "Tile View", "Map"], "Tile view stays while it is the view, even with Tiles off.");
  await act(async () => changeMode("chat"));
  assert.deepEqual(options().map((option) => option.getAttribute("aria-label")), ["Document View", "Map"], "Without Tiles the toggle is Document and Map.");
  checks.push("outside view changes update the checked icon");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
