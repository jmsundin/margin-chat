import assert from "node:assert/strict";
import { mock } from "bun:test";
import { Window } from "happy-dom";
import type { AppState } from "../../client/src/types";
import { billingUser } from "./billingFixture";

const browser = new Window({ url: "http://margin-documents.test" });
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

const { createEmptyState, createMainConversation, createSideConversation } = await import("../../client/src/initialState");
const { getStateStorageKey } = await import("../../client/src/lib/appState");
const { getEditableDocument } = await import("../../client/src/lib/editableDocument");
const { buildConversationGraphScene } = await import("../../client/src/lib/conversationGraph");
const initial = createEmptyState();
const mainId = initial.rootId;
initial.conversations[mainId].title = "Main research";
initial.conversations[mainId].document = getEditableDocument(initial.conversations[mainId]);
initial.conversations[mainId].document!.blocks[0].content = "Original main document text.";
initial.conversations[mainId].notes = [{ id: "main-margin-note", kind: "comment", content: "Keep this beside the main document.",
  sourceMessageId: null, sourceBlockId: initial.conversations[mainId].document!.blocks[0].id,
  quote: "Original", startOffset: 0, endOffset: 8, createdAt: initial.conversations[mainId].createdAt, updatedAt: initial.conversations[mainId].updatedAt }];
const unrelated = createMainConversation({ id: "unrelated" });
unrelated.title = "Unrelated project";
unrelated.notes = [{ ...initial.conversations[mainId].notes[0], id: "unrelated-margin-note", content: "A different document's note.", sourceBlockId: undefined }];
initial.conversations[unrelated.id] = unrelated;
const side = createSideConversation({ id: "full-side", sourceConversation: initial.conversations[mainId] });
side.title = "Full side document";
initial.conversations[side.id] = side;
initial.conversations[mainId].childIds.push(side.id);
browser.localStorage.setItem(getStateStorageKey(billingUser.id), JSON.stringify(initial));
let latest: AppState = initial;
let publishVaultState: (state: AppState) => void;
const observedStates: AppState[] = [];
mock.module("../../client/src/lib/useMarkdownVault", () => ({
  useMarkdownVault(args: { state: AppState; setState: (state: AppState) => void }) {
    publishVaultState = args.setState;
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
const api = await import("../../client/src/lib/api");
let streamDelta: (delta: string) => void;
let finishStream: () => void;
mock.module("../../client/src/lib/api", () => ({ ...api,
  requestChatReply: ({ onDelta }: { onDelta: (delta: string) => void }) => {
    streamDelta = onDelta;
    return new Promise<void>((resolve) => { finishStream = resolve; });
  },
}));
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: WorkspaceApp } = await import("../../client/src/WorkspaceApp");
// The block editor and Map View are lazy chunks; load them first so views render without placeholders.
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
async function click(target: any) { assert(target, "Click target must exist"); await act(async () => target.click()); await settle(); }
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
function notePane(id: string): any { return element(`[data-document-id="${id}"]`); }
async function documentAction(id: string, label: string) {
  await click(notePane(id).querySelector('.document-header [aria-haspopup="menu"]'));
  const action = [...browser.document.querySelectorAll('[role="menuitem"]')].find((item) => item.textContent?.trim() === label);
  await click(action);
}
try {
  await act(async () => root.render(createElement(WorkspaceApp, props)));
  await settle();
  const noteId = 'main-margin-note';
  assert.deepEqual(panes(), [mainId, 'full-side']);
  assert.deepEqual(latest.conversations[mainId].notes, []);
  assert(latest.conversations[mainId].childIds.includes(noteId));
  assert.equal(pane(mainId).nextElementSibling.getAttribute('data-margin-notes-for'), mainId);
  assert(notePane(noteId).querySelector('.document-panel.is-compact-document .rich-document-editor'));
  assert(sidebar('Keep this beside the main document.'));
  assert(tab(noteId));
  assert.equal(notePane(noteId).querySelector('[aria-label="Document title"]'), null);
  assert.equal(notePane(noteId).querySelector('.document-margin-source'), null);
  assert.equal(notePane(noteId).querySelector('.document-child-tabs-trigger'), null);
  assert.equal(pane('full-side').querySelector('.document-child-tabs-trigger'), null);
  assert(notePane(noteId).querySelector('.document-margin-actions .document-presentation-toggle'));
  assert(notePane(noteId).querySelector('.document-margin-actions .document-menu-trigger'));
  checks.push('legacy notes become child documents in the sidebar, tabs and parent margin');

  const noteEditor = editor(noteId);
  await act(async () => {
    noteEditor.commands.setContent('<h2>Edited mini document</h2><ul><li>Full editor features</li></ul>');
  });
  await settle();
  const edited = structuredClone(latest.conversations[noteId].document!.blocks);
  assert(edited.some((block) => block.content.includes('Edited mini document')));
  assert(latest.conversations[noteId].branchAnchor?.sourceBlockId);
  await click(element('[aria-label="Close margin notes for Main research"]'));
  assert.equal(container.querySelector(`[data-document-id="${noteId}"]`), null);
  await click(tab(noteId));
  assert.equal(latest.activeConversationId, noteId);
  assert.deepEqual(latest.conversations[noteId].document!.blocks, edited);
  checks.push('full rich editing persists and direct document navigation reopens a closed note column');

  const resize = notePane(noteId).querySelector('.margin-document-resize');
  await act(async () => {
    resize.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'ArrowRight', bubbles: true }));
  });
  await settle();
  await act(async () => {
    resize.dispatchEvent(new browser.KeyboardEvent('keydown', { key: 'ArrowDown', bubbles: true, shiftKey: true }));
  });
  await settle();
  assert.deepEqual(latest.conversations[noteId].document!.marginNote!.size, { width: 300, height: 460 });
  assert.equal(notePane(noteId).style.width, '300px');
  assert.equal(notePane(noteId).style.height, '460px');
  assert.deepEqual(latest.conversations[noteId].document!.blocks, edited);
  checks.push('compact notes resize both dimensions and save their size without changing their content');

  await click(notePane(noteId).querySelector('.document-presentation-toggle'));
  assert(panes().includes(noteId));
  assert.equal(latest.conversations[noteId].document!.marginNote!.display, 'full');
  assert(!notePane(noteId).querySelector('.is-compact-document'));
  assert.deepEqual(latest.conversations[noteId].document!.blocks, edited);
  await click(notePane(noteId).querySelector('.document-presentation-toggle'));
  assert(!panes().includes(noteId));
  assert.equal(latest.conversations[noteId].document!.marginNote!.display, 'compact');
  assert.equal(notePane(noteId).style.width, '300px');
  assert.equal(notePane(noteId).style.height, '460px');
  assert.deepEqual(latest.conversations[noteId].document!.blocks, edited);
  checks.push('expansion and compact view preserve document identity, content and passage association');

  await click(tab(mainId));
  await act(async () => {
    editor(mainId).view.dom.focus();
    editor(mainId).commands.setTextSelection({ from: 10, to: 14 });
  });
  await settle();
  await click(element('[aria-label="Add a margin note"]'));
  const beforePassageIds = new Set(Object.keys(latest.conversations));
  await act(async () => {
    const input = element('input[aria-label="Margin note"]');
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, 'Thought about this passage');
    input.dispatchEvent(new browser.Event('input', { bubbles: true }));
  });
  await click(element('[aria-label="Save margin note"]'));
  const passageId = Object.keys(latest.conversations).find((id) => !beforePassageIds.has(id))!;
  assert(passageId);
  assert.equal(latest.conversations[passageId].parentId, mainId);
  assert.equal(latest.conversations[passageId].branchAnchor!.quote, 'main');
  assert.equal(latest.conversations[passageId].document!.marginNote!.display, 'compact');
  assert(notePane(passageId).querySelector('.rich-document-editor'));
  checks.push('a selected passage creates an editable mini document with a normal passage anchor');

  const previousIds = new Set(Object.keys(latest.conversations));
  await documentAction(noteId, 'New margin note');
  const nestedId = Object.keys(latest.conversations).find((id) => !previousIds.has(id))!;
  assert(nestedId);
  assert.equal(latest.conversations[nestedId].parentId, noteId);
  assert.equal(latest.conversations[nestedId].branchAnchor, null);
  assert(notePane(nestedId).closest(`[data-margin-notes-for="${noteId}"]`));
  await act(async () => editor(nestedId).commands.insertContent('Nested document content'));
  await settle();
  assert(latest.conversations[nestedId].document!.blocks.some((block) => block.content.includes('Nested document content')));
  checks.push('mini documents can create and edit their own unanchored margin documents');

  await click(notePane(nestedId).querySelector('.rich-document-grip'));
  await click(notePane(nestedId).querySelector('.rich-document-ask'));
  assert(notePane(nestedId).querySelector('[aria-label="Attach documents"]'));
  assert(notePane(nestedId).querySelector('[aria-label="Choose AI model"]'));
  await act(async () => {
    const prompt = notePane(nestedId).querySelector('[aria-label="AI prompt"]');
    Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value")!.set!.call(prompt, 'Continue this note');
    prompt.dispatchEvent(new browser.Event('input', { bubbles: true }));
  });
  await act(async () => notePane(nestedId).querySelector('.document-ai-composer').dispatchEvent(new browser.Event('submit', { bubbles: true, cancelable: true })));
  assert.equal(typeof streamDelta!, 'function');
  await act(async () => { streamDelta('AI response in the mini document.'); await new Promise((resolve) => setTimeout(resolve, 50)); });
  await act(async () => { finishStream(); await new Promise((resolve) => setTimeout(resolve, 50)); });
  await settle();
  assert(latest.conversations[nestedId].document!.blocks.some((block) => block.content.includes('AI response in the mini document.')));
  assert.equal(latest.conversations[nestedId].document!.marginNote!.display, 'compact');
  checks.push('mini documents expose attachment and model controls and receive ordinary inline AI generations');


  await click(tab(mainId));
  await documentAction(mainId, 'Pin document');
  assert(element(`[data-dock-document-id="${mainId}"]`).querySelector(`[data-document-id="${noteId}"]`));
  await click(element('[aria-label="Close margin notes for Main research"]'));
  await click(tab(nestedId));
  assert(notePane(nestedId));
  checks.push('pinned parents retain notes, and nested navigation restores the ancestor columns');

  const { buildSearchResults } = await import('../../client/src/lib/conversationSearch');
  const results = buildSearchResults(latest.conversations, 'Nested document content');
  assert(results.some((result: any) => result.conversationId === nestedId || result.id === nestedId));
  const scene = buildConversationGraphScene({ conversations: latest.conversations, mode: "overview", selectedConversationId: nestedId, groups: latest.groups });
  assert(JSON.stringify(scene).includes(nestedId));
  checks.push('margin documents participate in document search and the graph');
  const savedNote = structuredClone(latest.conversations[passageId]);
  await click(tab(passageId));
  await click(notePane(passageId).querySelector('.document-minimize-button'));
  assert(tab(passageId).getAttribute('aria-label').includes('minimized'));
  await click(tab(passageId));
  await click(notePane(passageId).querySelector('.document-close-button'));
  assert.equal(container.querySelector(`[data-document-tab-id="${passageId}"]`), null);
  assert.equal(container.querySelector(`[data-document-id="${passageId}"]`), null);
  assert.deepEqual(latest.conversations[passageId], savedNote);
  await click(sidebar(savedNote.title));
  assert(notePane(passageId));
  assert.deepEqual(latest.conversations[passageId], savedNote);
  checks.push('margin note header minimize and close preserve rich content and passage links for reopening');
  for (const action of ['Minimize all documents', 'Close all documents']) {
    await click(element('[aria-label="Document views"]'));
    await click([...browser.document.querySelectorAll('[role="menuitem"]')].find((node) => node.textContent?.trim() === action));
    assert.equal(container.querySelector('.margin-document'), null);
    assert.equal(container.querySelector('[data-dock-document-id]'), null);
    assert.deepEqual(latest.conversations[passageId], savedNote);
  }
  assert.equal(container.querySelector('[data-document-tab-id]'), null);
  await click(sidebar(savedNote.title));
  assert(notePane(passageId));
  assert.deepEqual(latest.conversations[passageId], savedNote);
  checks.push('bulk window actions include mini documents and pinned parents while preserving passage links');
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.abort();
}
