import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { buildChatOutline } from "../../client/src/lib/chatOutline";
import type { Conversation, MainViewMode, ThreadSummary } from "../../client/src/types";

const browser = new Window({ url: "http://sidebar-outline.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "PointerEvent"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  Object.defineProperty(globalThis, name, { configurable: true, value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: ThreadSidebar } = await import("../../client/src/components/ThreadSidebar");
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const events: string[] = [];
const documentSelections: Array<{ id: string; options?: { keepSidebarOpen?: boolean } }> = [];
const checks: string[] = [];
const noop = () => {};
const threads: ThreadSummary[] = [
  { id: "angular", title: "Angular", categoryId: "other", categoryLabel: "Other", conversationCount: 1, preview: "Angular concepts", updatedAt: "2026-09-25T00:00:00.000Z", updatedLabel: "now" },
  { id: "launch", title: "Launch planning", categoryId: "other", categoryLabel: "Other", conversationCount: 1, preview: "Launch plan", updatedAt: "2026-09-24T00:00:00.000Z", updatedLabel: "yesterday" },
  { id: "empty", title: "Empty document", categoryId: "other", categoryLabel: "Other", conversationCount: 1, preview: "", updatedAt: "2026-09-23T00:00:00.000Z", updatedLabel: "2 days ago" },
];
const outlines = {
  angular: buildChatOutline({ messages: [
    { id: "angular-prompt", role: "user", content: "What are the main Angular concepts?" },
    { id: "angular-answer", role: "assistant", content: "# Angular concepts\n\n## Components\n\n## Templates" },
  ] } as Conversation),
  launch: buildChatOutline({ messages: [
    { id: "launch-prompt", role: "user", content: "How should we launch?" },
    { id: "launch-answer", role: "assistant", content: "# Launch plan\n\n## First week" },
  ] } as Conversation),
  empty: [],
};
let changeDocument: (id: keyof typeof outlines) => void;

function Harness() {
  const [activeId, setActiveId] = useState<keyof typeof outlines>("angular");
  const [activeOutlineItemId, setActiveOutlineItemId] = useState<string | null>(null);
  const [collapsed, setCollapsed] = useState(false);
  const [mainViewMode, setMainViewMode] = useState<MainViewMode>("chat");
  const [mapExplorerActive, setMapExplorerActive] = useState(false);
  changeDocument = (id) => { setActiveId(id); setActiveOutlineItemId(null); };
  return createElement(ThreadSidebar, {
    header: createElement("div", { "data-testid": "workspace-brand-header" },
      createElement("strong", null, "Margin Chat"),
      createElement("button", {
        type: "button", "aria-label": collapsed ? "Expand left sidebar" : "Minimize left sidebar",
        onClick: () => setCollapsed((value) => !value),
      }, "Toggle sidebar"),
      ...([["chat", "document"], ["tiles", "tile"], ["graph", "map"]] as const).map(([mode, label]) => createElement("button", {
        key: mode, type: "button", "aria-label": `Open ${label} view`, "aria-pressed": mainViewMode === mode,
        onClick: () => { events.push(`view:${mode}`); setMainViewMode(mode); },
      }, label))),
    activeOutlineItemId, activeThreadId: activeId, collapsed,
    currentChatOutline: outlines[activeId], currentChatTitle: threads.find((thread) => thread.id === activeId)!.title,
    groups: {}, mainViewMode, mapExplorerActive, mapExplorerRef: noop,
    onSelectSidebarSection: (section) => setMapExplorerActive(section === "explore"),
    onAssignGroup: noop, onCreateGroup: noop, onDeleteThread: noop,
    onNewChat: () => events.push("new"), onNewNote: noop, onOpenInbox: () => events.push("inbox"),
    onOpenProfile: () => events.push("profile"), onOpenSettings: () => events.push("settings"),
    onOpenSearch: () => events.push("search"), onPinThread: noop, onRenameThread: noop,
    onSelectOutlineItem: (id) => { events.push(`outline:${activeId}:${id}`); setActiveOutlineItemId(id); },
    onSelectThread: (id, options) => {
      documentSelections.push({ id, options });
      events.push(`select:${id}`);
      changeDocument(id as keyof typeof outlines);
    },
    onToggleGroup: noop,
    onToggleTheme: () => events.push("theme"), onUnpinThread: noop,
    pinnedThreads: [threads[0]], streamingThreadIds: new Set<string>(), theme: "dark", threads,
  });
}

function element(selector: string) {
  const node = container.querySelector(selector);
  assert(node, `Missing ${selector}`);
  return node as unknown as HTMLElement;
}
function visible(selector: string) {
  const node = container.querySelector(selector);
  return Boolean(node && !node.closest("[hidden]"));
}
async function click(selector: string) {
  await act(async () => { element(selector).click(); });
}
async function clickText(text: string, selector = "button") {
  const node = [...container.querySelectorAll(selector)].find((button) => button.textContent?.trim() === text && !button.closest("[hidden]"));
  assert(node, `Missing visible button ${text}`);
  await act(async () => { (node as any).click(); });
}
function outline(title: string) {
  return element(`nav[aria-label="Outline for ${title}"].is-expanded-panel`);
}
function assertUtilitiesVisible() {
  for (const label of ["Open document view", "Open tile view", "Open map view", "New document", "Search documents", "More workspace actions", "Open profile", "Open settings", "Switch to light theme"]) {
    assert(visible(`[aria-label="${label}"]`), `${label} must remain reachable with an expanded outline.`);
  }
}

try {
  await act(async () => { root.render(createElement(Harness)); });
  assert.equal(container.querySelector(".thread-view-switcher"), null, "ThreadSidebar must not duplicate the workspace brand's view menu.");
  assert(element('[data-testid="workspace-brand-header"]').textContent?.includes("Margin Chat"));
  assert(element('[data-testid="workspace-brand-header"]').closest(".thread-sidebar"), "The optional mobile header must render inside the sidebar.");
  const list = element(".thread-list");
  list.scrollTop = 215;
  assert.equal(element('[aria-label="Show documents"]').getAttribute("aria-pressed"), "true");
  await click('[aria-label="Expand outline for Angular"]');
  const angularOutline = outline("Angular");
  assert.equal(angularOutline.closest(".thread-item"), null, "The expanded outline must use the sidebar body instead of a document row.");
  assert.equal(container.querySelector(".chat-outline.is-nested"), null);
  assert.equal(element('[aria-label="Show document outline"]').getAttribute("aria-pressed"), "true");
  assert.equal(element('[aria-label="Sidebar content"]').getAttribute("role"), "group");
  assert(!visible(".thread-list"));
  assertUtilitiesVisible();
  checks.push("opening a row outline uses the sidebar body while keeping shared controls reachable");

  await clickText("Components", ".outline-heading-link");
  assert.equal(events.at(-1), "outline:angular:heading-angular-answer-1");
  assert.equal(angularOutline.querySelector('[aria-current="location"]')?.textContent, "Components");
  await click('[aria-label="Collapse headings for ai response 1"]');
  assert.equal(angularOutline.querySelector(".outline-response-headings"), null);
  await clickText("AI response 1", ".outline-response-link");
  assert.equal(events.at(-1), "outline:angular:message-angular-answer");
  assert.equal(angularOutline.querySelector(".outline-response-headings"), null);
  checks.push("outline heading and response navigation keep independent disclosure state");

  await click('[aria-label="Show documents"]');
  assert(visible(".thread-list"));
  assert.equal(element(".thread-list"), list, "Document list must stay mounted while showing the outline.");
  assert.equal(list.scrollTop, 215);
  assert(!visible('nav[aria-label="Outline for Angular"]'));
  await click('[aria-label="Show document outline"]');
  assert.equal(outline("Angular"), angularOutline, "Switching sidebar content should retain the outline instance.");
  assert.equal(angularOutline.querySelector(".outline-response-headings"), null);
  assert(visible('[aria-label="Expand headings for ai response 1"]'));
  checks.push("switching Documents and Outline preserves list position and collapsed headings");

  for (const label of ["New document", "Search documents", "Open profile", "Open settings", "Switch to light theme"]) {
    await click(`[aria-label="${label}"]`);
  }
  await click('[aria-label="More workspace actions"]');
  await clickText("Cloud Inbox", ".sidebar-workspace-action");
  await click('[aria-label="Open tile view"]');
  await click('[aria-label="Open document view"]');
  for (const event of ["new", "search", "profile", "settings", "theme", "inbox", "view:tiles", "view:chat"]) assert(events.includes(event));
  assert(visible('nav[aria-label="Outline for Angular"]'));
  checks.push("creation, search, More, view switching, and footer actions work while the outline is open");

  await click('[aria-label="Show documents"]');
  await click('[aria-label="Expand outline for Launch planning"]');
  assert(events.includes("select:launch"));
  assert.deepEqual(documentSelections.at(-1), { id: "launch", options: { keepSidebarOpen: true } }, "Opening another document's outline must keep the mobile sidebar open.");
  assert(visible('nav[aria-label="Outline for Launch planning"]'));
  assert(outline("Launch planning").textContent?.includes("First week"));
  await clickText("First week", ".outline-heading-link");
  assert.equal(events.at(-1), "outline:launch:heading-launch-answer-1");
  await act(async () => { changeDocument("angular"); });
  assert(visible('nav[aria-label="Outline for Angular"]'));
  assert(outline("Angular").textContent?.includes("What are the main Angular concepts?"));
  assert(!outline("Angular").textContent?.includes("First week"));
  checks.push("inactive-row outline selection and later active-document changes show the correct document");

  await click('[aria-label="Show documents"]');
  await click('.thread-item-main[title="Empty document"]');
  assert.deepEqual(documentSelections.at(-1), { id: "empty", options: undefined }, "Ordinary document selection must retain its default sidebar behavior.");
  await click('[aria-label="Show document outline"]');
  assert(visible('nav[aria-label="Outline for Empty document"]'));
  assert(outline("Empty document").querySelector(".chat-outline-empty")?.textContent?.trim());
  assertUtilitiesVisible();
  checks.push("an empty document can open its outline with a useful empty state");

  await click('[aria-label="Minimize left sidebar"]');
  assert(visible(".thread-sidebar-mini-list"));
  assert(!visible('nav[aria-label="Outline for Empty document"]'));
  await click('[aria-label="Open document Launch planning"]');
  assert.equal(events.at(-1), "select:launch");
  await click('[aria-label="Expand left sidebar"]');
  assert(visible('nav[aria-label="Outline for Launch planning"]'));
  assertUtilitiesVisible();
  checks.push("the collapsed mini-list remains usable and reopening restores the active document outline");

  await click('[aria-label="Open map view"]');
  await clickText("Explore", ".map-sidebar-tabs button");
  assert(visible(".map-sidebar-explorer"));
  assert(!visible('nav[aria-label="Outline for Launch planning"]'));
  await clickText("Documents", ".map-sidebar-tabs button");
  assert(!visible(".map-sidebar-explorer"));
  assert(visible('nav[aria-label="Outline for Launch planning"]'));
  await click('[aria-label="Show documents"]');
  assert(visible(".thread-list"));
  checks.push("Map Explore takes over the sidebar body and returning restores outline or documents access");

  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => { root.unmount(); });
  await browser.happyDOM.abort();
}
