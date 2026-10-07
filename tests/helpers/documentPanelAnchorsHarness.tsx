import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://document-panel-anchors.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Text", "Document", "DocumentFragment", "MutationObserver", "ResizeObserver", "Event", "MouseEvent", "KeyboardEvent", "Range", "DOMRect", "DOMParser", "getComputedStyle", "HTMLInputElement", "HTMLTextAreaElement", "ShadowRoot"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value: name === "getComputedStyle" ? value.bind(browser) : value });
}
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: clearTimeout });
const observers: { callback: IntersectionObserverCallback; targets: Element[]; disconnected: boolean }[] = [];
Object.defineProperty(globalThis, "IntersectionObserver", { configurable: true, value: class {
  record: (typeof observers)[number];
  constructor(callback: IntersectionObserverCallback) { this.record = { callback, targets: [], disconnected: false }; observers.push(this.record); }
  observe(target: Element) { this.record.targets.push(target); }
  disconnect() { this.record.disconnected = true; }
} });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: DocumentPanel } = await import("../../client/src/components/DocumentPanel");
await import("../../client/src/components/RichDocumentEditor");
const { createMainConversation } = await import("../../client/src/initialState");
const { getEditableDocument } = await import("../../client/src/lib/editableDocument");

const date = "2026-10-01T00:00:00.000Z";
const conversation = createMainConversation({ id: "offscreen-document", createdAt: date });
conversation.messages = [{ id: "answer", role: "assistant", content: "An offscreen paragraph.", createdAt: date }];
conversation.document = getEditableDocument(conversation);
const checks: string[] = [];
const registered: Record<string, number> = {};
const blockId = conversation.document.blocks[0].id;
// A branch highlight over "offscreen"; its decorated span only exists once the block editor has mounted.
const anchors = [{ branchConversationId: "branch-1", anchor: { sourceMessageId: null, sourceBlockId: blockId, startOffset: 3, endOffset: 12, quote: "offscreen" } }];
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const noop = () => {};
function render(isActive: boolean) {
  return createElement(DocumentPanel, {
    conversation, isActive, isSubmitting: false, aiControls: null, recentModelSelections: [], anchors, theme: "light",
    onChange: noop, onRename: noop, onSubmit: noop, onStop: noop, onSelection: noop, onOpenBranch: noop, onOpenNote: noop,
    onModelChange: noop, onUpload: noop, onRemoveAttachment: noop, onAcceptVersion: noop, onUndoInsertion: noop,
    registerPanelRef: noop, registerAnchorRef: (id: string, element: unknown) => { if (element) registered[id] = (registered[id] ?? 0) + 1; else delete registered[id]; }, registerBranchOriginRef: noop,
  });
}

const settle = () => act(async () => { await new Promise((resolve) => setTimeout(resolve, 100)); });
try {
  // The block editor is a lazy chunk, so it mounts after the panel's first effects have run.
  await act(async () => root.render(render(true)));
  await settle();
  assert(container.querySelector(".rich-document-editor [data-annotation-branches]"), "The highlight is decorated once the editor mounts.");
  assert.equal(registered["branch-1"], 1, "An active document registers its branch anchor after its lazy editor mounts.");
  checks.push("active panel registers anchors");

  await act(async () => root.render(createElement("div")));
  for (const key of Object.keys(registered)) delete registered[key];
  await act(async () => root.render(render(false)));
  assert.equal(container.querySelector(".rich-document-editor"), null, "An offscreen document defers its editor.");
  assert.equal(registered["branch-1"], undefined);
  await act(async () => observers.at(-1)!.callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
  await settle();
  assert(container.querySelector(".rich-document-editor [data-annotation-branches]"), "Scrolling near the document decorates its highlight.");
  assert.equal(registered["branch-1"], 1, "A document that mounts its editor later registers its branch anchor.");
  checks.push("deferred panel registers anchors");

  await act(async () => root.render(createElement("div")));
  assert.equal(registered["branch-1"], undefined, "Unmounting releases the anchor.");
  checks.push("unmount releases anchors");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
