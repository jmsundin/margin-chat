import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://document-panel-deferral.test" });
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
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const noop = () => {};
function render(isActive: boolean) {
  return createElement(DocumentPanel, {
    conversation, isActive, isSubmitting: false, aiControls: null, recentModelSelections: [], anchors: [], theme: "light",
    onChange: noop, onRename: noop, onSubmit: noop, onStop: noop, onSelection: noop, onOpenBranch: noop, onOpenNote: noop,
    onModelChange: noop, onUpload: noop, onRemoveAttachment: noop, onAcceptVersion: noop, onUndoInsertion: noop,
    registerPanelRef: noop, registerAnchorRef: noop, registerBranchOriginRef: noop,
  });
}

try {
  await act(async () => root.render(render(false)));
  assert.equal(container.querySelector(".rich-document-editor"), null, "An inactive offscreen document waits to mount its editor.");
  assert.match(container.querySelector(".rich-document-editor-loading")?.textContent ?? "", /An offscreen paragraph\./, "Its text stays readable meanwhile.");
  assert.equal(observers.length, 1);
  assert.equal(observers[0].targets[0], container.querySelector(".document-body"));
  checks.push("offscreen placeholder");

  await act(async () => observers[0].callback([{ isIntersecting: true } as IntersectionObserverEntry], {} as IntersectionObserver));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  assert(container.querySelector(".rich-document-editor .tiptap"), "Scrolling near the document mounts its editor.");
  assert.equal(container.querySelector(".rich-document-editor-loading"), null);
  assert(observers[0].disconnected, "The observer stops once the editor is mounted.");
  checks.push("mounts when near");

  await act(async () => root.render(createElement("div")));
  await act(async () => root.render(render(true)));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  assert(container.querySelector(".rich-document-editor .tiptap"), "The active document mounts its editor immediately.");
  assert.equal(observers.length, 1, "No observer is needed for the active document.");
  checks.push("active mounts immediately");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
