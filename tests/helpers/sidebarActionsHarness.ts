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

async function renderSidebar(collapsed = false, revealInFolder?: unknown) {
  await act(async () => {
    root.render(createElement(ThreadSidebar, {
      activeOutlineItemId: null, activeThreadId: "side-document", collapsed,
      currentChatOutline: [], currentChatTitle: "Research", groups: {}, mainViewMode: "chat",
      onAssignGroup: (id, groupId) => events.push(`group:${id}:${groupId}`),
      onCreateGroup: (name) => events.push(`create:${name}`), onDeleteThread: noop,
      onNewChat: () => events.push("document"), onNewNote: () => events.push("note"), onOpenInbox: () => events.push("inbox"),
      onOpenProfile: noop, onOpenSearch: noop,
      onPinThread: (id) => events.push(`pin:${id}`), onRenameThread: noop, onSelectOutlineItem: noop,
      onSelectThread: (id) => events.push(`select:${id}`), onToggleGroup: noop,
      onToggleTheme: noop, onUnpinThread: noop, pinnedThreads: [], streamingThreadIds: new Set(),
      theme: "dark", threads: [thread, sideThread], revealInFolder,
    } as never));
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
  // Dragging a document carries it for the space button by the tabs; the left panel has no drop sections.
  await drag("dragstart", ".thread-item-main");
  assert.equal(data.get("application/x-margin-document"), "chat");
  assert.equal(container.querySelector('[data-thread-drop-target]'), null);
  await drag("dragend", ".thread-item-main");
  assert.equal(container.querySelector('[aria-label="Show groups"]'), null, "Groups live in Tile view, not a sidebar tab.");
  assert.equal(container.querySelector('[aria-label="Show spaces"]'), null, "Spaces live in Tile view, not a sidebar tab.");
  // Reveal in Finder: only with the desktop app's vault folder, and only for documents with a file there.
  // The menu renders at the page level (so a docked Map or roadmap cannot cover it), not inside the sidebar.
  const menuItem = (label: string) => [...browser.document.querySelectorAll('.thread-item-menu [role="menuitem"]')]
    .find((node) => node.textContent?.trim() === label) as any;
  await click('[aria-label="Open actions for Research"]');
  assert(menuItem("Rename"), "The document menu opens.");
  assert.equal(menuItem("Reveal in Finder"), undefined, "Browsers have no Reveal in Finder.");
  await click('[aria-label="Open actions for Research"]');
  await renderSidebar(false, { label: "Reveal in Finder", canReveal: (id: string) => id === "chat", onReveal: (id: string) => events.push(`reveal:${id}`) });
  await click('[aria-label="Open actions for Side research"]');
  assert(menuItem("Rename"));
  assert.equal(menuItem("Reveal in Finder"), undefined, "A document with no file in the folder yet has nothing to reveal.");
  await click('[aria-label="Open actions for Side research"]');
  await click('[aria-label="Open actions for Research"]');
  await act(async () => { menuItem("Reveal in Finder").click(); });
  assert.equal(events.at(-1), "reveal:chat");
  assert.equal(browser.document.querySelector(".thread-item-menu"), null, "The menu closes after revealing.");

  // A document's menu opens pickers to move it into a space or a group.
  const { SpaceMenuContext } = await import("../../client/src/components/Spaces");
  const inSpaces = new Set<string>();
  const spaceActions = {
    spaces: [{ id: "space-1", name: "Thesis", color: "#4f7bdf" }] as never[],
    isIn: (spaceId: string, documentId: string) => inSpaces.has(`${spaceId}:${documentId}`),
    onToggle: (spaceId: string, documentId: string) => { events.push(`space:${spaceId}:${documentId}`); },
    onCreateWith: (documentId: string, name?: string) => { events.push(`new-space:${documentId}:${name}`); },
  };
  await act(async () => {
    root.render(createElement(SpaceMenuContext.Provider, { value: spaceActions as never }, createElement(ThreadSidebar, {
      activeOutlineItemId: null, activeThreadId: "side-document", collapsed: false,
      currentChatOutline: [], currentChatTitle: "Research", mainViewMode: "chat",
      groups: { reading: { id: "reading", name: "Reading", color: "#4fbf9f", collapsed: false, conversationIds: [] } },
      onAssignGroup: (id: string, groupId: string | null) => events.push(`group:${id}:${groupId}`),
      onCreateGroup: noop, onDeleteThread: noop, onNewChat: noop, onNewNote: noop, onOpenProfile: noop, onOpenSearch: noop,
      onPinThread: noop, onRenameThread: noop, onSelectOutlineItem: noop, onSelectThread: noop, onToggleGroup: noop,
      onToggleTheme: noop, onUnpinThread: noop, pinnedThreads: [], streamingThreadIds: new Set(),
      theme: "dark", threads: [thread, sideThread],
    } as never)));
  });
  // The menu stays short: one item each opens a picker to search or choose a space or a group.
  await click('[aria-label="Open actions for Research"]');
  assert.equal(browser.document.querySelector('[role="menuitemcheckbox"], [role="menuitemradio"]'), null, "Spaces and groups are not listed inline.");
  const spaceItem = [...browser.document.querySelectorAll('.thread-item-menu [role="menuitem"]')].find((node) => node.textContent?.startsWith("Add to space…")) as any;
  assert(spaceItem, "The menu has Add to space….");
  assert.equal(spaceItem.getAttribute("aria-haspopup"), "dialog");
  await act(async () => { spaceItem.click(); });
  assert.equal(browser.document.querySelector(".thread-item-menu"), null, "The menu closes when the picker opens.");
  let dialog = browser.document.querySelector('[role="dialog"]') as any;
  assert.equal(dialog.querySelector("h2").textContent, "Add to spaces");
  assert.match(dialog.textContent, /isn’t in a space yet/);
  const spaceOptions = () => [...browser.document.querySelectorAll('[role="dialog"] [role="option"]')].map((option: any) => Object.assign(option, { label: option.querySelector(".group-picker-option-name").textContent })) as any[];
  assert.deepEqual(spaceOptions().map((option) => option.label), ["Thesis", "New space with this"]);
  await act(async () => { spaceOptions()[0].click(); });
  assert.equal(events.at(-1), "space:space-1:chat");
  assert(browser.document.querySelector('[role="dialog"]'), "Ticking a space keeps the picker open for another.");
  const search = browser.document.querySelector('[aria-label="Search spaces"]') as any;
  await act(async () => {
    const setValue = Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!;
    setValue.call(search, "Health");
    search.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  assert.deepEqual(spaceOptions().map((option) => option.label), ["New space “Health”"], "Searching filters, and offers a new space with that name.");
  await act(async () => { spaceOptions()[0].click(); });
  assert.equal(events.at(-1), "new-space:chat:Health");
  assert.equal(browser.document.querySelector('[role="dialog"]'), null, "Making a space closes the picker.");

  await click('[aria-label="Open actions for Research"]');
  const groupItem = [...browser.document.querySelectorAll('.thread-item-menu [role="menuitem"]')].find((node) => node.textContent?.startsWith("Add to group…")) as any;
  assert(groupItem, "The menu has Add to group….");
  await act(async () => { groupItem.click(); });
  dialog = browser.document.querySelector('[role="dialog"]') as any;
  assert.equal(dialog.querySelector("h2").textContent, "Choose a group");
  const reading = [...dialog.querySelectorAll('[role="option"]')].find((node: any) => node.textContent.includes("Reading")) as any;
  await act(async () => { reading.click(); });
  assert.equal(events.at(-1), "group:chat:reading");
  assert.equal(browser.document.querySelector('[role="dialog"]'), null, "Picking a group closes the picker.");

  await renderSidebar(true);
  assert.equal(container.querySelector('[aria-label="New side document"]'), null);
  await click('[aria-label="Open document Side research"]');
  assert.equal(events.at(-1), "select:side-document");
  console.log("Sidebar action, keyboard dismissal, group creation, and Add to space/group picker checks passed.");
} finally {
  await act(async () => { root.unmount(); });
  await browser.happyDOM.abort();
}
