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
const { default: WorkspaceModeMenu } = await import("../../client/src/components/WorkspaceModeMenu");
let changeMode: (mode: MainViewMode) => void;
const selected: MainViewMode[] = [];
function Host() {
  const [mode, setMode] = useState<MainViewMode>("chat");
  changeMode = setMode;
  return createElement(WorkspaceModeMenu, {
    mainViewMode: mode,
    onSetMainViewMode(next) { selected.push(next); setMode(next); },
  });
}
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const checks: string[] = [];
function trigger(): any { return container.querySelector(".workspace-mode-trigger"); }
function menu(): any { return browser.document.querySelector('[role="menu"]'); }
function items(): any[] { return [...menu().querySelectorAll('[role="menuitemradio"]')]; }
async function click(element: any) { await act(async () => element.click()); }
async function key(target: any, key: string) {
  await act(async () => target.dispatchEvent(new browser.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
}

try {
  await act(async () => root.render(createElement(Host)));
  assert.equal(container.querySelectorAll("button").length, 1);
  assert.equal(trigger().getAttribute("aria-label"), "Workspace mode: Document");
  assert.equal(trigger().querySelector(".workspace-mode-label")?.textContent, "Document");
  assert.equal(trigger().getAttribute("aria-expanded"), "false");
  await click(trigger());
  assert.equal(menu().parentElement, browser.document.body, "The menu avoids sidebar clipping.");
  assert.equal(menu().getAttribute("aria-label"), "Workspace mode");
  assert.equal(trigger().getAttribute("aria-controls"), menu().id);
  assert.deepEqual(items().map((item) => item.textContent), ["Document", "Tiles", "Map"]);
  assert.deepEqual(items().map((item) => item.getAttribute("aria-checked")), ["true", "false", "false"]);
  assert.equal(browser.document.activeElement, items()[0]);
  checks.push("compact trigger identifies the current mode and exposes a portaled radio menu");

  await click(items()[1]);
  assert.deepEqual(selected, ["tiles"]);
  assert.equal(menu(), null);
  assert.equal(browser.document.activeElement, trigger());
  assert.equal(trigger().getAttribute("aria-label"), "Workspace mode: Tiles");
  assert.equal(trigger().querySelector(".workspace-mode-label")?.textContent, "Tiles");
  await click(trigger());
  assert.equal(browser.document.activeElement, items()[1]);
  assert.deepEqual(items().map((item) => item.getAttribute("aria-checked")), ["false", "true", "false"]);
  await click(items()[2]);
  assert.deepEqual(selected, ["tiles", "graph"]);
  assert.equal(trigger().getAttribute("aria-label"), "Workspace mode: Map");
  await click(trigger());
  await click(items()[0]);
  assert.deepEqual(selected, ["tiles", "graph", "chat"]);
  assert.equal(trigger().getAttribute("aria-label"), "Workspace mode: Document");
  checks.push("selecting any mode updates the visible indicator, checked item, and restores focus");

  await key(trigger(), "ArrowUp");
  assert.equal(browser.document.activeElement, items()[2]);
  await key(browser.document.activeElement, "ArrowDown");
  assert.equal(browser.document.activeElement, items()[0]);
  await key(browser.document.activeElement, "ArrowUp");
  assert.equal(browser.document.activeElement, items()[2]);
  await key(browser.document.activeElement, "Home");
  assert.equal(browser.document.activeElement, items()[0]);
  await key(browser.document.activeElement, "End");
  assert.equal(browser.document.activeElement, items()[2]);
  assert.deepEqual(selected, ["tiles", "graph", "chat"], "Moving focus does not change the current mode.");
  await key(browser.document.activeElement, "Escape");
  assert.equal(menu(), null);
  assert.equal(browser.document.activeElement, trigger());
  await key(trigger(), "ArrowDown");
  assert.equal(browser.document.activeElement, items()[0]);
  await key(browser.document.activeElement, "Escape");
  checks.push("arrow and endpoint navigation wraps without selecting; Escape returns focus");

  await click(trigger());
  await act(async () => browser.document.body.dispatchEvent(new browser.PointerEvent("pointerdown", { bubbles: true })));
  assert.equal(menu(), null);
  await click(trigger());
  await click(browser.document.body);
  assert.equal(menu(), null);
  await click(trigger());
  await click(trigger());
  assert.equal(menu(), null);
  checks.push("outside pointer, outside click, and trigger toggle all dismiss the menu");

  await click(trigger());
  await key(browser.document.activeElement, "Tab");
  assert.equal(menu(), null);
  await click(trigger());
  const outside = browser.document.createElement("button");
  browser.document.body.append(outside);
  await act(async () => outside.focus());
  assert.equal(menu(), null);
  assert.equal(browser.document.activeElement, outside, "Dismissal does not steal outside focus.");
  checks.push("Tab or moving focus outside dismisses the menu without trapping navigation");

  await click(trigger());
  await act(async () => changeMode("graph"));
  assert.equal(menu(), null);
  assert.equal(browser.document.activeElement, trigger());
  assert.equal(trigger().getAttribute("aria-label"), "Workspace mode: Map");
  checks.push("external mode changes close the menu and retain a useful focus target");

  await click(trigger());
  const beforeSelection = selected.length;
  await click(items()[2]);
  assert.equal(selected.length, beforeSelection + 1);
  assert.equal(menu(), null);
  assert.equal(trigger().getAttribute("aria-label"), "Workspace mode: Map");
  checks.push("selecting the current mode also dismisses the menu");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
