import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://sidebar.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "PointerEvent"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  Object.defineProperty(globalThis, name, { configurable: true, value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
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
const sideThread = { ...thread, id: "side-document", title: "Side research" };
const noop = () => {};
function element(selector: string) {
  const node = container.querySelector(selector);
  assert(node, `Expected ${selector}`);
  return node as any;
}
async function click(selector: string) {
  await act(async () => { element(selector).click(); });
}

async function renderSidebar(collapsed = false) {
  await act(async () => {
    root.render(createElement(ThreadSidebar, {
      activeOutlineItemId: null, activeThreadId: "side-document", collapsed,
      currentChatOutline: [], currentChatTitle: "Research", groups: {}, mainViewMode: "chat",
      onAssignGroup: (id, groupId) => events.push(`group:${id}:${groupId}`),
      onCreateGroup: (name) => events.push(`create:${name}`), onDeleteThread: noop,
      onNewChat: () => events.push("document"), onNewNote: () => events.push("note"), onOpenInbox: () => events.push("inbox"),
      onOpenProfile: noop, onOpenSettings: noop, onOpenSearch: noop,
      onPinThread: (id) => events.push(`pin:${id}`), onRenameThread: noop, onSelectOutlineItem: noop,
      onSelectThread: (id) => events.push(`select:${id}`), onToggleGroup: noop,
      onToggleTheme: noop, onUnpinThread: noop, pinnedThreads: [], streamingThreadIds: new Set(),
      theme: "dark", threads: [thread, sideThread],
    }));
  });
}

try {
  await renderSidebar();

  assert.equal(container.querySelector('[data-thread-drop-target="pinned"]'), null);
  await click('[aria-label="New document"]');
  assert(events.includes("document"), "The primary creation action opens a unified document.");
  assert.equal(container.querySelector('[aria-label="New side document"]'), null, "Side document creation lives beside the active tab.");
  await click('.thread-item-main[title="Side research"]');
  assert(events.includes("select:side-document"), "A side document has its own selectable sidebar entry.");
  assert.equal(element('.thread-item.is-active .thread-item-main').title, "Side research");
  assert.equal(container.querySelector('[aria-label="New note"]'), null, "Separate chat/note creation should not remain in the unified interface.");
  await click(".sidebar-more-button");
  assert.equal(browser.document.activeElement, element(".sidebar-workspace-action"));
  await act(async () => {
    browser.document.activeElement!.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true }));
  });
  assert.equal(container.querySelector(".sidebar-workspace-actions"), null);
  assert.equal(browser.document.activeElement, element(".sidebar-more-button"));

  await click(".sidebar-more-button");
  await click(".sidebar-workspace-action:last-child");
  assert(events.includes("inbox"));

  await click(".sidebar-more-button");
  await click(".sidebar-workspace-action:first-child");
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
  await click(".sidebar-workspace-action:first-child");
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
  await renderSidebar(true);
  assert.equal(container.querySelector('[aria-label="New side document"]'), null);
  await click('[aria-label="Open document Side research"]');
  assert.equal(events.at(-1), "select:side-document");
  console.log("Sidebar action, keyboard dismissal, group creation, and drag/drop checks passed.");
} finally {
  await act(async () => { root.unmount(); });
  await browser.happyDOM.abort();
}
