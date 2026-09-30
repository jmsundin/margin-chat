import assert from "node:assert/strict";
import { mock } from "bun:test";
import { Window } from "happy-dom";
import type { AppState, Conversation } from "../../client/src/types";
import { billingUser } from "./billingFixture";

const browser = new Window({ url: "http://document-links.test" });
const mobileSelectionTest = process.env.TEST_MOBILE_SELECTION === "1";
browser.happyDOM.setWindowSize({ width: mobileSelectionTest ? 390 : 1600, height: 844 });
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
const api = await import("../../client/src/lib/api");
type ChatRequest = Parameters<typeof api.requestChatReply>[0];
const chatRequests: ChatRequest[] = [];
const finishRequests: Array<(reply: string) => void> = [];
mock.module("../../client/src/lib/api", () => ({ ...api,
  requestChatReply: (request: ChatRequest) => {
    chatRequests.push(request);
    return new Promise<Awaited<ReturnType<typeof api.requestChatReply>>>((resolve) => {
      finishRequests.push((reply) => {
        request.onDelta?.(reply);
        resolve({ reply, metadata: { model: request.modelId, requestedServiceId: request.serviceId, resolvedServiceId: request.serviceId } });
      });
    });
  },
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
async function selectSourcePassage() {
  const current = editor("source-block");
  await act(async () => { current.commands.focus(); current.commands.setTextSelection(1); });
  await settle();
  let from = -1;
  current.state.doc.descendants((node: any, position: number) => {
    const index = node.isText ? node.text.indexOf("selected passage") : -1;
    if (index >= 0) from = position + index;
  });
  assert(from >= 0, "The selected passage still exists in the real editor.");
  await act(async () => current.commands.setTextSelection({ from, to: from + "selected passage".length }));
  await settle();
  return { current, from };
}
async function selectPassage() {
  await selectSourcePassage();
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
async function testMobileSelectionActions() {
  const sourceBlocks = structuredClone(latest.conversations.source.document!.blocks);
  const { current, from } = await selectSourcePassage();
  const actionBar = element('[data-testid="branch-composer"]');
  for (const label of ["Explain", "Rewrite", "Ask"]) assert(button(label, actionBar));
  assert.equal(browser.document.querySelector('[aria-label="Branch prompt"]'), null, "Selecting text must not open the typing UI.");
  assert.equal(current.view.dom.getAttribute("inputmode"), "none", "Reading and selection keep the native keyboard suppressed.");
  const native = browser.getSelection()!;
  const textNode = current.view.dom.querySelector("p").firstChild;
  const range = browser.document.createRange();
  const start = textNode.textContent.indexOf("selected passage");
  range.setStart(textNode, start); range.setEnd(textNode, start + 16);
  await act(async () => { native.removeAllRanges(); native.addRange(range); });
  await act(async () => browser.document.body.dispatchEvent(new browser.PointerEvent("pointerdown", { bubbles: true, pointerType: "touch" })));
  assert.equal(native.toString(), "selected passage", "Dragging native handles outside the editor must retain the range.");
  assert.equal(chatRequests.length, 0, "Selection and handle gestures do not generate AI responses.");
  await click(button("Ask", element('[data-testid="branch-composer"]')));
  assert(element('[aria-label="Branch prompt"]'));
  await act(async () => current.commands.focus());
  await settle();
  await act(async () => current.commands.setTextSelection({ from, to: from + 8 }));
  await settle();
  assert.equal(browser.document.querySelector('[aria-label="Branch prompt"]'), null, "Adjusting the selected passage returns to the quick actions.");
  assert(button("Explain", element('[data-testid="branch-composer"]')));
  checks.push("native selection handles remain usable, no keyboard opens, and adjusting the passage restores quick actions");

  for (const [label, expectedPrompt] of [
    ["Explain", "Explain the selected text."],
    ["Rewrite", "Rewrite the selected text for clarity and flow, preserving its meaning and tone. Return only the rewritten passage."],
  ]) {
    await selectSourcePassage();
    const before = chatRequests.length;
    const action = button(label, element('[data-testid="branch-composer"]'));
    await act(async () => {
      action.dispatchEvent(new browser.TouchEvent("touchend", { bubbles: true, cancelable: true, touches: [] }));
      action.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 }));
    });
    await settle();
    assert.equal(chatRequests.length, before + 1, `${label} generates exactly once from a single tap, without opening a prompt.`);
    assert.equal(browser.document.querySelector('[aria-label="Branch prompt"]'), null);
    const request = chatRequests.at(-1)!;
    assert(request.messages.at(-1)!.content.endsWith(`User request:\n\n${expectedPrompt}`));
    assert(request.messages.at(-1)!.content.includes('"selectedPassage":"selected passage"'));
    assert(request.messages.at(-1)!.content.includes("Alpha selected passage omega."));
    const resultId = request.conversation.id;
    assert.notEqual(resultId, "source", `${label} creates an inspectable suggestion in a side document.`);
    const result = latest.conversations[resultId];
    assert.equal(result.parentId, "source");
    assert.equal(result.branchAnchor!.sourceBlockId, "source-block");
    assert.equal(result.branchAnchor!.quote, "selected passage");
    assert.equal(result.branchAnchor!.startOffset, 6);
    assert.equal(result.branchAnchor!.endOffset, 22);
    assert.deepEqual(latest.conversations.source.document!.blocks, sourceBlocks, `${label} must preserve the original passage.`);
    await act(async () => finishRequests[before](`${label} generated result.`));
    await settle();
    assert(latest.conversations[resultId].document!.blocks.some((block) => block.content === `${label} generated result.`));
    assert.equal(latest.conversations[resultId].document!.generations[0].status, "complete");
    assert.deepEqual(latest.conversations.source.document!.blocks, sourceBlocks, "Completing a rewrite must not replace the original.");
    assert.equal(chatRequests.length, before + 1, "Streaming completion must not retrigger the action.");
    checks.push(`${label.toLowerCase()} immediately generates once with the selected source and preserves the original document`);
    await click(element('[data-document-tab-id="source"] [role="tab"]'));
  }

  const { current: editingSource } = await selectSourcePassage();
  await click(element('[aria-label="Show keyboard"]'));
  assert.equal(browser.document.activeElement, editingSource.view.dom);
  assert.equal(editingSource.view.dom.getAttribute("inputmode"), "text", "Ask is exercised from an active document editing session.");
  let collapsedOnBlur = false;
  editingSource.view.dom.addEventListener("blur", () => {
    collapsedOnBlur = true;
    browser.getSelection()!.removeAllRanges();
    browser.document.dispatchEvent(new browser.Event("selectionchange"));
  }, { once: true });
  const beforeAsk = chatRequests.length;
  await click(button("Ask", element('[data-testid="branch-composer"]')));
  assert(collapsedOnBlur, "Ask must blur the source editor to end its input session.");
  assert.notEqual(browser.document.activeElement, editingSource.view.dom, "The source must not remain focused behind the prompt.");
  await act(async () => browser.document.dispatchEvent(new browser.Event("selectionchange")));
  await settle();
  const prompt = element('[aria-label="Branch prompt"]');
  const composer = element(".mobile-ai-composer");
  assert.equal(prompt.tagName, "TEXTAREA");
  assert.equal(prompt.getAttribute("inputmode"), "text", "Tapping the custom prompt uses normal native keyboard behavior.");
  assert.equal(prompt.hasAttribute("data-mobile-keyboard"), false, "Typing a prompt must not depend on the document keyboard toggle.");
  assert.notEqual(browser.document.activeElement, prompt, "Opening Ask retains reading mode until the user taps the input.");
  assert.equal(chatRequests.length, beforeAsk, "Ask never starts generation just by opening.");
  assert.equal(container.contains(composer), false, "The compact prompt is portaled outside document scrolling.");
  assert.equal(composer.querySelector('[aria-label="Choose AI model and provider"]'), null, "Model and destination controls stay tucked away initially.");
  await click(element('[aria-label="Show selected text"]'));
  assert(composer.querySelector("blockquote").textContent.includes("selected passage"), "The saved quote survives native selection collapse when Ask blurs the editor.");
  await click(element('button[aria-label="Prompt options"]'));
  await click(element('[aria-label="Choose AI model and provider"]'));
  const search = element('[aria-label="Search AI models"]');
  await act(async () => {
    search.dispatchEvent(new browser.PointerEvent("pointerdown", { bubbles: true }));
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(search, "GPT-6 Sol");
    search.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  assert.equal(element(".mobile-ai-composer"), composer, "The model picker does not dismiss or remount the custom prompt.");
  await click(element('[aria-label="Search results"] .picker-model-row'));
  assert.equal(latest.conversations.source.modelId, "gpt-6-sol");
  assert.equal(browser.document.querySelector('[role="dialog"]'), null);
  await click(element('[aria-label="Choose AI model and provider"]'));
  await act(async () => browser.document.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(element(".mobile-ai-composer"), composer, "Escape from the model picker keeps the selected passage composer.");
  await act(async () => {
    prompt.focus();
    Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, "Compare this with the rest of my notes.");
    prompt.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  assert.equal(browser.document.activeElement, prompt);
  assert.equal(element('button[aria-label="Prompt options"]').getAttribute("aria-expanded"), "false", "Typing collapses secondary controls to leave document space.");
  assert.equal(chatRequests.length, beforeAsk, "Typing waits for an explicit send.");
  await act(async () => composer.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })));
  await settle();
  assert.equal(chatRequests.length, beforeAsk + 1);
  const customRequest = chatRequests.at(-1)!;
  assert(customRequest.messages.at(-1)!.content.endsWith("Compare this with the rest of my notes."));
  assert(customRequest.messages.at(-1)!.content.includes('"selectedPassage":"selected passage"'));
  assert.equal(customRequest.modelId, "gpt-6-sol");
  await act(async () => finishRequests[beforeAsk]("Custom generated result."));
  await settle();
  assert.deepEqual(latest.conversations.source.document!.blocks, sourceBlocks);
  checks.push("Ask uses a compact normal typing field, retains context through model selection, and generates only on send");
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
  if (mobileSelectionTest) {
    await testMobileSelectionActions();
  } else {
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
  const childrenTrigger = () => element('[aria-label="Children of Source research (2)"]');
  await click(childrenTrigger());
  const childEntries = [...browser.document.querySelectorAll<HTMLButtonElement>(".document-child-tabs-list > button")];
  assert.equal(childEntries.length, 2, "The existing branch and linked document share the Children list.");
  assert(childEntries.some((button) => button.textContent?.includes("Destination research")));
  await click(childEntries.find((button) => button.textContent?.includes("Destination research")));
  assert.equal(latest.activeConversationId, "target", "Linked children open from the same Children menu.");
  await click(element('.thread-item-main[title="Source research"]'));

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
  assert(element('[aria-label="Children of Source research (1)"]'), "Removing the link immediately updates the child count.");
  assert.equal(browser.document.querySelector('[data-document-block-id="source-block"] [data-annotation-branches]'), null);
  assert.equal(editor("source-block").getMarkdown(), "New Alpha selected passage omega.");
  assert.deepEqual(ancestry(latest), originalAncestry);
  checks.push("removing a link from its preview removes the highlight while retaining both documents and existing branches");

  await selectPassage();
  await click(element('[aria-label="Connect to document Destination research"]'));
  const documentLink = latest.conversations.source.document!.links![0];
  assert(childrenTrigger(), "Document links count as children just like block links.");
  assert.equal(documentLink.targetConversationId, "target");
  assert.equal(documentLink.targetBlockId, undefined);
  const documentPopup = await openPreview();
  assert(documentPopup.textContent.includes("Linked document"));
  await click(button("Open linked document", documentPopup));
  assert.equal(latest.activeConversationId, "target");
  assert.deepEqual(ancestry(latest), originalAncestry);
  assert.equal(Object.keys(latest.conversations).length, 3);
  checks.push("the same selection action connects to an entire existing document and navigates without manufacturing a side document");
  }
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
