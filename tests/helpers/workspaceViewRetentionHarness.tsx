import assert from "node:assert/strict";
import { mock } from "bun:test";
import { Window } from "happy-dom";
import type { AppState } from "../../client/src/types";
import { billingUser } from "./billingFixture";

const browser = new Window({ url: "http://workspace-view-retention.test" });
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
browser.HTMLElement.prototype.scrollIntoView = function () {};
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
const initial = createEmptyState();
const mainId = initial.rootId;
initial.conversations[mainId].title = "Main research";
initial.conversations[mainId].document = getEditableDocument(initial.conversations[mainId]);
initial.conversations[mainId].document!.blocks[0].content = "Original main document text.";
const templateBlock = initial.conversations[mainId].document!.blocks[0];
initial.conversations[mainId].document!.blocks = Array.from({ length: 12 }, (_, index) => ({
  ...templateBlock, id: `main-block-${index}`,
  content: `## Research topic ${index}\n\n` + "A substantial **editable** passage about components and design. ".repeat(8),
}));
const unrelated = createMainConversation({ id: "unrelated" });
unrelated.title = "Unrelated project";
unrelated.document = getEditableDocument(unrelated);
unrelated.document.blocks[0].content = "Fresh unrelated document content.";
initial.conversations[unrelated.id] = unrelated;
browser.localStorage.setItem(getStateStorageKey(billingUser.id), JSON.stringify(initial));
let latest: AppState = initial;
mock.module("../../client/src/lib/useMarkdownVault", () => ({
  useMarkdownVault(args: { state: AppState }) {
    latest = args.state;
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
const { Editor } = await import("@tiptap/core");
const originalMount = Editor.prototype.mount;
const originalDestroy = Editor.prototype.destroy;
let editorMounts = 0;
let editorDestroys = 0;
Editor.prototype.mount = function (...args) { editorMounts += 1; return originalMount.apply(this, args); };
Editor.prototype.destroy = function (...args) { editorDestroys += 1; return originalDestroy.apply(this, args); };
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
function element(selector: string): any {
  const found = container.querySelector(selector);
  assert(found, `Missing ${selector}`);
  return found;
}
function isVisible(element: any) {
  for (let current = element; current; current = current.parentElement) {
    if (current.hidden || current.getAttribute("aria-hidden") === "true" || current.style.display === "none") return false;
  }
  return true;
}
async function settle() {
  for (let iteration = 0; frames.size && iteration < 30; iteration++) {
    const callbacks = [...frames.values()]; frames.clear();
    await act(async () => { callbacks.forEach((callback) => callback(0)); });
  }
  assert.equal(frames.size, 0, "Workspace animation effects settle.");
}
async function click(target: any) { assert(target, "Expected a click target"); await act(async () => target.click()); await settle(); }
async function switchMode(label: "Document" | "Tiles" | "Map") {
  await click([...container.querySelectorAll(".workspace-mode-trigger")].find(isVisible));
  await click([...browser.document.querySelectorAll('[role="menuitemradio"]')].find((item) => item.textContent?.trim() === label));
}
try {
  await act(async () => root.render(createElement(WorkspaceApp, props)));
  await settle();
  assert.equal(container.querySelector(".conversation-graph-viewport"), null, "Map stays lazy until the user opens it.");
  const initialDocument = element(".document-workspace");
  const initialEditorElement = element(".document-workspace .tiptap");
  const initialEditor = initialEditorElement.editor;
  const body = element(".document-workspace .document-body");
  await act(async () => initialEditor.commands.insertContent("A retained edit. "));
  await settle();
  body.scrollTop = 317;
  const editedContent = initialEditor.getMarkdown();
  const editorIds = [...container.querySelectorAll(".document-workspace .tiptap")].map((item: any) => item.editor);
  const initialMounts = editorMounts;

  await switchMode("Tiles");
  assert.equal(container.querySelector(".document-workspace"), initialDocument);
  assert(!isVisible(initialDocument), "The retained document is hidden while Tiles is active.");
  assert(initialDocument.closest('[data-workspace-view="chat"]')?.hasAttribute("inert"), "The hidden document cannot receive keyboard or pointer input.");
  assert.equal(editorDestroys, 0, "Leaving Document does not destroy its editors.");
  assert.equal(editorMounts, initialMounts);
  checks.push("leaving Document preserves its editor instances and hides the inactive view");

  await switchMode("Document");
  assert(isVisible(initialDocument));
  assert.equal(element(".document-workspace .tiptap"), initialEditorElement);
  assert.equal(initialEditorElement.editor, initialEditor);
  assert.equal(initialEditor.getMarkdown(), editedContent);
  assert.equal(body.scrollTop, 317);
  assert.deepEqual([...container.querySelectorAll(".document-workspace .tiptap")].map((item: any) => item.editor), editorIds);
  assert.equal(editorMounts, initialMounts, "Returning to Document does not recreate existing editors.");
  checks.push("returning to Document preserves edits, scroll position, and every editor instance");

  await switchMode("Map");
  const initialMap = element(".conversation-graph-viewport");
  assert(isVisible(initialMap));
  const stage = element(".conversation-graph-stage");
  const originalTransform = stage.style.transform;
  await click([...container.querySelectorAll('[aria-label="Zoom in"]')].find(isVisible));
  const retainedTransform = stage.style.transform;
  assert.notEqual(retainedTransform, originalTransform, "The map camera changed before testing retention.");
  const warmMounts = editorMounts;
  const warmDestroys = editorDestroys;
  for (const label of ["Tiles", "Document", "Map", "Document", "Map"] as const) {
    await switchMode(label);
    assert.equal(container.querySelector(".conversation-graph-viewport"), initialMap, "Returning to Map retains its canvas instance.");
    assert.equal(isVisible(initialMap), label === "Map");
    assert.equal(isVisible(initialDocument), label === "Document");
    if (label === "Map") assert.equal(stage.style.transform, retainedTransform, "Returning to Map preserves its camera position and zoom.");
    for (const wrapper of container.querySelectorAll("[data-workspace-view]")) {
      assert.equal(wrapper.hasAttribute("inert"), wrapper.hasAttribute("hidden"), "Only visible views can receive input.");
    }
    assert.equal(editorMounts, warmMounts, "Warm mode switches create no editors.");
    assert.equal(editorDestroys, warmDestroys, "Warm mode switches destroy no editors.");
  }
  checks.push("repeated Document, Tiles, and Map switches retain the map and perform no editor teardown or setup");

  await switchMode("Tiles");
  const unrelatedTile = [...container.querySelectorAll(".thread-tile-card")].find((item) => item.textContent?.includes("Unrelated project"));
  await click(unrelatedTile);
  assert.equal(latest.activeConversationId, unrelated.id);
  const visibleDocument = [...container.querySelectorAll(".document-workspace")].find(isVisible);
  assert(visibleDocument, "Opening a tile activates Document mode.");
  assert(visibleDocument.textContent?.includes("Fresh unrelated document content."), "Retained views receive current workspace data when activated.");
  assert.equal((visibleDocument.querySelector('[aria-label="Document title"]') as any)?.value, "Unrelated project");
  checks.push("opening another document from Tiles refreshes the retained document view with its current content");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  Editor.prototype.mount = originalMount;
  Editor.prototype.destroy = originalDestroy;
  await browser.happyDOM.close();
}
