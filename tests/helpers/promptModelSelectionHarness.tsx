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
const source = document("source", "Source research", [["source-block", "Alpha selected passage omega."], ["source-other", ""]]);
const target = document("target", "Destination research", [["target-intro", "# Destination introduction"], ["target-detail", "Destination block detail with useful context."]]);
const child = createSideConversation({ id: "existing-side", sourceConversation: source, createdAt: date });
source.childIds = [child.id];
source.serviceId = "openai-api";
source.modelId = "gpt-6-astra";
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
const requests: any[] = [];
const originalFetch = globalThis.fetch;
globalThis.fetch = (async (url, init) => {
  assert.equal(String(url), "/api/chat");
  const body = JSON.parse(String(init?.body)); requests.push(body);
  return Response.json({ reply: "Generated text.", metadata: { model: body.modelId, requestedModelId: body.modelId,
    requestedServiceId: body.serviceId, resolvedServiceId: body.serviceId, credentialSource: "personal",
    execution: { schemaVersion: 1, model: body.modelId, provider: body.serviceId, mode: "balanced", task: "writing", reason: "Used your selected provider and model.",
      profileVersion: "test", routing: { method: "manual", selectedModel: body.modelId }, sources: [], truncated: false, fallbacks: [], warnings: [], status: "complete" } } });
}) as typeof fetch;
async function fill(node: any, value: string) {
  await act(async () => {
    const prototype = node.tagName === "TEXTAREA" ? browser.HTMLTextAreaElement.prototype : browser.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(node, value);
    node.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
}
try {
  await act(async () => root.render(createElement(WorkspaceApp, props)));
  await settle();
  const value = editor("source-other");
  await act(async () => { value.commands.focus(); value.commands.setTextSelection(value.state.doc.content.size - 1); });
  await settle();
  await act(async () => value.view.dom.dispatchEvent(new browser.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })));
  await fill(element('[aria-label="AI prompt"]'), "Continue with a sentence.");
  await click(element('[aria-label="Choose AI model"]'));
  await fill(element('[aria-label="Search AI models"]'), "GPT-6 Luna");
  await act(async () => {
    element('[aria-label="Search results"] .picker-model-row').click();
    button("Generate").click();
  });
  await settle();
  assert.equal(requests.at(-1)?.modelId, "gpt-6-luna");
  assert.equal(requests.at(-1)?.serviceId, "openai-api");
  assert.equal(latest.conversations.source.document!.generations.at(-1)!.modelId, "gpt-6-luna");
  assert.equal(latest.conversations.source.messages.at(-1)!.execution!.model, "gpt-6-luna");

  // A saved prompt rerun must also read the newly picked model before commit.
  await click(element('.document-prompt-icon'));
  await click(element('[aria-label="Choose AI model for another version"]'));
  await fill(element('[aria-label="Search AI models"]'), "GPT-6 Astra");
  await click(element('[aria-label="Search results"] .picker-model-row'));
  await click(element('[aria-label="Choose AI model for another version"]'));
  await fill(element('[aria-label="Search AI models"]'), "GPT-6 Luna");
  await act(async () => {
    element('[aria-label="Search results"] .picker-model-row').click();
    button("↻ Try another version").click();
  });
  await settle();
  assert.equal(requests.at(-1)?.modelId, "gpt-6-luna");
  assert.equal(latest.conversations.source.document!.generations.at(-1)!.modelId, "gpt-6-luna");

  // Selected-passage side documents inherit the explicit model, including a batched change.
  await click(element('[aria-label="Choose AI model for another version"]'));
  await fill(element('[aria-label="Search AI models"]'), "GPT-6 Astra");
  await click(element('[aria-label="Search results"] .picker-model-row'));
  await click(element('[aria-label="Close prompt history"]'));
  await act(async () => editor("source-block").commands.focus());
  await settle();
  await act(async () => editor("source-block").commands.setTextSelection({ from: 7, to: 23 }));
  await settle();
  await fill(element('[aria-label="Branch prompt"]'), "Explain the passage.");
  await click(button("Side document ↗"));
  await click(element('[aria-label="Choose AI model and provider"]'));
  await fill(element('[aria-label="Search AI models"]'), "GPT-6 Luna");
  await act(async () => {
    element('[aria-label="Search results"] .picker-model-row').click();
    element('[aria-label="Create branch with prompt"]').click();
  });
  await settle();
  assert.equal(requests.length, 3);
  assert(requests.every((request) => request.modelId === "gpt-6-luna" && request.serviceId === "openai-api"));
  const side = latest.conversations[requests.at(-1).conversation.id];
  assert.equal(side.parentId, "source");
  assert.equal(side.modelId, "gpt-6-luna");
  assert.equal(side.document!.generations.at(-1)!.modelId, "gpt-6-luna");
  assert.equal(side.messages.at(-1)!.execution!.model, "gpt-6-luna");
  console.log("Luna selection verified for inline, rerun, and side-document requests.");
} finally {
  globalThis.fetch = originalFetch;
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
