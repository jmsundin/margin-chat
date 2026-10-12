import assert from "node:assert/strict";
import { mock } from "bun:test";
import { Window } from "happy-dom";
import type { AppState } from "../../client/src/types";
import { billingUser } from "./billingFixture";

const browser = new Window({ url: "http://map-panel-children.test" });
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

const { createEmptyState, createChildConversation } = await import("../../client/src/initialState");
const { getStateStorageKey } = await import("../../client/src/lib/appState");
const initial = createEmptyState();
const mainId = initial.rootId;
initial.conversations[mainId].title = "Main research";
const child = createChildConversation({ id: "child-doc", parentConversation: initial.conversations[mainId] });
child.title = "Child notes";
initial.conversations[child.id] = child;
initial.conversations[mainId].childIds.push(child.id);
const grandchild = createChildConversation({ id: "grandchild-doc", parentConversation: child });
grandchild.title = "Grandchild detail";
initial.conversations[grandchild.id] = grandchild;
child.childIds.push(grandchild.id);
browser.localStorage.setItem(getStateStorageKey(billingUser.id), JSON.stringify(initial));
mock.module("../../client/src/lib/useMarkdownVault", () => ({
  useMarkdownVault() {
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
await Promise.all([import("../../client/src/components/RichDocumentEditor"), import("../../client/src/components/KnowledgeGraphWorkspace")]);
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
async function settle() {
  for (let iteration = 0; frames.size && iteration < 30; iteration++) {
    const callbacks = [...frames.values()]; frames.clear();
    await act(async () => { callbacks.forEach((callback) => callback(0)); });
  }
}
async function click(target: any) { assert(target, "Expected a click target"); await act(async () => target.click()); await settle(); }
const dock = () => container.querySelector(".conversation-graph-dock");
const mapView = () => container.querySelector('[data-workspace-view="graph"]');
try {
  await act(async () => root.render(createElement(WorkspaceApp, props)));
  await settle();
  await click([...container.querySelectorAll('.workspace-mode-control [role="radio"]')].find((item: any) => item.getAttribute("aria-label") === "Map View"));
  await click(element('[aria-label="Canvas view"]'));
  await click(element(`[data-conversation-id="${mainId}"] .conversation-graph-node-select`));
  assert.equal(dock()?.getAttribute("aria-label"), "Docked chat: Main research", "Clicking a document opens it in the side panel");
  assert.equal(dock()!.querySelector(".document-panel-breadcrumbs"), null, "A top-level document has no parents to show");

  await click(dock()!.querySelector(".document-children-trigger"));
  const childButton = [...dock()!.querySelectorAll(".document-children-list button")].find((item: any) => item.textContent?.includes("Child notes"));
  await click(childButton);
  assert.equal(dock()?.getAttribute("aria-label"), "Docked chat: Child notes", "Clicking a child shows it in the same side panel");
  assert(!mapView()?.hasAttribute("inert") && !mapView()?.hidden, "Map View stays open");
  assert.deepEqual([...dock()!.querySelectorAll(".document-panel-breadcrumbs li")].map((item: any) => item.textContent), ["Main research", "Child notes"]);
  checks.push("a child opens in the side panel with its parent as a breadcrumb");

  await click(dock()!.querySelector(".document-children-trigger"));
  await click([...dock()!.querySelectorAll(".document-children-list button")].find((item: any) => item.textContent?.includes("Grandchild detail")));
  assert.deepEqual([...dock()!.querySelectorAll(".document-panel-breadcrumbs li")].map((item: any) => item.textContent), ["Main research", "Child notes", "Grandchild detail"]);
  await click([...dock()!.querySelectorAll(".document-panel-breadcrumbs button")].find((item: any) => item.textContent === "Main research"));
  assert.equal(dock()?.getAttribute("aria-label"), "Docked chat: Main research", "A breadcrumb shows that parent in the side panel");
  checks.push("breadcrumbs move the side panel back up to a parent");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
