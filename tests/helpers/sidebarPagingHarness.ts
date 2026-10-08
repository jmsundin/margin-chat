import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://sidebar.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "PointerEvent"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  Object.defineProperty(globalThis, name, { configurable: true, value });
}
// The list asks to be told when its end nears view; this records those requests.
const observers: Array<{ callback: (entries: Array<{ isIntersecting: boolean }>) => void; targets: Element[] }> = [];
(globalThis as any).IntersectionObserver = class {
  targets: Element[] = [];
  constructor(readonly callback: (entries: Array<{ isIntersecting: boolean }>) => void) { observers.push(this); }
  observe(target: Element) { this.targets.push(target); }
  disconnect() { observers.splice(observers.indexOf(this as any), 1); }
};
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: ThreadSidebar } = await import("../../client/src/components/ThreadSidebar");
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const threads = Array.from({ length: 500 }, (_, index) => ({
  categoryId: "other", categoryLabel: "Other", conversationCount: 1,
  id: `doc-${index}`, title: `Document ${index}`, preview: "",
  createdAt: new Date(Date.UTC(2026, 0, 1) - index * 60_000).toISOString(),
  updatedAt: "2026-09-19T00:00:00.000Z", updatedLabel: "now",
}));
const noop = () => {};
const rows = () => container.querySelectorAll("#sidebar-document-list > .thread-item").length;

async function render(activeThreadId: string) {
  await act(async () => {
    root.render(createElement(ThreadSidebar, {
      activeOutlineItemId: null, activeThreadId, collapsed: false,
      currentChatOutline: [], currentChatTitle: "", groups: {}, mainViewMode: "chat",
      onAssignGroup: noop, onCreateGroup: noop, onDeleteThread: noop, onNewChat: noop, onNewNote: noop, onOpenInbox: noop,
      onOpenProfile: noop, onOpenSettings: noop, onOpenSearch: noop, onPinThread: noop, onRenameThread: noop,
      onSelectOutlineItem: noop, onSelectThread: noop, onToggleGroup: noop, onToggleTheme: noop, onUnpinThread: noop,
      pinnedThreads: [], streamingThreadIds: new Set(), theme: "dark", threads,
    } as any));
  });
}

try {
  await render("doc-0");
  assert.equal(rows(), 150, "The first page of documents did not render alone.");
  assert(container.querySelector(".thread-list-more"), "The end of the first page is not watched.");
  await act(async () => { observers.at(-1)!.callback([{ isIntersecting: true }]); });
  assert.equal(rows(), 300, "Scrolling to the end did not render the next page.");
  await render("doc-420");
  assert.equal(rows(), 421, "The open document beyond the loaded pages is not listed.");
  assert(container.querySelector('.thread-item.is-active .thread-item-main[title="Document 420"]'));
  await act(async () => { observers.at(-1)!.callback([{ isIntersecting: true }]); });
  assert.equal(rows(), 500);
  assert.equal(container.querySelector(".thread-list-more"), null, "A finished list still waits for more.");
  console.log("Sidebar paging checks passed.");
} finally {
  await act(async () => { root.unmount(); });
  await browser.happyDOM.abort();
}
