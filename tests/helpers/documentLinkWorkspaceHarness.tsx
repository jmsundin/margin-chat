import assert from "node:assert/strict";
import { mock } from "bun:test";
import { Window } from "happy-dom";
import type { AppState, Conversation } from "../../client/src/types";
import { billingUser } from "./billingFixture";

const browser = new Window({ url: "http://document-links.test" });
browser.happyDOM.setWindowSize({ width: 1600, height: 1000 });
for (const name of ["window", "document", "navigator", "localStorage", "sessionStorage", "HTMLElement", "HTMLDivElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Text", "NodeFilter", "Document", "DocumentFragment", "MutationObserver", "ResizeObserver", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "Range", "DOMRect", "DOMParser", "getComputedStyle", "ShadowRoot"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value: name === "getComputedStyle" ? value.bind(browser) : value });
}
Object.defineProperties(browser.HTMLElement.prototype, {
  clientWidth: { configurable: true, get: () => 800 }, clientHeight: { configurable: true, get: () => 800 },
});
const scrolled: Array<{ conversationId: string | null; blockId: string | null }> = [];
browser.HTMLElement.prototype.scrollIntoView = function () {
  scrolled.push({ conversationId: this.closest("[data-document-id]")?.getAttribute("data-document-id") ?? null,
    blockId: this.getAttribute("data-document-block-id") });
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
const date = "2026-09-25T12:00:00.000Z";
function document(id: string, title: string, contents: Array<[string, string]>): Conversation {
  return { ...createMainConversation({ id, createdAt: date }), title,
    document: { schemaVersion: 1, prompts: [], generations: [], blocks: contents.map(([id, content]) =>
      ({ id, content, kind: "markdown", createdAt: date, updatedAt: date })) } };
}
const source = document("source", "Source research", [["source-block", "Alpha selected passage omega."], ["source-other", "A second source block."]]);
const target = document("target", "Destination research", [["target-intro", "# Destination introduction"], ["target-detail", "Destination block detail with useful context."]]);
const child = createSideConversation({ id: "existing-side", sourceConversation: source, createdAt: date });
source.childIds = [child.id];
const initial: AppState = { ...createEmptyState(), rootId: source.id, activeConversationId: source.id,
  conversations: { [source.id]: source, [target.id]: target, [child.id]: child } };
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
function element(selector: string): any { const found = browser.document.querySelector(selector); assert(found, `Missing ${selector}`); return found; }
function editor(id: string): any { return element(`[data-document-block-id="${id}"] .tiptap`).editor; }
function mark(): any { return element('[data-document-block-id="source-block"] [data-annotation-branches]'); }
function preview(): any { return element('[aria-label="Linked chat and note preview"]'); }
function button(text: string, scope: any = browser.document): any {
  const found = [...scope.querySelectorAll("button")].find((item: any) => item.textContent?.trim().startsWith(text));
  assert(found, `Missing button ${text}`); return found;
}
async function settle() {
  for (let iteration = 0; frames.size && iteration < 30; iteration++) {
    const callbacks = [...frames.values()]; frames.clear();
    await act(async () => callbacks.forEach((callback) => callback(0)));
  }
  assert.equal(frames.size, 0, "Workspace animation effects settle.");
}
async function click(target: any) { await act(async () => target.click()); await settle(); }
async function selectPassage() {
  const current = editor("source-block");
  await act(async () => current.commands.focus());
  await settle();
  let from = -1;
  current.state.doc.descendants((node: any, position: number) => {
    const index = node.isText ? node.text.indexOf("selected passage") : -1;
    if (index >= 0) from = position + index;
  });
  assert(from >= 0, "The selected passage still exists in the real editor.");
  await act(async () => current.commands.setTextSelection({ from, to: from + "selected passage".length }));
  await settle();
  assert(element(".selection-tooltip-quote").textContent.includes("selected passage"));
  await click(element('[aria-label="Choose AI model and provider"]'));
  const search = element('[aria-label="Search AI models"]');
  await act(async () => {
    search.dispatchEvent(new browser.PointerEvent("pointerdown", { bubbles: true }));
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(search, "GPT-6 Sol");
    search.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  assert(element(".selection-tooltip-quote").textContent.includes("selected passage"));
  await click(element('[aria-label="Search results"] .picker-model-row'));
  assert.equal(latest.conversations.source.modelId, "gpt-6-sol");
  assert.equal(latest.conversations.source.serviceId, "openai-api");
  assert.equal(browser.document.querySelector('[role="dialog"]'), null);
  assert(element('[aria-label="Choose AI model and provider"]').textContent.includes("GPT-6 Sol"));
  await click(element('[aria-label="Choose AI model and provider"]'));
  await act(async () => browser.document.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert(element(".selection-tooltip-quote"), "Escape closes only the model picker.");
  await click(element('[aria-label="Link selected text to an existing document or block"]'));
}
async function openPreview() {
  await act(async () => new Promise((resolve) => setTimeout(resolve, 30)));
  await settle();
  browser.getSelection().removeAllRanges();
  const old = mark();
  await act(async () => old.dispatchEvent(new browser.PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })));
  await act(async () => new Promise((resolve) => setTimeout(resolve, 350)));
  return preview();
}

function ancestry(state: AppState) {
  return Object.fromEntries(Object.values(state.conversations).map((conversation) => [conversation.id,
    { parentId: conversation.parentId, childIds: conversation.childIds, branchAnchor: conversation.branchAnchor }]));
}
const originalAncestry = structuredClone(ancestry(initial));
const checks: string[] = [];
try {
  await act(async () => root.render(createElement(WorkspaceApp, props)));
  await settle();
  await selectPassage();
  await click(element('[aria-label="Browse blocks in Destination research"]'));
  await click(button("Block 2", element(".document-link-picker")));
  const link = latest.conversations.source.document!.links![0];
  assert.equal(link.quote, "selected passage");
  assert.equal(link.sourceBlockId, "source-block");
  assert.equal(link.startOffset, 6);
  assert.equal(link.endOffset, 22);
  assert.equal(link.targetConversationId, "target");
  assert.equal(link.targetBlockId, "target-detail");
  assert.equal(mark().textContent, "selected passage");
  assert.deepEqual(JSON.parse(mark().dataset.annotationBranches), [link.id]);
  assert.equal(browser.document.querySelector(".document-link-picker"), null);
  assert.deepEqual(ancestry(latest), originalAncestry);
  checks.push("real rich selection creates a durable block link and source highlight without creating or reparenting documents");

  const popup = await openPreview();
  assert(popup.textContent.includes("Linked block"));
  assert(popup.textContent.includes("Destination block detail with useful context."));
  await click(button("Open linked block", popup));
  assert.equal(latest.activeConversationId, "target");
  assert(scrolled.some((item) => item.conversationId === "target" && item.blockId === "target-detail"), "Navigation reveals the linked block, not just its document.");
  assert.equal(editor("target-detail").getMarkdown(), "Destination block detail with useful context.");
  assert.deepEqual(ancestry(latest), originalAncestry);
  checks.push("highlight preview shows the destination content and opens its precise block across document families");

  await click(element('.thread-item-main[title="Source research"]'));
  const sourceEditor = editor("source-block");
  await act(async () => { sourceEditor.commands.setTextSelection(1); sourceEditor.commands.insertContent("New "); });
  await settle();
  const remapped = latest.conversations.source.document!.links![0];
  assert.equal(remapped.id, link.id);
  assert.equal(remapped.startOffset, 10);
  assert.equal(remapped.endOffset, 26);
  assert.equal(remapped.targetBlockId, "target-detail");
  assert.equal(mark().textContent, "selected passage");
  checks.push("editing before a linked passage remaps the saved range and keeps the highlight on the same text");

  await click(button("Remove link", await openPreview()));
  assert.deepEqual(latest.conversations.source.document!.links, []);
  assert.equal(browser.document.querySelector('[data-document-block-id="source-block"] [data-annotation-branches]'), null);
  assert.equal(editor("source-block").getMarkdown(), "New Alpha selected passage omega.");
  assert.deepEqual(ancestry(latest), originalAncestry);
  checks.push("removing a link from its preview removes the highlight while retaining both documents and existing branches");

  await selectPassage();
  await click(element('[aria-label="Connect to document Destination research"]'));
  const documentLink = latest.conversations.source.document!.links![0];
  assert.equal(documentLink.targetConversationId, "target");
  assert.equal(documentLink.targetBlockId, undefined);
  const documentPopup = await openPreview();
  assert(documentPopup.textContent.includes("Linked document"));
  await click(button("Open linked document", documentPopup));
  assert.equal(latest.activeConversationId, "target");
  assert.deepEqual(ancestry(latest), originalAncestry);
  assert.equal(Object.keys(latest.conversations).length, 3);
  checks.push("the same selection action connects to an entire existing document and navigates without manufacturing a side document");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
