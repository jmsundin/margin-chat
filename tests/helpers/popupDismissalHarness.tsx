import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://popup-dismissal.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement: el, useRef, useState } = await import("react");
const { createPortal } = await import("react-dom");
const { createRoot } = await import("react-dom/client");
const { useOutsideDismiss } = await import("../../client/src/lib/useOutsideDismiss");
const { default: DismissibleDetails } = await import("../../client/src/components/DismissibleDetails");
const { default: ChatHistoryImport } = await import("../../client/src/components/ChatHistoryImport");
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);

function Host() {
  const [open, setOpen] = useState(false);
  const [modal, setModal] = useState(false);
  const popup = useRef<HTMLDivElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  useOutsideDismiss(open, () => setOpen(false), popup, trigger);
  return el("div", null,
    el("button", { ref: trigger, "data-trigger": true, onClick: () => setOpen((value) => !value) }, "Toggle popup"),
    el("button", { "data-outside": true, onPointerDown: (event: any) => event.stopPropagation(), onClick: (event: any) => event.stopPropagation() }, "Outside"),
    open ? el("div", { ref: popup, "data-popup": true },
      el("input", { "aria-label": "Popup input" }),
      el("button", { "data-open-modal": true, onClick: () => setModal(true) }, "Open modal"),
      modal ? createPortal(el("div", { "data-backdrop": true, onClick: () => setModal(false) },
        el("section", { role: "dialog", "aria-modal": "true", onClick: (event: any) => event.stopPropagation() },
          el(DismissibleDetails, null, el("summary", null, "Nested menu"), el("button", { "data-menu-item": true }, "Menu action")),
          el("button", { "data-modal-control": true }, "Modal control"))), document.body) : null) : null);
}

const find = (selector: string) => {
  const node = browser.document.querySelector(selector);
  assert(node, `Missing ${selector}`);
  return node as unknown as HTMLElement;
};
const click = async (selector: string) => { await act(async () => find(selector).click()); };
try {
  await act(async () => root.render(el(Host)));
  await click("[data-trigger]");
  await click("input");
  assert(find("[data-popup]"));
  await act(async () => find("[data-outside]").dispatchEvent(new browser.PointerEvent("pointerdown", { bubbles: true }) as unknown as Event));
  assert.equal(browser.document.querySelector("[data-popup]"), null, "Capture handles outside controls that stop propagation");
  await click("[data-trigger]");
  await click("[data-outside]");
  assert.equal(browser.document.querySelector("[data-popup]"), null, "Click-only activation dismisses the popup");
  await click("[data-trigger]");
  await click("[data-trigger]");
  assert.equal(browser.document.querySelector("[data-popup]"), null, "Trigger click toggles without reopening on the same gesture");
  await click("[data-trigger]");
  await click("[data-open-modal]");
  await click("[data-modal-control]");
  assert(find("[data-popup]"), "Using a nested portal keeps its owner mounted");
  const details = find("details") as HTMLDetailsElement;
  await act(async () => { details.open = true; details.dispatchEvent(new browser.Event("toggle") as unknown as Event); });
  await click("[data-menu-item]");
  assert(details.open, "Clicking a menu item does not dismiss its menu before its action");
  await click("[data-modal-control]");
  assert.equal(details.open, false, "A popup inside a modal still dismisses outside its boundary");
  await click("[data-backdrop]");
  assert.equal(browser.document.querySelector('[role="dialog"]'), null);
  assert(find("[data-popup]"), "Closing the nested modal preserves its underlying popup");
  await click("[data-outside]");
  assert.equal(browser.document.querySelector("[data-popup]"), null);

  let closed = 0;
  await act(async () => root.render(el(ChatHistoryImport, {
    existingIds: [], cloudSyncEnabled: false,
    onImport: async () => ({ conversationIds: [], skipped: 0, files: {} }),
    onUndo: async () => ({ removed: 0, kept: 0 }), onOpenChat() {}, onClose() { closed++; },
  })));
  const dialog = find("dialog");
  dialog.getBoundingClientRect = () => ({ left: 40, top: 40, right: 240, bottom: 240, width: 200, height: 200, x: 40, y: 40, toJSON() {} });
  await act(async () => dialog.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, clientX: 80, clientY: 80 }) as unknown as Event));
  assert.equal(closed, 0, "Blank space inside a native dialog is not its backdrop");
  await act(async () => dialog.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, clientX: 10, clientY: 10 }) as unknown as Event));
  assert.equal(closed, 1, "Native dialog backdrop clicks dismiss history import");
  console.log("Popup dismissal checks passed.");
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
