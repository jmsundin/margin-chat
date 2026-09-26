import assert from "node:assert/strict";
import { mock } from "bun:test";
import { Window } from "happy-dom";
import type { AppState } from "../../client/src/types";
import { billingUser } from "./billingFixture";

const browser = new Window({ url: "http://document-workspace.test" });
browser.happyDOM.setWindowSize({ width: 1600, height: 1000 });
const workspaceStyles = browser.document.createElement("style");
workspaceStyles.textContent = await Bun.file(new URL("../../client/src/document-workspace.css", import.meta.url)).text();
browser.document.head.append(workspaceStyles);
for (const name of ["window", "document", "navigator", "localStorage", "sessionStorage", "HTMLElement", "HTMLDivElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Text", "Document", "DocumentFragment", "MutationObserver", "ResizeObserver", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "WheelEvent", "Range", "DOMRect", "DOMParser", "getComputedStyle", "ShadowRoot"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value: name === "getComputedStyle" ? value.bind(browser) : value });
}
Object.defineProperties(browser.HTMLElement.prototype, {
  clientWidth: { configurable: true, get() { return this.classList.contains("conversation-canvas") ? 1200 : 500; } },
  clientHeight: { configurable: true, get: () => 800 },
});
const centered: string[] = [];
browser.HTMLElement.prototype.scrollIntoView = function () {
  const id = this.closest("[data-document-id]")?.getAttribute("data-document-id");
  if (id) centered.push(id);
};
let frameId = 0;
const frames = new Map<number, FrameRequestCallback>();
browser.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
browser.cancelAnimationFrame = (id) => { frames.delete(id); };
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: browser.requestAnimationFrame });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: browser.cancelAnimationFrame });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { createEmptyState, createMainConversation } = await import("../../client/src/initialState");
const { getStateStorageKey } = await import("../../client/src/lib/appState");
const { getEditableDocument } = await import("../../client/src/lib/editableDocument");
const { buildConversationGraphScene } = await import("../../client/src/lib/conversationGraph");
const initial = createEmptyState();
const mainId = initial.rootId;
initial.conversations[mainId].title = "Main research";
initial.conversations[mainId].document = getEditableDocument(initial.conversations[mainId]);
initial.conversations[mainId].document!.blocks[0].content = "Original main document text.";
const unrelated = createMainConversation({ id: "unrelated" });
unrelated.title = "Unrelated project";
initial.conversations[unrelated.id] = unrelated;
browser.localStorage.setItem(getStateStorageKey(billingUser.id), JSON.stringify(initial));
let latest: AppState = initial;
const observedStates: AppState[] = [];
mock.module("../../client/src/lib/useMarkdownVault", () => ({
  useMarkdownVault(args: { state: AppState }) {
    latest = args.state;
    observedStates.push(args.state);
    return { ready: true, storageMode: "local", matchesCloud: false, message: null, conflicts: [], saving: false,
      localDirectoryStatus: { supported: false, directoryName: null, connected: false, permission: "prompt" },
      flushLocal: async () => {}, chooseDirectory: async () => {}, clearDirectory: async () => {}, syncNow: async () => {},
      download: async () => {}, importArchive: async () => {}, importChatHistory: async () => {}, undoChatHistory: async () => {}, resolveConflict: async () => {},
    };
  },
}));
mock.module("../../client/src/lib/useJevAssistance", () => ({
  useJevPreference: () => [false, () => {}],
  useJevAssistance: () => ({ status: "off", categories: {}, groupSuggestions: {}, related: [] }),
}));
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: WorkspaceApp } = await import("../../client/src/WorkspaceApp");
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const props = {
  billingDashboard: null, billingDashboardLoading: false, billingDashboardError: null, billingOpenRequest: 0,
  onRefreshBilling() {}, onAddMoney() {}, billingNotice: null, onDismissBillingNotice() {}, onAuthExpired() {}, onBillingRequired() {},
  billingErrorMessage: null, billingSubmitting: false, onLogout() {}, onManageBilling() {}, onStartSubscription() {}, onSetTheme() {},
  onUpdateProfile: async () => billingUser, onChangePassword: async () => {}, onUpdateApiKeys: async () => billingUser.apiKeys,
  theme: "light" as const, user: billingUser,
};
const checks: string[] = [];
function element(selector: string): any { const found = container.querySelector(selector); assert(found, `Missing ${selector}`); return found; }
function panes() { return [...container.querySelectorAll(".conversation-canvas > [data-document-id]")].map((item) => item.getAttribute("data-document-id")); }
function pane(id: string) { return element(`.conversation-canvas > [data-document-id="${id}"]`); }
function tab(id: string) { return element(`[data-document-tab-id="${id}"] [role="tab"]`); }
function sidebar(title: string) { return element(`.thread-item-main[title="${title}"]`); }
function branch(title: string): any {
  const button = [...container.querySelectorAll(".branch-map-node")].find((item) => item.querySelector("strong")?.textContent === title);
  assert(button, `Missing branch ${title}`);
  return button;
}
function restoreButtons(parentId: string): any[] {
  return [...pane(parentId).querySelectorAll('nav[aria-label="Minimized side documents"] .document-side-restore')];
}
function restoreButton(parentId: string, title: string): any {
  const button = restoreButtons(parentId).find((item) => item.getAttribute("aria-label") === `Open side document: ${title}`);
  assert(button, `Missing minimized side document ${title} in parent ${parentId}`);
  assert.equal(button.title, `Open side document: ${title}`);
  return button;
}
function editor(id: string): any { return element(`[data-document-id="${id}"], [data-dock-document-id="${id}"]`).querySelector(".tiptap").editor; }
async function settle() {
  for (let iteration = 0; frames.size && iteration < 30; iteration++) {
    const callbacks = [...frames.values()]; frames.clear();
    await act(async () => { callbacks.forEach((callback) => callback(0)); });
  }
  assert.equal(frames.size, 0, "Workspace animation effects settle.");
}
async function click(target: any) { await act(async () => target.click()); await settle(); }
async function rename(id: string, title: string) {
  await act(async () => {
    const input = pane(id).querySelector('[aria-label="Document title"]');
    input.focus();
    Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value")!.set!.call(input, title);
    input.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  await act(async () => pane(id).querySelector('[aria-label="Document title"]').blur());
  await settle();
}
async function createSide() {
  const existing = new Set(Object.keys(latest.conversations));
  await click(element('[aria-label="New side document"]'));
  const added = Object.keys(latest.conversations).filter((id) => !existing.has(id));
  assert.equal(added.length, 1);
  return added[0];
}
try {
  await act(async () => root.render(createElement(WorkspaceApp, props)));
  await settle();
  assert.deepEqual(panes(), [mainId]);
  assert.equal(container.querySelectorAll('[role="tablist"][aria-label="Document tabs"] [role="tab"]').length, 1, "Other root documents stay outside the current family tab strip.");
  assert.equal(element('[aria-label="New side document"]').closest(".document-tabs"), element(".document-tabs"));
  assert.equal(container.querySelector('.thread-sidebar [aria-label="New side document"]'), null);
  const initialEditor = editor(mainId);
  const contentBeforeSidebarShortcuts = structuredClone(latest.conversations[mainId].document);
  await act(async () => {
    initialEditor.commands.setTextSelection({ from: 1, to: initialEditor.state.doc.content.size - 1 });
    initialEditor.view.dom.focus();
  });
  async function sidebarShortcut(options: KeyboardEventInit, target: any = initialEditor.view.dom) {
    const event = new browser.KeyboardEvent("keydown", { key: "b", bubbles: true, cancelable: true, ...options });
    await act(async () => target.dispatchEvent(event));
    await settle();
    return event;
  }
  function sidebarIsOpen() { return !element(".thread-sidebar").classList.contains("is-collapsed"); }
  assert(sidebarIsOpen());
  for (const modifier of ["metaKey", "ctrlKey"] as const) {
    for (const shouldBeOpen of [false, true]) {
      const event = await sidebarShortcut({ [modifier]: true });
      assert(event.defaultPrevented, `${modifier}+B is reserved for the sidebar even with editor focus.`);
      assert.equal(sidebarIsOpen(), shouldBeOpen, `${modifier}+B toggles the chat sidebar in both directions.`);
      assert.deepEqual(latest.conversations[mainId].document, contentBeforeSidebarShortcuts, "Sidebar navigation does not change document content or formatting.");
      assert.equal(initialEditor.isActive("bold"), false, "The sidebar shortcut does not apply editor bold formatting.");
    }
    checks.push(`${modifier}+B opens and closes the chat sidebar from the document editor without bolding selected text`);
  }
  for (const options of [
    { metaKey: true, shiftKey: true }, { ctrlKey: true, altKey: true },
    { metaKey: true, isComposing: true },
    {},
  ]) {
    await sidebarShortcut(options, container);
    assert(sidebarIsOpen(), "Shift/Alt variants, composition, auto-repeat, and plain B do not toggle the sidebar.");
  }
  const repeatedShortcut = await sidebarShortcut({ metaKey: true, repeat: true });
  assert(repeatedShortcut.defaultPrevented, "Holding the shortcut does not leak repeated key presses to the editor's bold command.");
  assert(sidebarIsOpen(), "Holding the shortcut does not repeatedly toggle the sidebar.");
  assert.deepEqual(latest.conversations[mainId].document, contentBeforeSidebarShortcuts);
  assert.equal(initialEditor.isActive("bold"), false);
  checks.push("sidebar keyboard navigation ignores extra modifiers, composing text, repeated keys, and plain typing");
  const sideId = await createSide();
  assert.equal(latest.conversations[sideId].parentId, mainId);
  assert(latest.conversations[mainId].childIds.includes(sideId));
  assert.equal(latest.activeConversationId, sideId);
  assert.deepEqual(panes(), [mainId, sideId]);
  await rename(sideId, "Side research");
  assert(sidebar("Side research"));
  assert.equal(tab(sideId).getAttribute("aria-label"), "Side research");
  checks.push("tab creation attaches a side document to the main document and exposes its renamed sidebar entry and tab");

  assert.equal(container.querySelector(".document-tab-minimize"), null, "Minimize is offered within document options rather than taking tab space.");
  const headerMenu = pane(sideId).querySelector('.document-header [aria-haspopup="menu"]');
  assert(headerMenu, "Every document exposes its menu beside its title.");
  await click(headerMenu);
  const headerActions = [...browser.document.querySelectorAll('[role="menu"] [role^="menuitem"]')].map((item) => item.textContent?.trim());
  assert(headerActions.includes("Pin document") && headerActions.includes("Minimize document"));
  await click(browser.document.body);
  assert.equal(browser.document.querySelector('[role="menu"]'), null, "The header menu dismisses with an outside click.");
  await click(element('[aria-label="Document views"]'));
  const branchesAction = browser.document.querySelector<HTMLButtonElement>('[role="menuitemcheckbox"][aria-controls="branch-navigation-map"]');
  assert(branchesAction, "Branches is available within the views menu.");
  await click(branchesAction);
  assert(latest.railOpen);
  await click(element('[aria-label="Document views"]'));
  await click(browser.document.querySelector('[role="menuitemcheckbox"][aria-controls="branch-navigation-map"]'));
  assert.equal(latest.railOpen, false);
  checks.push("document headers share tab actions and the compact views menu opens and closes branches");

  const nestedId = await createSide();
  await rename(nestedId, "Nested research");
  assert.equal(latest.conversations[nestedId].parentId, sideId);
  assert(latest.conversations[sideId].childIds.includes(nestedId));
  assert.deepEqual(panes(), [mainId, sideId, nestedId]);
  await act(async () => editor(nestedId).commands.insertContent("A durable nested observation."));
  await settle();
  const nestedContent = structuredClone(latest.conversations[nestedId].document);
  assert(nestedContent?.blocks.some((block) => block.content.includes("durable nested observation")));
  await act(async () => pane(mainId).dispatchEvent(new browser.PointerEvent("pointerdown", { bubbles: true })));
  const siblingId = await createSide();
  await rename(siblingId, "Sibling research");
  assert.equal(latest.conversations[siblingId].parentId, mainId, "Pointer focus in a visible pane changes the source for New Side Document.");
  assert.deepEqual(panes(), [mainId, siblingId, sideId, nestedId]);
  checks.push("nested side creation and pointer focus attach new documents to the actual focused document");

  await click(sidebar("Unrelated project"));
  assert.deepEqual(panes(), ["unrelated"]);
  await click(sidebar("Nested research"));
  assert.equal(latest.activeConversationId, nestedId);
  assert.deepEqual(panes(), [mainId, siblingId, sideId, nestedId]);
  assert.equal(centered.at(-1), nestedId, "Opening a side document centers its pane while its ancestors remain visible.");
  const toolbar = element(".document-workspace-toolbar");
  const viewsTrigger = element('.document-workspace-toolbar [aria-label="Document views"]');
  assert.equal(element('[role="tablist"][aria-label="Document tabs"]').closest(".document-workspace-toolbar"), toolbar, "Document tabs and the hierarchy control share one toolbar.");
  assert.equal(container.querySelector('[aria-label="Conversation hierarchy"]'), null, "The hierarchy no longer consumes a separate navigation row.");
  assert.equal(container.querySelector(".document-context-header"), null, "Side documents no longer repeat their parent context above the content.");
  await click(viewsTrigger);
  await click(browser.document.querySelector('[role="menuitemcheckbox"][aria-controls="branch-navigation-map"]'));
  assert.equal(latest.railOpen, true);
  assert.equal(branch("Nested research").getAttribute("aria-current"), "page");
  assert.equal(branch("Nested research").closest(".branch-map-children").parentElement.querySelector(":scope > .branch-map-node strong").textContent, "Side research");
  assert.equal(branch("Side research").closest(".branch-map-children").parentElement.querySelector(":scope > .branch-map-node strong").textContent, "Main research");
  await click(branch("Side research"));
  assert.equal(latest.activeConversationId, sideId, "The shared toolbar's hierarchy supports parent traversal.");
  await click(branch("Main research"));
  assert.equal(latest.activeConversationId, mainId);
  await click(branch("Nested research"));
  assert.equal(latest.activeConversationId, nestedId);
  assert.equal(centered.at(-1), nestedId);
  await click(element('[aria-label="Hide branches"]'));
  assert.equal(latest.railOpen, false);
  assert.deepEqual(panes(), [mainId, siblingId, sideId, nestedId]);
  checks.push("sidebar navigation scopes family tabs and the shared toolbar's branches control traverses ancestors and children without extra context rows");

  const transfer = { effectAllowed: "", dropEffect: "", setData() {} };
  for (const [id, type] of [[nestedId, "dragstart"], [mainId, "dragover"], [mainId, "drop"]]) {
    const event = new browser.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperty(event, "dataTransfer", { value: transfer });
    await act(async () => element(`[data-document-tab-id="${id}"]`).dispatchEvent(event));
  }
  await settle();
  assert.deepEqual(panes(), [nestedId, mainId, siblingId, sideId]);
  assert.deepEqual(latest.conversations[mainId].documentLayout?.order, panes());
  assert.equal(latest.conversations[nestedId].parentId, sideId);
  assert.equal(latest.conversations[sideId].parentId, mainId);
  checks.push("dragging a tab updates pane order and saved layout without changing document relationships");

  await menuAction(nestedId, "Minimize document");
  assert.equal(container.querySelector(`[data-document-id="${nestedId}"]`), null);
  assert(tab(nestedId).getAttribute("aria-label").includes("minimized"));
  assert.equal(latest.activeConversationId, sideId);
  assert.equal(latest.conversations[nestedId].parentId, sideId);
  assert.deepEqual(latest.conversations[nestedId].document, nestedContent);
  assert(sidebar("Nested research"));
  assert.deepEqual(restoreButtons(sideId).map((button) => button.getAttribute("aria-label")), ["Open side document: Nested research"]);
  assert.equal(restoreButtons(mainId).length, 0, "A minimized grandchild belongs only to its direct parent's restore rail.");
  assert.equal(restoreButtons(siblingId).length, 0, "Unrelated sibling panes do not display another parent's minimized child.");
  assert.equal(container.querySelectorAll('.document-side-restore[aria-label="Open side document: Nested research"]').length, 1);
  await click(restoreButton(sideId, "Nested research"));
  assert.deepEqual(panes(), [nestedId, mainId, siblingId, sideId]);
  assert.deepEqual(latest.conversations[mainId].documentLayout?.order, panes());
  assert.equal(latest.activeConversationId, nestedId);
  assert.equal(centered.at(-1), nestedId);
  assert.deepEqual(latest.conversations[nestedId].document, nestedContent);
  assert(editor(nestedId).getMarkdown().includes("durable nested observation"));
  assert.equal(container.querySelector('.document-side-restore[aria-label="Open side document: Nested research"]'), null);
  assert.equal(pane(sideId).querySelector('nav[aria-label="Minimized side documents"]'), null, "The empty parent restore rail disappears after opening its child.");
  checks.push("minimized children have one accessible restore icon only in their direct parent and reopen with content and tab order intact");

  await menuAction(nestedId, "Minimize document");
  await click(tab(nestedId));
  assert.deepEqual(panes(), [nestedId, mainId, siblingId, sideId]);
  assert.equal(latest.activeConversationId, nestedId);
  assert(editor(nestedId).getMarkdown().includes("durable nested observation"));
  checks.push("minimize and tab restoration preserve sidebar presence, content, relationship, and visual position");

  await menuAction(sideId, "Minimize document");
  await menuAction(siblingId, "Minimize document");
  assert.deepEqual(restoreButtons(mainId).map((button) => button.getAttribute("aria-label")), [
    "Open side document: Sibling research", "Open side document: Side research",
  ], "Separate child icons follow saved tab order, independently of child creation or minimization order.");
  assert.equal(restoreButtons(nestedId).length, 0);
  await click(restoreButton(mainId, "Sibling research"));
  assert.equal(latest.activeConversationId, siblingId);
  assert.deepEqual(panes(), [nestedId, mainId, siblingId]);
  assert.deepEqual(restoreButtons(mainId).map((button) => button.getAttribute("aria-label")), ["Open side document: Side research"]);
  assert(latest.conversations[mainId].documentLayout?.minimizedIds.includes(sideId), "Opening one icon leaves the other child minimized.");
  await click(restoreButton(mainId, "Side research"));
  assert.equal(latest.activeConversationId, sideId);
  assert.deepEqual(panes(), [nestedId, mainId, siblingId, sideId]);
  assert.equal(restoreButtons(mainId).length, 0);
  checks.push("multiple minimized children have separate parent icons in saved tab order and each restores only its own document");

  await menuAction(sideId, "Minimize document");
  await menuAction(nestedId, "Minimize document");
  assert.deepEqual(restoreButtons(mainId).map((button) => button.getAttribute("aria-label")), ["Open side document: Side research"]);
  assert.equal(container.querySelector('.document-side-restore[aria-label="Open side document: Nested research"]'), null, "A hidden parent's child icon does not leak into its grandparent.");
  await click(restoreButton(mainId, "Side research"));
  assert.equal(latest.activeConversationId, sideId);
  assert.deepEqual(panes(), [mainId, siblingId, sideId]);
  assert(latest.conversations[mainId].documentLayout?.minimizedIds.includes(nestedId));
  assert.equal(restoreButtons(mainId).length, 0);
  await click(restoreButton(sideId, "Nested research"));
  assert.equal(latest.activeConversationId, nestedId);
  assert.deepEqual(panes(), [nestedId, mainId, siblingId, sideId]);
  assert.deepEqual(latest.conversations[nestedId].document, nestedContent);
  assert.equal(container.querySelector(".document-side-restore"), null);
  checks.push("restoring a minimized parent reveals its own minimized child icon and allows traversal down the saved document chain");

  await menuAction(sideId, "Minimize document");
  await menuAction(nestedId, "Minimize document");
  await click(sidebar("Nested research"));
  assert.deepEqual(panes(), [nestedId, mainId, siblingId, sideId]);
  assert.equal(latest.activeConversationId, nestedId);
  assert(!latest.conversations[mainId].documentLayout?.minimizedIds.includes(sideId));
  checks.push("opening a child from the sidebar restores minimized ancestors for graph traversal");

  const canvas = element('[aria-label="Documents side by side"]');
  Object.defineProperty(canvas, "scrollWidth", { configurable: true, value: 2400 });
  canvas.scrollLeft = 0;
  const wheel = new browser.WheelEvent("wheel", { deltaX: 240, deltaY: 0, bubbles: true, cancelable: true });
  await act(async () => pane(nestedId).querySelector(".document-body").dispatchEvent(wheel));
  assert.equal(canvas.scrollLeft, 240);
  assert.equal(wheel.defaultPrevented, true);
  checks.push("horizontal wheel gestures over document text scroll the shared multi-document canvas");

  const readingBody = pane(nestedId).querySelector(".document-body");
  readingBody.style.overflowY = "auto";
  Object.defineProperties(readingBody, {
    clientHeight: { configurable: true, value: 300 },
    scrollHeight: { configurable: true, value: 1400 },
  });
  async function readingWheel(target: any, deltaX: number, deltaY: number, options: { shiftKey?: boolean; ctrlKey?: boolean; deltaMode?: number } = {}) {
    const event = new browser.WheelEvent("wheel", { deltaX, deltaY, ...options, bubbles: true, cancelable: true });
    // Happy DOM's WheelEvent does not initialize keyboard modifiers.
    Object.defineProperties(event, {
      shiftKey: { value: options.shiftKey ?? false },
      ctrlKey: { value: options.ctrlKey ?? false },
    });
    await act(async () => target.dispatchEvent(event));
    await settle();
    return event;
  }
  readingBody.scrollTop = 100;
  const readingX = canvas.scrollLeft;
  const downRight = await readingWheel(readingBody, 32, 40);
  assert.equal(readingBody.scrollTop, 140);
  assert.equal(canvas.scrollLeft, readingX, "Incidental rightward trackpad motion during reading does not shift document panes.");
  assert(downRight.defaultPrevented, "The routed diagonal gesture suppresses the browser's sideways component.");
  const downLeft = await readingWheel(readingBody, -35, 60);
  assert.equal(readingBody.scrollTop, 200);
  assert.equal(canvas.scrollLeft, readingX, "Incidental leftward motion is also suppressed.");
  assert(downLeft.defaultPrevented);
  await readingWheel(readingBody, 18, -50);
  assert.equal(readingBody.scrollTop, 150, "Upward reading gestures retain their vertical direction.");
  assert.equal(canvas.scrollLeft, readingX);
  readingBody.scrollTop = 1100;
  await readingWheel(readingBody, 24, 80);
  assert.equal(readingBody.scrollTop, 1100);
  assert.equal(canvas.scrollLeft, readingX, "Reaching the bottom of a document does not turn a vertical gesture into sideways navigation.");
  readingBody.scrollTop = 0;
  await readingWheel(readingBody, -28, -65);
  assert.equal(readingBody.scrollTop, 0);
  assert.equal(canvas.scrollLeft, readingX, "The top boundary also discards diagonal drift.");
  readingBody.scrollTop = 500;
  await readingWheel(readingBody, 0.5, 3, { deltaMode: 1 });
  assert.equal(readingBody.scrollTop, 548, "Line deltas are normalized before vertical scrolling.");
  await readingWheel(readingBody, 0.05, 1, { deltaMode: 2 });
  assert.equal(readingBody.scrollTop, 848, "Page deltas use the document body's visible height.");
  assert.equal(canvas.scrollLeft, readingX);
  checks.push("diagonal trackpad reading scrolls documents vertically in both directions without sideways drift at either boundary");

  const readingPopover = browser.document.createElement("div");
  readingPopover.style.overflowY = "auto";
  const readingTextarea = browser.document.createElement("textarea");
  readingTextarea.style.overflowY = "auto";
  Object.defineProperties(readingPopover, {
    clientHeight: { configurable: true, value: 180 },
    scrollHeight: { configurable: true, value: 600 },
  });
  Object.defineProperties(readingTextarea, {
    clientHeight: { configurable: true, value: 100 },
    scrollHeight: { configurable: true, value: 500 },
  });
  readingPopover.append(readingTextarea);
  readingBody.append(readingPopover);
  readingBody.scrollTop = 100;
  readingPopover.scrollTop = 70;
  readingTextarea.scrollTop = 25;
  await readingWheel(readingTextarea, 31, 55);
  assert.equal(readingTextarea.scrollTop, 80, "A nested textarea consumes vertical movement before its popover and document body.");
  assert.equal(readingPopover.scrollTop, 70);
  assert.equal(readingBody.scrollTop, 100);
  assert.equal(canvas.scrollLeft, readingX);
  readingTextarea.scrollTop = 400;
  await readingWheel(readingTextarea, -22, 60);
  assert.equal(readingTextarea.scrollTop, 400);
  assert.equal(readingPopover.scrollTop, 130, "At the textarea boundary, the nearest scrollable popover receives the vertical movement.");
  assert.equal(readingBody.scrollTop, 100);
  readingPopover.scrollTop = 420;
  await readingWheel(readingTextarea, 25, 60);
  assert.equal(readingPopover.scrollTop, 420);
  assert.equal(readingBody.scrollTop, 160, "Vertical motion reaches the document body when both nested surfaces are at their boundaries.");
  readingTextarea.scrollTop = 0;
  readingPopover.scrollTop = 0;
  await readingWheel(readingTextarea, -25, -60);
  assert.equal(readingTextarea.scrollTop, 0);
  assert.equal(readingPopover.scrollTop, 0);
  assert.equal(readingBody.scrollTop, 100);
  assert.equal(canvas.scrollLeft, readingX);
  readingPopover.remove();
  checks.push("diagonal gestures scroll the nearest available textarea or popover before the document body while keeping panes stationary");

  const beforeHorizontalBodyScroll = readingBody.scrollTop;
  const explicitHorizontal = await readingWheel(readingBody, 100, 20);
  assert.equal(canvas.scrollLeft, readingX + 100, "A clearly horizontal trackpad swipe still traverses documents.");
  assert.equal(readingBody.scrollTop, beforeHorizontalBodyScroll);
  assert(explicitHorizontal.defaultPrevented);
  const explicitShift = await readingWheel(readingBody, 0, 80, { shiftKey: true });
  assert.equal(canvas.scrollLeft, readingX + 180, "Shift plus the wheel remains explicit horizontal navigation.");
  assert.equal(readingBody.scrollTop, beforeHorizontalBodyScroll);
  assert(explicitShift.defaultPrevented);
  const pureVertical = await readingWheel(readingBody, 0, 45);
  assert.equal(pureVertical.defaultPrevented, false, "Pure vertical wheel events keep their native browser scrolling behavior.");
  const zoomGesture = await readingWheel(readingBody, 100, 20, { ctrlKey: true });
  assert.equal(zoomGesture.defaultPrevented, false);
  assert.equal(canvas.scrollLeft, readingX + 180);
  checks.push("clear horizontal swipes and Shift-wheel retain document navigation while pure vertical scrolling and pinch zoom remain native");

  const scene = buildConversationGraphScene({ conversations: latest.conversations, mode: "overview", selectedConversationId: nestedId, groups: latest.groups });
  assert(scene.edges.some((edge) => edge.parentConversationId === mainId && edge.childConversationId === sideId));
  assert(scene.edges.some((edge) => edge.parentConversationId === sideId && edge.childConversationId === nestedId));
  checks.push("map scene retains main-to-side and nested child edges after document layout interactions");
  async function menuAction(id: string, label: string) {
    await click(element(`[data-document-tab-id="${id}"] [aria-haspopup="menu"]`));
    const action = [...browser.document.querySelectorAll<HTMLButtonElement>('[role^="menuitem"]')].find((item) => item.textContent?.trim().replace(/^✓\s*/, "") === label);
    assert(action, `Missing menu action ${label}`);
    await click(action);
  }
  const dockPane = (id: string) => element(`[data-dock-document-id="${id}"]`);
  await menuAction(mainId, "Pin document");
  await menuAction(siblingId, "Minimize document");
  assert.equal(pane(nestedId).querySelector(".document-child-tabs"), null, "Grandchildren do not show the pinned grandparent's direct-child tabs.");
  await click(pane(sideId).querySelector(".document-child-tabs-trigger"));
  const childTabs = [...pane(sideId).querySelectorAll<HTMLButtonElement>(".document-child-tabs-list > button")];
  assert.deepEqual(childTabs.map((button) => button.querySelector("span")?.textContent), ["Sibling research", "Side research"]);
  assert(childTabs[0].textContent.includes("Minimized"));
  const childTabList = pane(sideId).querySelector<HTMLElement>(".document-child-tabs-list")!;
  Object.defineProperties(childTabList, {
    clientWidth: { configurable: true, value: 240 },
    scrollWidth: { configurable: true, value: 840 },
  });
  const canvasBeforeChildScroll = canvas.scrollLeft;
  const bodyBeforeChildScroll = pane(sideId).querySelector(".document-body").scrollTop;
  for (const gesture of [
    { deltaX: 90, deltaY: 0 },
    { deltaX: 30, deltaY: 90 },
    { deltaY: 90 },
    { deltaY: 90, shiftKey: true },
    { deltaY: 2, deltaMode: 1 },
    { deltaY: 1, deltaMode: 2 },
  ]) {
    childTabList.scrollLeft = 0;
    const wheel = new browser.WheelEvent("wheel", { ...gesture, bubbles: true, cancelable: true });
    Object.defineProperty(wheel, "shiftKey", { value: "shiftKey" in gesture && gesture.shiftKey });
    await act(async () => childTabs[0].querySelector("span")!.dispatchEvent(wheel));
    assert(wheel.defaultPrevented, "The dropdown owns non-zoom wheel gestures.");
    assert(childTabList.scrollLeft > 0, "Wheel gestures scroll the child tabs, including mouse wheels and diagonal swipes.");
    assert.equal(canvas.scrollLeft, canvasBeforeChildScroll, "Scrolling child tabs never moves the outer canvas.");
    assert.equal(pane(sideId).querySelector(".document-body").scrollTop, bodyBeforeChildScroll);
  }
  for (const [position, delta] of [[0, -90], [600, 90]]) {
    childTabList.scrollLeft = position;
    const wheel = new browser.WheelEvent("wheel", { deltaX: delta, bubbles: true, cancelable: true });
    await act(async () => childTabs[0].dispatchEvent(wheel));
    assert.equal(childTabList.scrollLeft, position);
    assert.equal(canvas.scrollLeft, canvasBeforeChildScroll, "Reaching either edge does not chain to the canvas.");
    assert(wheel.defaultPrevented);
  }
  const pinch = new browser.WheelEvent("wheel", { deltaY: 90, ctrlKey: true, bubbles: true, cancelable: true });
  Object.defineProperty(pinch, "ctrlKey", { value: true });
  await act(async () => childTabs[0].dispatchEvent(pinch));
  assert.equal(pinch.defaultPrevented, false, "Pinch zoom stays native.");
  Object.defineProperty(childTabList, "scrollWidth", { configurable: true, value: 240 });
  childTabList.scrollLeft = 0;
  const headerWheel = new browser.WheelEvent("wheel", { deltaY: 90, bubbles: true, cancelable: true });
  await act(async () => pane(sideId).querySelector(".document-child-tabs-heading").dispatchEvent(headerWheel));
  assert(headerWheel.defaultPrevented, "The entire dropdown contains scrolling even when all tabs fit.");
  assert.equal(childTabList.scrollLeft, 0);
  assert.equal(canvas.scrollLeft, canvasBeforeChildScroll);
  await click(childTabs[0]);
  assert.equal(latest.activeConversationId, siblingId);
  assert(panes().includes(siblingId));
  assert.equal(centered.at(-1), siblingId);
  assert(dockPane(mainId), "Navigating child tabs leaves the parent pinned.");
  await menuAction(mainId, "Unpin document");
  assert.equal(container.querySelector(".document-child-tabs"), null, "Unpinning removes the child hover controls.");
  await click(tab(nestedId));
  checks.push("pinned parents expose direct-child tabs in saved order and selecting a minimized child restores and focuses it");
  pane(nestedId).querySelector(".document-body").scrollTop = 175;
  await menuAction(nestedId, "Pin document");
  assert(dockPane(nestedId));
  assert.equal(dockPane(nestedId).querySelector(".document-body").scrollTop, 175, "Pinning preserves the reading position.");
  assert(!panes().includes(nestedId), "Pinned documents leave the horizontally scrolling canvas.");
  assert.equal(container.querySelectorAll(`[data-dock-document-id="${nestedId}"], .conversation-canvas > [data-document-id="${nestedId}"]`).length, 1);
  await act(async () => editor(nestedId).commands.insertContent(" Still editable when pinned."));
  await settle();
  assert(latest.conversations[nestedId].document!.blocks.some((block) => block.content.includes("Still editable")));
  const pinnedWheel = new browser.WheelEvent("wheel", { deltaX: 200, bubbles: true, cancelable: true });
  const beforePinnedScroll = canvas.scrollLeft;
  await act(async () => dockPane(nestedId).querySelector(".document-body").dispatchEvent(pinnedWheel));
  assert.equal(canvas.scrollLeft, beforePinnedScroll, "Horizontal gestures inside a fixed pane do not scroll the other documents.");
  checks.push("pinning relocates one editable document outside the shared horizontal scroll area");

  const editorBeforeMoving = editor(nestedId);
  await click(dockPane(nestedId).querySelector('[aria-label="Move pinned document: Nested research"]'));
  await click(element('[aria-label="Move pinned document to bottom"]'));
  assert.equal(latest.documentDock?.position, "bottom");
  assert.equal(editor(nestedId), editorBeforeMoving, "Repositioning preserves the existing editor instance.");
  assert.equal(element('[aria-label="Resize pinned document area"]').getAttribute("aria-orientation"), "horizontal");
  checks.push("one pinned document can move below the scrolling workspace and save its placement without remounting its editor");

  await click(sidebar("Unrelated project"));
  assert.deepEqual(panes(), ["unrelated"]);
  assert(dockPane(nestedId), "Workspace pins survive switching unrelated documents.");
  await act(async () => dockPane(nestedId).dispatchEvent(new browser.PointerEvent("pointerdown", { bubbles: true })));
  await settle();
  assert.equal(latest.activeConversationId, nestedId);
  assert.deepEqual(panes(), ["unrelated"], "Focusing a pinned document keeps the scrolling workspace unchanged.");
  await menuAction(nestedId, "Keep visible across documents");
  assert.equal(container.querySelector(`[data-dock-document-id="${nestedId}"]`), null);
  assert.equal(latest.activeConversationId, "unrelated", "Hiding a family-only pin returns focus to the browsing document.");
  await click(sidebar("Nested research"));
  assert(dockPane(nestedId), "Family pins reappear when opening that document family.");
  await menuAction(nestedId, "Keep visible across documents");
  await click(sidebar("Unrelated project"));
  assert(dockPane(nestedId), "The scope switch can restore workspace-wide behavior.");
  checks.push("per-document pin scope switches between workspace-wide and family-only without losing the pane");

  await menuAction("unrelated", "Pin document");
  assert.equal(container.querySelectorAll("[data-dock-document-id]").length, 2);
  const moveButton = dockPane("unrelated").querySelector('[aria-label="Move pinned document: Unrelated project"]');
  await click(moveButton);
  await click([...container.querySelectorAll("button")].find((item) => item.textContent === "Move left"));
  assert.equal(latest.documentDock?.tree?.type, "split");
  if (latest.documentDock?.tree?.type === "split") {
    assert.equal(latest.documentDock.tree.direction, "horizontal");
    assert.equal(latest.documentDock.tree.first.type, "pane");
    if (latest.documentDock.tree.first.type === "pane") assert.equal(latest.documentDock.tree.first.documentId, "unrelated");
  }
  const divider = element('[aria-label="Resize pinned pane widths"]');
  await act(async () => divider.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
  assert(latest.documentDock?.tree?.type === "split" && latest.documentDock.tree.ratio > .5);
  await act(async () => element('[aria-label="Resize pinned document area"]').dispatchEvent(new browser.KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true, cancelable: true })));
  assert(latest.documentDock!.width > .4);
  checks.push("multiple fixed panes can move into horizontal splits with persistent inner and outer resizing");

  const savedLayout = structuredClone(latest.documentDock);
  const savedState = structuredClone(latest);
  await act(async () => root.render(null));
  browser.localStorage.setItem(getStateStorageKey(billingUser.id), JSON.stringify(savedState));
  await act(async () => root.render(createElement(WorkspaceApp, props)));
  await settle();
  assert.deepEqual(latest.documentDock, savedLayout);
  assert.equal(latest.documentDock?.position, "bottom");
  assert.equal(element('[aria-label="Resize pinned document area"]').getAttribute("aria-orientation"), "horizontal");
  assert.equal(container.querySelectorAll("[data-dock-document-id]").length, 2);
  assert(editor(nestedId).getMarkdown().includes("Still editable"));
  checks.push("reopening the workspace restores pinned pane structure, sizes and edited document content");

  await click(dockPane("unrelated").querySelector('[aria-label="Unpin document: Unrelated project"]'));
  assert.equal(container.querySelector('[data-dock-document-id="unrelated"]'), null);
  assert(panes().includes("unrelated"));
  assert(dockPane(nestedId));
  await click(dockPane(nestedId).querySelector('[aria-label="Unpin document: Nested research"]'));
  assert.equal(container.querySelector(".document-workspace-dock"), null);
  assert.equal(latest.documentDock?.tree, null);
  await click(sidebar("Nested research"));
  assert(editor(nestedId).getMarkdown().includes("Still editable"));
  checks.push("unpinning restores scrolling documents and collapses the dock without deleting content");

  type ResizeEdge = "left" | "right";
  const resizeDocumentIds = [nestedId, mainId, sideId];
  assert.deepEqual(panes(), [nestedId, mainId, siblingId, sideId], "Resize coverage includes the first, a middle, and the last scrolling document.");
  function documentWidths(): Record<string, number> {
    return Object.fromEntries(panes().map((id) => [id, Number.parseFloat(pane(id!).style.getPropertyValue("--chat-panel-width"))]));
  }
  function resizeHandle(id: string, edge: ResizeEdge): any {
    const handle = pane(id).querySelector(`[data-resize-edge="${edge}"]`);
    assert(handle, `Missing ${edge} resize handle for ${id}`);
    assert.equal(handle.getAttribute("aria-label"), `Resize ${latest.conversations[id].title} document from ${edge}`);
    assert.equal(handle.getAttribute("role"), "separator");
    assert.equal(handle.getAttribute("aria-orientation"), "vertical");
    return handle;
  }
  function assertOnlyPaneWidth(before: Record<string, number>, id: string, expected: number) {
    const after = documentWidths();
    for (const [candidateId, width] of Object.entries(before)) {
      const desired = candidateId === id ? expected : width;
      assert(Math.abs(after[candidateId] - desired) < 0.01, `Resizing ${id} should give ${candidateId} width ${desired}, received ${after[candidateId]}`);
    }
    for (const edge of ["left", "right"] as const) {
      assert.equal(Number(resizeHandle(id, edge).getAttribute("aria-valuenow")), Math.round(expected), "Both edge controls report the resulting width.");
    }
  }
  const defaultDocumentWidths = documentWidths();
  let resizePointerId = 100;
  async function dragResize(id: string, edge: ResizeEdge, physicalDelta: number) {
    const before = documentWidths();
    const handle = resizeHandle(id, edge);
    const pointerId = ++resizePointerId;
    const captured = new Set<number>();
    handle.setPointerCapture = (value: number) => captured.add(value);
    handle.hasPointerCapture = (value: number) => captured.has(value);
    handle.releasePointerCapture = (value: number) => captured.delete(value);
    const cursorBefore = browser.document.body.style.cursor;
    const userSelectBefore = browser.document.body.style.userSelect;
    await act(async () => handle.dispatchEvent(new browser.PointerEvent("pointerdown", {
      button: 0, isPrimary: true, pointerId, clientX: 500, bubbles: true, cancelable: true,
    })));
    assert(captured.has(pointerId), "The dragged edge captures its pointer.");
    await act(async () => browser.dispatchEvent(new browser.PointerEvent("pointermove", {
      isPrimary: true, pointerId, clientX: 500 + physicalDelta, bubbles: true, cancelable: true,
    })));
    assertOnlyPaneWidth(before, id, before[id] + physicalDelta * (edge === "left" ? -1 : 1));
    await act(async () => browser.dispatchEvent(new browser.PointerEvent("pointerup", {
      isPrimary: true, pointerId, clientX: 500 + physicalDelta, bubbles: true, cancelable: true,
    })));
    await settle();
    assert(!captured.has(pointerId), "Finishing the drag releases pointer capture.");
    assert.equal(browser.document.body.style.cursor, cursorBefore);
    assert.equal(browser.document.body.style.userSelect, userSelectBefore);
  }
  for (const id of resizeDocumentIds) {
    assert.equal(pane(id).querySelectorAll("[data-resize-edge]").length, 2);
    for (const edge of ["left", "right"] as const) {
      const outward = edge === "left" ? -1 : 1;
      await dragResize(id, edge, outward * 40);
      await dragResize(id, edge, outward * -16);
    }
  }
  checks.push("both edges independently grow and shrink first, middle, and last documents with pointer drags while neighboring widths stay fixed");

  async function resizeKey(id: string, edge: ResizeEdge, key: string) {
    const event = new browser.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true });
    await act(async () => {
      const handle = resizeHandle(id, edge);
      handle.focus();
      handle.dispatchEvent(event);
    });
    await settle();
    assert(event.defaultPrevented, "Resize keys are handled by the focused edge control.");
  }
  for (const id of resizeDocumentIds) {
    for (const edge of ["left", "right"] as const) {
      const before = documentWidths();
      await resizeKey(id, edge, edge === "left" ? "ArrowLeft" : "ArrowRight");
      assertOnlyPaneWidth(before, id, before[id] + 24);
      const grown = documentWidths();
      await resizeKey(id, edge, edge === "left" ? "ArrowRight" : "ArrowLeft");
      assertOnlyPaneWidth(grown, id, before[id]);
    }
  }
  checks.push("keyboard arrows follow each edge's physical direction and resize only the focused document");

  const rememberedWidths = documentWidths();
  const rememberedState = structuredClone(latest);
  assert.equal(rememberedState.conversations[mainId].documentLayout?.widthsById?.[nestedId], rememberedWidths[nestedId]);
  await click(sidebar("Unrelated project"));
  await click(sidebar("Nested research"));
  assert.deepEqual(documentWidths(), rememberedWidths, "Changing document families retains individual widths.");
  await act(async () => root.render(null));
  browser.localStorage.setItem(getStateStorageKey(billingUser.id), JSON.stringify(rememberedState));
  await act(async () => root.render(createElement(WorkspaceApp, props)));
  await settle();
  assert.deepEqual(documentWidths(), rememberedWidths, "Reloading restores every document's own saved width.");
  checks.push("individually resized document widths persist across family switches and workspace reopening");

  const beforeCanceledResize = structuredClone(latest.conversations[mainId].documentLayout);
  const canceledHandle = resizeHandle(nestedId, "right");
  await act(async () => canceledHandle.dispatchEvent(new browser.PointerEvent("pointerdown", {
    button: 0, isPrimary: true, pointerId: 999, clientX: 500, bubbles: true, cancelable: true,
  })));
  await act(async () => browser.dispatchEvent(new browser.PointerEvent("pointermove", { pointerId: 999, clientX: 620, bubbles: true, cancelable: true })));
  assert.deepEqual(latest.conversations[mainId].documentLayout, beforeCanceledResize, "Drag previews are not saved as new widths.");
  await act(async () => browser.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  await settle();
  assert.deepEqual(documentWidths(), rememberedWidths);
  assert.deepEqual(latest.conversations[mainId].documentLayout, beforeCanceledResize);
  checks.push("canceling a width drag restores the prior display and saved preference");

  for (const id of resizeDocumentIds) {
    for (const edge of ["left", "right"] as const) {
      const minimum = Number(resizeHandle(id, edge).getAttribute("aria-valuemin"));
      const maximum = Number(resizeHandle(id, edge).getAttribute("aria-valuemax"));
      assert.equal(minimum, 320);
      assert.equal(maximum, 980, "The document maximum is not constrained by a neighbor's current width.");
      const beforeMinimum = documentWidths();
      await resizeKey(id, edge, "Home");
      assertOnlyPaneWidth(beforeMinimum, id, minimum);
      const atMinimum = documentWidths();
      await resizeKey(id, edge, edge === "left" ? "ArrowRight" : "ArrowLeft");
      assertOnlyPaneWidth(atMinimum, id, minimum);
      await resizeKey(id, edge, "End");
      assertOnlyPaneWidth(atMinimum, id, maximum);
      const atMaximum = documentWidths();
      await resizeKey(id, edge, edge === "left" ? "ArrowLeft" : "ArrowRight");
      assertOnlyPaneWidth(atMaximum, id, maximum);
      await act(async () => resizeHandle(id, edge).dispatchEvent(new browser.MouseEvent("dblclick", { bubbles: true, cancelable: true })));
      await settle();
      assertOnlyPaneWidth(atMaximum, id, defaultDocumentWidths[id]);
    }
  }
  checks.push("both edges honor independent Home and End limits and double-click resets only the target document");

  const formattedTransfer = "## Transferred heading\n\n**Formatted transfer** with a [source link](https://example.com/source).\n\n- First item\n- Second item";
  await act(async () => editor(mainId).commands.setContent(formattedTransfer, { contentType: "markdown" }));
  await settle();
  const sourceBlock = structuredClone(latest.conversations[mainId].document!.blocks[0]);
  assert(sourceBlock.content.includes("**Formatted transfer**"));
  const relationships = (state: AppState) => Object.fromEntries(Object.entries(state.conversations).map(([id, conversation]) => [id, {
    parentId: conversation.parentId, childIds: conversation.childIds, documentLayout: conversation.documentLayout,
  }]));
  const relationshipsBeforeMove = structuredClone(relationships(latest));
  assert.equal(container.querySelector('[data-document-id="unrelated"], [data-dock-document-id="unrelated"]'), null, "The menu can target a document outside the visible family.");
  await click(pane(mainId).querySelector(`[data-document-block-id="${sourceBlock.id}"] .rich-document-grip`));
  const moveSelect = pane(mainId).querySelector('select[aria-label="Move block to document"]');
  assert(moveSelect, "Block actions offer document transfer.");
  const targetIds = [...moveSelect.options].map((option: any) => option.value).filter(Boolean);
  assert.deepEqual([...targetIds].sort(), Object.keys(latest.conversations).filter((id) => id !== mainId).sort(), "Every other document is a move destination, including hidden roots and nested children.");
  const beforeTransfer = observedStates.length;
  await act(async () => {
    moveSelect.value = "unrelated";
    moveSelect.dispatchEvent(new browser.Event("change", { bubbles: true }));
  });
  await settle();
  assert.equal(latest.activeConversationId, "unrelated");
  assert.deepEqual(panes(), ["unrelated"]);
  assert(!latest.conversations[mainId].document!.blocks.some((block) => block.id === sourceBlock.id));
  const transferredBlocks = latest.conversations.unrelated.document!.blocks.filter((block) => block.content === sourceBlock.content);
  assert.equal(transferredBlocks.length, 1, "The destination receives the complete block exactly once.");
  assert.notEqual(transferredBlocks[0].id, sourceBlock.id, "Transferred content receives a destination-local block identity.");
  assert(observedStates.length > beforeTransfer);
  for (const state of observedStates.slice(beforeTransfer)) {
    const copies = Object.values(state.conversations).flatMap((conversation) => conversation.document?.blocks ?? []).filter((block) => block.content === sourceBlock.content);
    assert.equal(copies.length, 1, "Every state presented to persistence contains exactly one copy across source and destination.");
  }
  assert.deepEqual(relationships(latest), relationshipsBeforeMove, "Moving content preserves document edges and saved tab positions.");
  const transferredBlock = pane("unrelated").querySelector(`[data-document-block-id="${transferredBlocks[0].id}"]`);
  assert.equal(browser.document.activeElement, transferredBlock.querySelector(".rich-document-grip"), "Keyboard focus follows the moved block into the destination document.");
  assert.equal(transferredBlock.querySelector("h2")?.textContent, "Transferred heading");
  assert.equal(transferredBlock.querySelector("strong")?.textContent, "Formatted transfer");
  assert.equal(transferredBlock.querySelector("a")?.getAttribute("href"), "https://example.com/source");
  assert.deepEqual([...transferredBlock.querySelectorAll("li")].map((item: any) => item.textContent), ["First item", "Second item"]);
  checks.push("block action transfer opens hidden destinations with formatting intact and atomically removes the source copy without changing graph or tab order");

  await click(sidebar("Main research"));
  assert(latest.conversations[mainId].document!.blocks.every((block) => !block.content.trim()), "Moving the only written block leaves an empty source.");
  assert(editor(mainId).isEditable, "The emptied source still has an editable writing surface.");
  await act(async () => editor(mainId).commands.insertContent("Fresh main text after moving."));
  await settle();
  assert(latest.conversations[mainId].document!.blocks.some((block) => block.content === "Fresh main text after moving."));
  assert.equal(latest.conversations.unrelated.document!.blocks.filter((block) => block.content === sourceBlock.content).length, 1);
  checks.push("moving the final source block leaves a working blank editor and typing does not duplicate the transferred content");

  await act(async () => editor(sideId).commands.setContent("Existing side destination text.", { contentType: "markdown" }));
  await settle();
  const draggedBlock = structuredClone(latest.conversations[mainId].document!.blocks.find((block) => block.content === "Fresh main text after moving.")!);
  const destinationBlock = latest.conversations[sideId].document!.blocks.find((block) => block.content === "Existing side destination text.")!;
  const dragSource = pane(mainId).querySelector(`[data-document-block-id="${draggedBlock.id}"] .rich-document-grip`);
  const dragTarget = pane(sideId).querySelector(`[data-document-block-id="${destinationBlock.id}"]`);
  dragTarget.getBoundingClientRect = () => new browser.DOMRect(600, 100, 500, 160);
  const dragData = new Map<string, string>();
  const blockTransfer = {
    effectAllowed: "", dropEffect: "", files: [],
    get types() { return [...dragData.keys()]; },
    setData(type: string, value: string) { dragData.set(type, value); },
    getData(type: string) { return dragData.get(type) ?? ""; },
  };
  for (const [target, type] of [[dragSource, "dragstart"], [dragTarget, "dragover"], [dragTarget, "drop"]] as const) {
    const event = new browser.Event(type, { bubbles: true, cancelable: true });
    Object.defineProperties(event, { dataTransfer: { value: blockTransfer }, clientX: { value: 650 }, clientY: { value: 110 } });
    await act(async () => target.dispatchEvent(event));
  }
  await settle();
  assert.equal(latest.activeConversationId, sideId);
  const destinationContents = latest.conversations[sideId].document!.blocks.map((block) => block.content);
  assert.deepEqual(destinationContents.slice(0, 2), [draggedBlock.content, destinationBlock.content], "Dropping in the upper half inserts before the chosen destination block.");
  assert.equal(destinationContents.filter((content) => content === draggedBlock.content).length, 1);
  assert(!latest.conversations[mainId].document!.blocks.some((block) => block.content === draggedBlock.content));
  assert.deepEqual(relationships(latest), relationshipsBeforeMove);
  checks.push("native block dragging transfers across visible document panes at the chosen insertion point without changing their relationships");

  const transferredState = structuredClone(latest);
  await act(async () => root.render(null));
  browser.localStorage.setItem(getStateStorageKey(billingUser.id), JSON.stringify(transferredState));
  await act(async () => root.render(createElement(WorkspaceApp, props)));
  await settle();
  assert.deepEqual(latest.conversations[sideId].document, transferredState.conversations[sideId].document);
  assert.deepEqual(latest.conversations.unrelated.document, transferredState.conversations.unrelated.document);
  assert(latest.conversations[mainId].document!.blocks.every((block) => !block.content.trim()));
  assert(editor(mainId).isEditable);
  assert.deepEqual(relationships(latest), relationshipsBeforeMove);
  checks.push("reopening retains moved block formatting and destination order while the emptied source stays writable");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
