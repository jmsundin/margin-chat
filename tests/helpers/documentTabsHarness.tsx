import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { Conversation, ConversationGroup } from "../../client/src/types";

const browser = new Window({ url: "http://document-tabs.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  Object.defineProperty(globalThis, name, { configurable: true, value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: DocumentTabs } = await import("../../client/src/components/DocumentTabs");
const { ConversationGroupPickerContext } = await import("../../client/src/components/ConversationGroupControls");
const { assignConversationToGroup } = await import("../../client/src/lib/conversationGroups");
const { createMainConversation } = await import("../../client/src/initialState");
const initial: Conversation[] = ["Main", "Side", "Nested"].map((title, index) => ({
  ...createMainConversation({ id: title.toLowerCase(), createdAt: "2026-09-23T00:00:00.000Z" }),
  title, parentId: index ? ["main", "side"][index - 1] : null,
}));
let current = initial;
let selected: string[] = [];
const minimized: string[] = [];
const reorders: string[][] = [];
const sideSources: string[] = [];
const pinToggles: string[] = [];
const scopeToggles: string[] = [];
const groupAssignments: [string, string | null][] = [];
const groupCreations: [string, string][] = [];
let blockedReorderTarget: string | null = null;
let removeOnNextScopeToggle = false;
let replaceDocuments: (documents: Conversation[]) => void;
let enableGroups: (enabled: boolean) => void;
function Host() {
  const [documents, setDocuments] = useState(initial);
  const [active, setActive] = useState("main");
  const [hidden, setHidden] = useState<string[]>(["nested"]);
  const [pinned, setPinned] = useState<string[]>([]);
  const [familyPinned, setFamilyPinned] = useState<string[]>([]);
  const [groupsEnabled, setGroupsEnabled] = useState(false);
  const [groups, setGroups] = useState<Record<string, ConversationGroup>>({
    coding: { id: "coding", name: "Coding", color: "#4fbf9f", collapsed: false, conversationIds: ["main"] },
    research: { id: "research", name: "Research", color: "#6f88ff", collapsed: false, conversationIds: [] },
  });
  current = documents;
  replaceDocuments = setDocuments;
  enableGroups = setGroupsEnabled;
  return createElement(ConversationGroupPickerContext.Provider, { value: {
    getSuggestion: () => ({ name: "New ideas" }),
    onCreateAndAssign: (id, name) => groupCreations.push([id, name]),
  } }, createElement(DocumentTabs, { documents, activeDocumentId: active, minimizedDocumentIds: hidden,
    groups,
    onAssignGroup: groupsEnabled ? (id, groupId) => {
      groupAssignments.push([id, groupId]);
      setGroups((current) => assignConversationToGroup(current, id, groupId));
    } : undefined,
    pinnedDocumentIds: pinned,
    onTogglePin(id) { pinToggles.push(id); setPinned((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]); },
    familyPinnedDocumentIds: familyPinned,
    onTogglePinScope(id) {
      scopeToggles.push(id);
      setFamilyPinned((ids) => ids.includes(id) ? ids.filter((item) => item !== id) : [...ids, id]);
      if (removeOnNextScopeToggle) { removeOnNextScopeToggle = false; setDocuments((items) => items.filter((item) => item.id !== id)); setActive("main"); }
    },
    canReorder(_id, targetId) { return targetId !== blockedReorderTarget; },
    onNewSideDocument() { sideSources.push(active); },
    onSelect(id) { selected.push(id); setActive(id); setHidden((ids) => ids.filter((item) => item !== id)); },
    onMinimize(id) { minimized.push(id); setHidden((ids) => [...ids, id]); },
    onReorder(id, targetId) {
      reorders.push([id, targetId]);
      setDocuments((items) => {
        const reordered = items.filter((item) => item.id !== id);
        reordered.splice(items.findIndex((item) => item.id === targetId), 0, items.find((item) => item.id === id)!);
        return reordered;
      });
    },
  }));
}
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const checks: string[] = [];
function item(id: string): any {
  const element = container.querySelector(`[data-document-tab-id="${id}"]`);
  assert(element, `Missing tab ${id}`);
  return element;
}
function tab(id: string): any { return item(id).querySelector('[role="tab"]'); }
async function press(id: string, key: string, altKey = false) {
  await act(async () => { tab(id).dispatchEvent(new browser.KeyboardEvent("keydown", { key, altKey, bubbles: true, cancelable: true })); });
}
async function click(element: any) { await act(async () => element.click()); }
const dataTransfer = { effectAllowed: "", dropEffect: "", values: {} as Record<string, string>, setData(type: string, data: string) { this.values[type] = data; } };
async function drag(id: string, eventType: string) {
  const event = new browser.Event(eventType, { bubbles: true, cancelable: true });
  Object.defineProperty(event, "dataTransfer", { value: dataTransfer });
  await act(async () => item(id).dispatchEvent(event));
  return event;
}
async function pointer(target: any, type: string, clientX: number, clientY = 20, pointerType = "mouse") {
  const event = new browser.PointerEvent(type, { pointerId: 7, isPrimary: true, pointerType, button: 0, clientX, clientY, bubbles: true, cancelable: true });
  await act(async () => target.dispatchEvent(event));
  return event;
}
async function pointerClick(target: any) {
  await act(async () => target.dispatchEvent(new browser.MouseEvent("click", { detail: 1, bubbles: true, cancelable: true })));
}
try {
  await act(async () => root.render(createElement(Host)));
  assert.equal(container.querySelectorAll('[role="tab"]').length, 3);
  assert.equal(tab("main").getAttribute("aria-selected"), "true");
  assert.equal(tab("main").tabIndex, 0);
  assert.equal(tab("side").tabIndex, -1);
  assert.equal(item("main").querySelector(".document-tab-minimize"), null, "Main documents have no minimize control.");
  assert.equal(container.querySelector(".document-tab-minimize"), null, "Minimize actions live only in document menus.");
  assert(tab("nested").getAttribute("aria-label").includes("minimized"));
  assert(container.querySelector(`#${tab("main").getAttribute("aria-describedby")}`)?.textContent.includes("Alt"));
  checks.push("tabs expose active, minimized, and side-only minimize states with keyboard instructions");

  assert.equal(container.querySelectorAll('.document-tab-menu-trigger').length, 3, "Every document has an options menu, including the main and minimized documents.");
  const options = item("main").querySelector('.document-tab-menu-trigger');
  assert.equal(item("main").lastElementChild, options, "Options are at the right edge of each tab.");
  await pointer(options, "pointerdown", 80);
  await pointer(browser, "pointermove", 400);
  await pointer(browser, "pointerup", 400);
  assert.equal(container.querySelector(".is-dragging"), null, "Options cannot begin a tab drag.");
  await click(options);
  let menu = browser.document.querySelector('[role="menu"]');
  assert(menu);
  assert.equal(menu.parentElement, browser.document.body, "The menu is portaled outside the scrolling tab strip.");
  assert.equal(options.getAttribute("aria-expanded"), "true");
  assert.equal(menu.querySelector('[role="menuitem"]')?.textContent, "Pin document");
  assert.equal(menu.querySelector('[role="menuitemcheckbox"]'), null, "Pane scope is available after a document is pinned.");
  assert.equal(browser.document.activeElement, menu.querySelector('[role="menuitem"]'));
  await click(menu.querySelector('[role="menuitem"]'));
  assert.deepEqual(pinToggles, ["main"]);
  assert.equal(browser.document.querySelector('[role="menu"]'), null);
  assert.equal(browser.document.activeElement, options, "Choosing a menu action restores focus to its trigger.");
  assert(item("main").querySelector('.document-tab-pin'));
  assert(tab("main").getAttribute("aria-label").includes("pinned"));
  assert.deepEqual(selected, []);
  assert.deepEqual(reorders, []);
  await click(options);
  menu = browser.document.querySelector('[role="menu"]');
  assert.equal(menu?.querySelector('[role="menuitem"]')?.textContent, "Unpin document");
  let scope = menu?.querySelector('[role="menuitemcheckbox"]');
  assert(scope?.textContent.includes("Keep visible across documents"));
  assert.equal(scope?.getAttribute("aria-checked"), "true", "Pinned panes default to visibility across documents.");
  await act(async () => browser.document.activeElement?.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
  assert.equal(browser.document.activeElement, scope, "Arrow navigation reaches the pin scope checkbox.");
  await click(scope);
  assert.deepEqual(scopeToggles, ["main"]);
  assert.equal(browser.document.querySelector('[role="menu"]'), null);
  assert.equal(browser.document.activeElement, options);
  await click(options);
  menu = browser.document.querySelector('[role="menu"]');
  scope = menu?.querySelector('[role="menuitemcheckbox"]');
  assert.equal(scope?.getAttribute("aria-checked"), "false", "A family-scoped pin clears the cross-document checkbox.");
  await act(async () => browser.document.activeElement?.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })));
  assert.equal(browser.document.activeElement, scope);
  await act(async () => browser.document.activeElement?.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
  assert.equal(browser.document.activeElement, menu?.querySelector('[role="menuitem"]'), "Menu arrow navigation wraps.");
  await click(scope);
  assert.deepEqual(scopeToggles, ["main", "main"]);
  assert.deepEqual(selected, []);
  assert.deepEqual(reorders, []);
  await click(options);
  menu = browser.document.querySelector('[role="menu"]');
  assert.equal(menu?.querySelector('[role="menuitemcheckbox"]')?.getAttribute("aria-checked"), "true");
  checks.push("pinned pane menus toggle cross-document visibility with an accessible checked state and keyboard navigation");
  await click(menu?.querySelector('[role="menuitem"]'));
  assert.deepEqual(pinToggles, ["main", "main"]);
  assert.equal(item("main").querySelector('.document-tab-pin'), null);
  checks.push("right-edge menus pin and unpin documents without selecting or reordering them and restore keyboard focus");

  await click(options);
  await act(async () => browser.document.activeElement?.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  assert.equal(browser.document.querySelector('[role="menu"]'), null);
  assert.equal(browser.document.activeElement, options);
  await click(options);
  await pointer(browser.document.body, "pointerdown", 700);
  assert.equal(browser.document.querySelector('[role="menu"]'), null, "An outside pointer dismisses the menu.");
  await click(options);
  await click(browser.document.body);
  assert.equal(browser.document.querySelector('[role="menu"]'), null, "An outside accessibility click dismisses the menu.");
  await click(options);
  await act(async () => browser.document.activeElement?.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Tab", bubbles: true, cancelable: true })));
  assert.equal(browser.document.querySelector('[role="menu"]'), null);
  checks.push("Escape and outside interactions dismiss the popup while Tab exits it without trapping keyboard focus");

  await click(item("side").querySelector('.document-tab-menu-trigger'));
  await click(browser.document.querySelector('[role="menuitem"]'));
  assert.equal(item("side").querySelector('.document-tab-minimize'), null, "Pinned side documents are unpinned through their menu before minimizing.");
  await click(item("side").querySelector('.document-tab-menu-trigger'));
  await click(browser.document.querySelector('[role="menuitem"]'));
  await click(item("side").querySelector('.document-tab-menu-trigger'));
  assert([...browser.document.querySelectorAll('[role="menuitem"]')].some((item) => item.textContent === "Minimize document"), "Unpinning restores the menu minimize action.");
  await click(item("side").querySelector('.document-tab-menu-trigger'));

  const createSide = container.querySelector('[aria-label="New side document"]')!;
  assert.equal(createSide.closest('[role="tablist"]'), null, "The creation action is separate from tab keyboard semantics.");
  assert.equal(Number((createSide as any).style.order), Number(item("main").style.order) + 1);
  await click(createSide);
  assert.deepEqual(sideSources, ["main"]);

  await act(async () => tab("main").focus());
  await press("main", "ArrowRight");
  assert(browser.document.activeElement === tab("side"));
  assert.deepEqual(selected, [], "Arrow navigation does not change the document or restore minimized panels.");
  await press("side", "End");
  assert(browser.document.activeElement === tab("nested"));
  await press("nested", "ArrowRight");
  assert(browser.document.activeElement === tab("main"));
  await press("main", "ArrowLeft");
  assert(browser.document.activeElement === tab("nested"));
  await press("nested", "Home");
  assert(browser.document.activeElement === tab("main"));
  checks.push("arrow, Home, and End keys move focus without selecting documents");

  await click(tab("nested"));
  assert.deepEqual(selected, ["nested"]);
  assert.equal(Number((createSide as any).style.order), Number(item("nested").style.order) + 1, "Side creation follows the active tab.");
  await click(createSide);
  assert.deepEqual(sideSources, ["main", "nested"]);
  assert.equal(tab("nested").getAttribute("aria-selected"), "true");
  assert(!item("nested").classList.contains("is-minimized"));
  assert.equal(item("nested").querySelector(".document-tab-minimize"), null);
  const sideOptions = item("side").querySelector('.document-tab-menu-trigger');
  await click(sideOptions);
  await click([...browser.document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === "Minimize document"));
  assert.deepEqual(minimized, ["side"]);
  assert.deepEqual(selected, ["nested"], "Minimizing never selects the clicked tab.");
  assert(item("side").classList.contains("is-minimized"));
  assert(browser.document.activeElement === sideOptions, "Minimizing restores focus to the persistent options button.");
  await click(sideOptions);
  assert.equal([...browser.document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === "Minimize document"), undefined);
  await click([...browser.document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent === "Restore document"));
  assert.deepEqual(selected, ["nested", "side"]);
  assert(!item("side").classList.contains("is-minimized"));
  checks.push("menu minimization preserves the tab and restores it from the same menu");

  await act(async () => tab("nested").focus());
  await press("nested", "ArrowLeft", true);
  assert.deepEqual(current.map((document) => document.id), ["main", "nested", "side"]);
  assert.deepEqual(reorders, [["nested", "side"]]);
  assert(browser.document.activeElement === tab("nested"));
  assert(container.querySelector('[role="status"]')?.textContent.includes("position 2 of 3"));
  await press("nested", "ArrowLeft", true);
  assert.deepEqual(current.map((document) => document.id), ["nested", "main", "side"]);
  await press("nested", "ArrowLeft", true);
  assert.equal(reorders.length, 2, "Reordering at an edge is a no-op.");
  assert.equal(current.find((document) => document.id === "nested")?.parentId, "side");
  assert.deepEqual(selected, ["nested", "side"]);
  checks.push("Alt-arrow reorders visual positions without changing focus, selection, or relationships");

  const beforeRejectedMove = container.querySelector('[role="status"]')?.textContent;
  blockedReorderTarget = "main";
  await press("nested", "ArrowRight", true);
  assert.equal(reorders.length, 2, "Cross-family reorder attempts do not call the mutation handler.");
  assert.deepEqual(current.map((document) => document.id), ["nested", "main", "side"]);
  assert.equal(container.querySelector('[role="status"]')?.textContent, beforeRejectedMove, "Rejected moves do not announce a changed position.");
  blockedReorderTarget = null;
  checks.push("rejected reorder targets preserve positions and do not announce movement");

  await drag("nested", "dragstart");
  assert.equal(dataTransfer.values["application/x-margin-document"], "nested");
  assert.equal((await drag("side", "dragover")).defaultPrevented, true);
  assert(item("side").classList.contains("is-drop-target"));
  await drag("side", "drop");
  assert.deepEqual(current.map((document) => document.id), ["main", "side", "nested"]);
  assert.deepEqual(reorders.at(-1), ["nested", "side"]);
  assert.equal(container.querySelector(".is-dragging, .is-drop-target"), null);
  const count = reorders.length;
  await drag("main", "drop");
  assert.equal(reorders.length, count, "Unrelated drops cannot reorder document tabs.");
  await drag("main", "dragstart");
  await drag("main", "drop");
  assert.equal(reorders.length, count, "Dropping on the same tab is a no-op.");
  assert.equal(current.find((document) => document.id === "nested")?.parentId, "side");
  checks.push("native dragging moves to the destination index while unrelated and same-tab drops do nothing");

  const strip = container.querySelector(".document-tabs")!;
  strip.getBoundingClientRect = () => new browser.DOMRect(0, 0, 480, 40);
  for (const document of initial) item(document.id).getBoundingClientRect = () => new browser.DOMRect(current.findIndex((item) => item.id === document.id) * 160, 0, 160, 40);
  const selectedBeforeDrag = selected.length;
  await pointer(tab("main"), "pointerdown", 80);
  assert.equal((await drag("main", "dragstart")).defaultPrevented, true, "Native HTML dragging cannot take over a pointer gesture.");
  await pointer(browser, "pointermove", 400);
  assert(item("nested").classList.contains("is-drop-target"));
  assert(item("nested").classList.contains("is-drop-after"));
  await pointer(browser, "pointerup", 400);
  assert.deepEqual(current.map((document) => document.id), ["side", "nested", "main"]);
  assert.deepEqual(reorders.at(-1), ["main", "nested"]);
  const afterPointerCount = reorders.length;
  await drag("side", "drop");
  assert.equal(reorders.length, afterPointerCount, "A completed pointer drag cannot also commit a native drop.");
  await pointerClick(tab("main"));
  assert.equal(selected.length, selectedBeforeDrag, "The click generated after releasing a dragged tab never selects it.");
  assert.equal(container.querySelector(".is-dragging, .is-drop-target"), null);
  checks.push("pointer dragging works from tab buttons with one reorder and no accidental release click");

  await pointer(tab("side"), "pointerdown", 80);
  await pointer(browser, "pointermove", 83);
  assert.equal(container.querySelector(".is-dragging"), null);
  await pointer(browser, "pointerup", 83);
  await pointerClick(tab("side"));
  assert.equal(selected.length, selectedBeforeDrag + 1, "Small pointer movement remains a normal selectable click.");
  assert.equal(reorders.length, afterPointerCount);
  await pointer(tab("nested"), "pointerdown", 240, 20, "touch");
  await pointer(browser, "pointermove", 70, 20, "touch");
  await pointer(browser, "pointerup", 70, 20, "touch");
  assert.deepEqual(current.map((document) => document.id), ["nested", "side", "main"]);
  assert.equal(current[0].parentId, "side");
  checks.push("pointer threshold preserves normal clicks while touch pointers reorder without changing relationships");

  const beforeCancelCount = reorders.length;
  await pointer(tab("nested"), "pointerdown", 80);
  await pointer(browser, "pointermove", 400);
  await pointer(browser, "pointercancel", 400);
  assert.equal(reorders.length, beforeCancelCount);
  assert.equal(container.querySelector(".is-dragging, .is-drop-target"), null);
  await pointer(tab("nested"), "pointerdown", 80);
  await pointer(browser, "pointermove", 400, 180);
  await pointer(browser, "pointerup", 400, 180);
  assert.equal(reorders.length, beforeCancelCount, "Releasing outside the tab strip cancels reordering.");
  await pointer(tab("nested"), "pointerdown", 80);
  await pointer(browser, "pointermove", 400);
  await act(async () => browser.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", cancelable: true })));
  await pointer(browser, "pointerup", 400);
  assert.equal(reorders.length, beforeCancelCount, "Escape cancels the drag and removes the global pointer listeners.");
  assert.equal(container.querySelector(".is-dragging, .is-drop-target"), null);
  checks.push("canceled pointers, outside drops, and Escape reset drag state without changing order");

  await click(item("side").querySelector('.document-tab-menu-trigger'));
  await click(browser.document.querySelector('[role="menuitem"]'));
  await click(item("side").querySelector('.document-tab-menu-trigger'));
  removeOnNextScopeToggle = true;
  await click(browser.document.querySelector('[role="menuitemcheckbox"]'));
  assert.equal(container.querySelector('[data-document-tab-id="side"]'), null);
  assert.equal(browser.document.activeElement, tab("main"), "Hiding an external pinned tab returns focus to the surviving active tab.");
  assert.equal(browser.document.querySelector('[role="menu"]'), null);
  checks.push("scope changes that hide a pin preserve keyboard focus in the surviving document tabs");

  await act(async () => enableGroups(true));
  const openGroup = async () => {
    await click(options);
    const groupSetting = browser.document.querySelector('[role="menuitem"][aria-haspopup="dialog"]');
    assert(groupSetting);
    await click(groupSetting);
    assert.equal(browser.document.querySelector('[role="menu"]'), null, "Opening group settings closes the tab menu.");
    assert.equal(browser.document.activeElement?.getAttribute("aria-label"), "Search groups");
  };
  await click(options);
  let groupSetting = browser.document.querySelector('[role="menuitem"][aria-haspopup="dialog"]');
  assert.equal(groupSetting?.getAttribute("aria-label"), "Group for Main: Coding");
  await act(async () => browser.document.activeElement?.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "End", bubbles: true, cancelable: true })));
  assert.equal(browser.document.activeElement, groupSetting, "Keyboard menu navigation reaches group settings.");
  await click(groupSetting);
  assert(browser.document.querySelector('[role="dialog"]'));
  const research = [...browser.document.querySelectorAll('[role="option"]')].find((option) => option.querySelector('.group-picker-option-name')?.textContent === "Research");
  await click(research);
  assert.deepEqual(groupAssignments, [["main", "research"]]);
  assert.equal(browser.document.querySelector('[role="dialog"]'), null);
  assert.equal(browser.document.activeElement, options, "Choosing a group restores focus to the persistent tab options trigger.");
  await click(options);
  assert.equal(browser.document.querySelector('[role="menuitem"][aria-haspopup="dialog"]')?.getAttribute("aria-label"), "Group for Main: Research");
  await click(options);
  await openGroup();
  await act(async () => browser.document.activeElement?.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  assert.equal(browser.document.querySelector('[role="dialog"]'), null);
  assert.equal(browser.document.activeElement, options);
  await openGroup();
  await click(browser.document.querySelector('.group-picker-option.is-suggested'));
  assert.deepEqual(groupCreations, [["main", "New ideas"]], "Tab settings preserve Jev suggestions and group creation.");
  assert.equal(browser.document.activeElement, options);
  await openGroup();
  await click(browser.document.querySelector('.group-picker-backdrop'));
  assert.equal(browser.document.querySelector('[role="dialog"]'), null);
  assert.equal(browser.document.activeElement, options, "Backdrop dismissal restores the tab trigger.");
  checks.push("tab settings assign groups, preserve suggestions and creation, and restore focus after selection or dismissal");

  await click(item("nested").querySelector('.document-tab-menu-trigger'));
  assert(browser.document.querySelector('[role="menu"]'));
  await act(async () => replaceDocuments([initial[0]]));
  assert.equal(browser.document.querySelector('[role="menu"]'), null, "Removing a document closes its menu.");
  assert.equal(tab("main").tabIndex, 0, "A remaining tab stays keyboard reachable after another document is removed.");
  checks.push("removed or stale active documents leave a reachable tab stop");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
