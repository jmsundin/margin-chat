import assert from "node:assert/strict";
import { mock } from "bun:test";
import { Window } from "happy-dom";
import { createMarginDocument } from "@margin-chat/workspace-contracts";
import type { AppState, Conversation } from "../../client/src/types";
import { billingUser } from "./billingFixture";

const browser = new Window({ url: "http://document-breadcrumbs.test" });
browser.happyDOM.setWindowSize({ width: 1600, height: 1000 });
for (const name of ["window", "document", "navigator", "localStorage", "sessionStorage", "HTMLElement", "HTMLDivElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Text", "NodeFilter", "Document", "DocumentFragment", "MutationObserver", "ResizeObserver", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "WheelEvent", "Range", "DOMRect", "DOMParser", "getComputedStyle", "ShadowRoot"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value: name === "getComputedStyle" ? value.bind(browser) : value });
}
Object.defineProperties(browser.HTMLElement.prototype, {
  clientWidth: { configurable: true, get() { return this.classList.contains("conversation-canvas") ? 1200 : 500; } },
  clientHeight: { configurable: true, get: () => 800 },
});
const revealed: string[] = [];
browser.HTMLElement.prototype.scrollIntoView = function () {
  const id = this.closest("[data-document-id]")?.getAttribute("data-document-id");
  if (id) revealed.push(id);
};
let frameId = 0;
const frames = new Map<number, FrameRequestCallback>();
browser.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
browser.cancelAnimationFrame = (id) => { frames.delete(id); };
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: browser.requestAnimationFrame });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: browser.cancelAnimationFrame });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;

const { createEmptyState, createMainConversation, createSideConversation } = await import("../../client/src/initialState");
const { getStateStorageKey } = await import("../../client/src/lib/appState");
const date = "2026-10-01T12:00:00.000Z";
function withText(conversation: Conversation, title: string, blockId: string, content: string): Conversation {
  return { ...conversation, title, document: { schemaVersion: 1, prompts: [], generations: [],
    blocks: [{ id: blockId, content, kind: "markdown", createdAt: date, updatedAt: date }] } };
}
const main = withText(createMainConversation({ id: "main", createdAt: date }), "Urban heat draft", "main-block", "Dense blocks soak up sun all day.");
const interviews = withText(createSideConversation({ id: "interviews", sourceConversation: main, createdAt: date }),
  "Interview notes", "interviews-block", "Residents describe the evening heat.");
const roofs: Conversation = { ...withText(createSideConversation({ id: "roofs", sourceConversation: main, createdAt: date }),
  "Cool roofs evidence", "roofs-block", "Reflective roofs help most on low buildings."),
branchAnchor: { id: "roofs-anchor", sourceConversationId: main.id, sourceMessageId: "document:main-block", sourceBlockId: "main-block",
  startOffset: 0, endOffset: 12, quote: "Dense blocks", prompt: "Which studies compare roofs?", createdAt: date } };
const check = { ...createMarginDocument(main, { id: "check", content: "Check source", createdAt: date, updatedAt: date }, "check") } as Conversation;
main.childIds = [interviews.id, roofs.id, check.id];
main.documentLayout = { order: [main.id, check.id, roofs.id, interviews.id], minimizedIds: [], closedIds: [interviews.id] };
const initial: AppState = { ...createEmptyState(), rootId: main.id, activeConversationId: main.id,
  conversations: { [main.id]: main, [interviews.id]: interviews, [roofs.id]: roofs, [check.id]: check } };
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
const { default: WorkspaceApp } = await import("../../client/src/WorkspaceApp");
await import("../../client/src/components/RichDocumentEditor");
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
function tab(id: string) { return element(`[data-document-tab-id="${id}"] [role="tab"]`); }
function crumbs(): any[] { return [...container.querySelectorAll(".document-breadcrumb")]; }
function trigger(index: number): any { return crumbs()[index].querySelector(".document-breadcrumb-trigger"); }
function crumbLabels() { return crumbs().map((crumb) => crumb.querySelector(".document-breadcrumb-label").textContent); }
function back(): any { return element(".document-breadcrumbs-back"); }
function menu(): any { return browser.document.querySelector(".document-breadcrumb-menu"); }
function row(id: string): any { const found = menu()?.querySelector(`[data-breadcrumb-document-id="${id}"]`); assert(found, `Missing row ${id}`); return found; }
function rowTitle(id: string): any { return row(id).querySelector(".document-breadcrumb-row-title"); }
function rowLabels() { return [...menu().querySelectorAll(".document-breadcrumb-row-label")].map((label: any) => label.textContent); }
function rowTags() { return [...menu().querySelectorAll(".document-breadcrumb-row-title")].map((title: any) => title.querySelector(".document-breadcrumb-tag")?.textContent ?? null); }
function detail(): any { return browser.document.querySelector(".document-breadcrumb-detail"); }
async function settle() {
  for (let iteration = 0; frames.size && iteration < 30; iteration++) {
    const callbacks = [...frames.values()]; frames.clear();
    await act(async () => { callbacks.forEach((callback) => callback(0)); });
  }
}
async function click(target: any) { assert(target, `Click target must exist after: ${checks.at(-1)}`); await act(async () => target.click()); await settle(); }
async function wait(ms: number) { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); }
async function hover(target: any, type = "pointerover") {
  await act(async () => target.dispatchEvent(new browser.PointerEvent(type, { bubbles: true, pointerType: "mouse", relatedTarget: browser.document.body })));
}
async function key(target: any, key: string) {
  await act(async () => target.dispatchEvent(new browser.KeyboardEvent("keydown", { bubbles: true, key, cancelable: true })));
  await settle();
}
try {
  await act(async () => root.render(createElement(WorkspaceApp, props)));
  await settle();
  const bar = element('nav[aria-label="Focused document path"]');
  assert.equal(bar.previousElementSibling, element(".document-workspace-toolbar"), "The breadcrumb bar sits directly under the tab strip.");
  assert.deepEqual(panes(), ["main", "roofs"]);
  assert.deepEqual(crumbLabels(), ["Urban heat draft", "2 children"]);
  assert.equal(trigger(0).getAttribute("aria-current"), "page");
  assert.equal(trigger(0).getAttribute("aria-label"), "Urban heat draft (Peer documents: 2)");
  assert(back().disabled, "Back starts disabled.");
  checks.push("one breadcrumb under the tabs shows the focused document's level and its children");

  await hover(crumbs()[0]);
  await wait(80);
  assert.equal(menu(), null, "Passing over a crumb does not open its level at once.");
  await wait(200);
  assert(menu(), "Pausing over a crumb opens that level.");
  await click(trigger(0));
  assert(menu(), "Clicking right after hover opened the level keeps it open.");
  assert.equal(menu().parentElement, browser.document.body, "The level escapes the toolbar's clipping.");
  assert.equal(menu().querySelector(".document-breadcrumb-menu-heading").textContent, "Peer documents");
  assert.deepEqual(rowLabels(), ["Urban heat draft", "Interview notes"], "Side documents are peers of the main document.");
  assert.deepEqual(rowTags(), ["Here", null]);
  assert(row("main").querySelector('[aria-label="Expand Urban heat draft here"]').disabled);
  await hover(row("interviews"));
  assert(detail(), "Hovering a row shows its details.");
  assert(detail().textContent.includes("Side document"));
  assert(detail().textContent.includes("Residents describe the evening heat."));
  assert(detail().textContent.includes("No children"));
  assert.equal(rowTitle("interviews").getAttribute("aria-describedby"), detail().id);
  checks.push("hovering a level lists its documents and hovering a title shows its details");

  await click(row("interviews").querySelector('[aria-label="Expand Interview notes here"]'));
  assert.equal(menu(), null);
  assert.equal(latest.activeConversationId, "interviews");
  assert.deepEqual(panes(), ["interviews", "roofs"], "Expand here fills the focused document's place.");
  assert.equal(container.querySelector('[data-document-tab-id="main"]'), null, "The replaced document leaves the tab strip.");
  assert.deepEqual(latest.conversations.interviews.document, interviews.document);
  assert.deepEqual(crumbLabels(), ["Interview notes"]);
  assert.equal(back().disabled, false);
  assert.equal(back().getAttribute("aria-label"), "Back to Urban heat draft");
  checks.push("Expand here swaps the focused tab's document and enables Back");

  await click(tab("roofs"));
  assert.equal(latest.activeConversationId, "roofs");
  assert.deepEqual(panes(), ["interviews", "roofs"], "Selecting a tab does not reopen its closed main document.");
  assert.deepEqual(crumbLabels(), ["Urban heat draft", "Cool roofs evidence"], "The breadcrumb follows focus to the other tab.");
  assert(back().disabled, "Back history belongs to the tab that navigated.");
  await hover(crumbs()[1]);
  await wait(250);
  assert.equal(menu().querySelector(".document-breadcrumb-menu-heading").textContent, "Children of Urban heat draft");
  assert.deepEqual(rowLabels(), ["Check source", "Cool roofs evidence"]);
  await hover(row("roofs"));
  assert(detail().textContent.includes("Branch chat"));
  assert(detail().textContent.includes("“Dense blocks”"), "Branch details quote their source passage.");
  await hover(crumbs()[1], "pointerout");
  await wait(300);
  assert.equal(menu(), null, "Leaving the bar closes the level after a short grace period.");
  checks.push("tabs keep their own documents and the breadcrumb follows the focused tab");

  await click(tab("interviews"));
  await click(back());
  assert.equal(latest.activeConversationId, "main");
  assert.deepEqual(panes(), ["main", "roofs"], "Back returns the previous document to the same place.");
  assert.equal(container.querySelector('[data-document-tab-id="interviews"]'), null);
  assert(back().disabled);
  checks.push("Back restores the previous document in the tab");

  await click(trigger(0));
  assert(menu(), "Clicking a crumb opens its level immediately.");
  await click(row("interviews").querySelector('[aria-label="Open Interview notes beside"]'));
  assert.equal(latest.activeConversationId, "main", "Open beside keeps focus.");
  assert.deepEqual(panes(), ["main", "interviews", "roofs"]);
  assert.equal(revealed.at(-1), "interviews", "The opened document scrolls into view.");
  await click(trigger(0));
  assert.deepEqual(rowTags(), ["Here", "Open"]);
  await click(browser.document.body);
  assert.equal(menu(), null, "Clicking outside dismisses the level.");
  checks.push("Open beside adds the document next to the focused one without moving focus");

  await act(async () => trigger(1).focus());
  await key(trigger(1), "ArrowDown");
  assert(menu());
  assert.equal(browser.document.activeElement, rowTitle("check"), "ArrowDown moves into the level.");
  assert.deepEqual(rowTags(), ["Open", "Open"]);
  await key(browser.document.activeElement, "ArrowDown");
  assert.equal(browser.document.activeElement, rowTitle("roofs"));
  await key(browser.document.activeElement, "ArrowRight");
  assert.equal(browser.document.activeElement.getAttribute("aria-label"), "Expand Cool roofs evidence here");
  await key(browser.document.activeElement, "Escape");
  assert.equal(menu(), null);
  assert.equal(browser.document.activeElement, trigger(1), "Escape returns focus to the crumb.");
  await click(trigger(1));
  await click(rowTitle("roofs"));
  assert.equal(latest.activeConversationId, "roofs");
  assert.deepEqual(panes(), ["main", "interviews", "roofs"], "Expanding a document that is already open only moves focus.");
  assert(back().disabled);
  checks.push("keyboard users can open a level, move between rows and actions, and close it");
  console.log(JSON.stringify({ passed: true, checks }));
} finally {
  await act(async () => root.unmount());
  browser.close();
}
