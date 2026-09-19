import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://sidebar.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "PointerEvent"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  Object.defineProperty(globalThis, name, { configurable: true, value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("../../client/node_modules/react/index.js");
const { createRoot } = await import("../../client/node_modules/react-dom/client.js");
const { default: ThreadSidebar } = await import("../../client/src/components/ThreadSidebar");
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const events: string[] = [];
const thread = {
  categoryId: "other", categoryLabel: "Other", conversationCount: 1,
  id: "chat", title: "Research", preview: "A sample chat",
  updatedAt: "2026-09-19T00:00:00.000Z", updatedLabel: "now",
};
const noop = () => {};
function element(selector: string) {
  const node = container.querySelector(selector);
  assert(node, `Expected ${selector}`);
  return node as any;
}
async function click(selector: string) {
  await act(async () => { element(selector).click(); });
}

try {
  await act(async () => {
    root.render(createElement(ThreadSidebar, {
      activeOutlineItemId: null, activeThreadId: "chat", collapsed: false,
      currentChatOutline: [], currentChatTitle: "Research", groups: {}, mainViewMode: "chat",
      onAssignGroup: (id, groupId) => events.push(`group:${id}:${groupId}`),
      onCreateGroup: (name) => events.push(`create:${name}`), onDeleteThread: noop,
      onNewChat: noop, onNewNote: () => events.push("note"), onOpenInbox: () => events.push("inbox"),
      onOpenProfile: noop, onOpenSettings: noop, onOpenSearch: noop,
      onPinThread: (id) => events.push(`pin:${id}`), onRenameThread: noop, onSelectOutlineItem: noop,
      onSetMainViewMode: noop, onSelectThread: noop, onToggleCollapse: noop, onToggleGroup: noop,
      onToggleTheme: noop, onUnpinThread: noop, pinnedThreads: [], streamingThreadIds: new Set(),
      theme: "dark", threads: [thread],
    }));
  });

  assert.equal(container.querySelector('[data-thread-drop-target="pinned"]'), null);
  await click(".sidebar-more-button");
  assert.equal(browser.document.activeElement, element(".sidebar-workspace-action"));
  await act(async () => {
    browser.document.activeElement!.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  assert.equal(container.querySelector(".sidebar-workspace-actions"), null);
  assert.equal(browser.document.activeElement, element(".sidebar-more-button"));

  await click(".sidebar-more-button");
  await click(".sidebar-workspace-action");
  assert(events.includes("note"));
  assert.equal(container.querySelector(".sidebar-workspace-actions"), null);

  await click(".sidebar-more-button");
  await click(".sidebar-workspace-action:last-child");
  assert(events.includes("inbox"));

  await click(".sidebar-more-button");
  await click(".sidebar-workspace-action:nth-child(2)");
  assert.equal(browser.document.activeElement, element('[aria-label="Group name"]'));
  await act(async () => {
    const input = element('[aria-label="Group name"]');
    const setValue = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!;
    setValue.call(input, "  Project  ");
    input.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  await click('button[type="submit"]');
  assert(events.includes("create:Project"));
  assert.equal(container.querySelector(".sidebar-workspace-actions"), null);
  assert.equal(browser.document.activeElement, element(".sidebar-more-button"));

  await click(".sidebar-more-button");
  await click(".sidebar-workspace-action:nth-child(2)");
  await act(async () => {
    element('[aria-label="Group name"]').dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  assert.equal(container.querySelector(".sidebar-workspace-actions"), null);
  assert.equal(browser.document.activeElement, element(".sidebar-more-button"));

  await click(".sidebar-more-button");
  await act(async () => { element(".sidebar-search-button").focus(); });
  assert.equal(container.querySelector(".sidebar-workspace-actions"), null);
  await click(".sidebar-more-button");
  await act(async () => {
    browser.document.body.dispatchEvent(new browser.PointerEvent("pointerdown", { bubbles: true }));
  });
  assert.equal(container.querySelector(".sidebar-workspace-actions"), null);

  const data = new Map<string, string>();
  const dataTransfer = {
    effectAllowed: "", dropEffect: "",
    setData: (type: string, value: string) => data.set(type, value),
    getData: (type: string) => data.get(type) ?? "",
  };
  async function drag(type: string, selector: string) {
    await act(async () => {
      const event = new browser.Event(type, { bubbles: true, cancelable: true });
      Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
      element(selector).dispatchEvent(event);
    });
  }
  await drag("dragstart", ".thread-item-main");
  assert(container.querySelector('[data-thread-drop-target="pinned"]'));
  await drag("drop", '[data-thread-drop-target="pinned"]');
  assert(events.includes("pin:chat"));
  assert.equal(container.querySelector('[data-thread-drop-target="pinned"]'), null);
  await drag("dragstart", ".thread-item-main");
  await drag("dragend", ".thread-item-main");
  assert.equal(container.querySelector('[data-thread-drop-target="pinned"]'), null);
  console.log("Sidebar action, keyboard dismissal, group creation, and drag/drop checks passed.");
} finally {
  await act(async () => { root.unmount(); });
  await browser.happyDOM.abort();
}
