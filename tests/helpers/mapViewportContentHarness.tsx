import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { Conversation } from "../../client/src/types";

const browser = new Window({ url: "http://map-viewport-content.test/" });
for (const name of ["window", "document", "navigator", "localStorage", "sessionStorage", "HTMLElement", "Element", "Node", "Text", "Document", "DocumentFragment", "MutationObserver", "ResizeObserver", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "Range", "DOMRect", "DOMParser", "getComputedStyle", "HTMLInputElement", "HTMLTextAreaElement", "ShadowRoot"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value: name === "getComputedStyle" ? value.bind(browser) : value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const canvas = { width: 1000, height: 700 };
Object.defineProperties(browser.HTMLElement.prototype, {
  clientWidth: { configurable: true, get() { return this.classList.contains("conversation-graph-viewport") ? canvas.width : 400; } },
  clientHeight: { configurable: true, get() { return this.classList.contains("conversation-graph-viewport") ? canvas.height : 260; } },
});
const originalRect = browser.HTMLElement.prototype.getBoundingClientRect;
browser.HTMLElement.prototype.getBoundingClientRect = function () {
  return this.classList.contains("conversation-graph-viewport")
    ? new browser.DOMRect(0, 0, canvas.width, canvas.height) : originalRect.call(this);
};
let frameId = 0;
let frameTime = 0;
const frames = new Map<number, FrameRequestCallback>();
browser.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
browser.cancelAnimationFrame = (id) => { frames.delete(id); };
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: browser.requestAnimationFrame.bind(browser) });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: browser.cancelAnimationFrame.bind(browser) });

const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: ConversationGraphView } = await import("../../client/src/components/ConversationGraphView");
const { default: DocumentPanel } = await import("../../client/src/components/DocumentPanel");
const { createMainConversation } = await import("../../client/src/initialState");
const { createDefaultGraphNodeLayout } = await import("../../client/src/lib/graphLayout");
const { getEditableDocument } = await import("../../client/src/lib/editableDocument");
const { defaultGraphLocation } = await import("../../client/src/lib/useGraphExplorationNavigation");

const createdAt = "2026-09-25T00:00:00.000Z";
const conversations = Object.fromEntries(Array.from({ length: 12 }, (_, index) => {
  const conversation = createMainConversation({ id: `viewport-document-${index}`, createdAt });
  conversation.title = `Viewport document ${index + 1}`;
  conversation.messages = [{ id: `answer-${index}`, role: "assistant", content: `## Research ${index + 1}\n\n` + "An editable finding with **supporting evidence**. ".repeat(20), createdAt }];
  conversation.document = getEditableDocument(conversation);
  return [conversation.id, conversation];
}));
const layouts = Object.fromEntries(Object.keys(conversations).map((id, index) => [id,
  createDefaultGraphNodeLayout({ x: index % 6 * 280, y: 80 + Math.floor(index / 6) * 320, positioned: true }),
]));
const workspaceKey = "viewport-content";
browser.sessionStorage.setItem(`margin-graph-location:${workspaceKey}`, JSON.stringify({
  ...defaultGraphLocation(), overviewPresentation: "canvas", viewport: { x: 0, y: 0, scale: 2.4 },
}));
const readerCalls = new Map<string, number>();
let latest = conversations;
const checks: string[] = [];
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);

function Host({ visible = true }: { visible?: boolean }) {
  const [documents, setDocuments] = useState(conversations);
  latest = documents;
  const reader = (id: string) => {
    readerCalls.set(id, (readerCalls.get(id) ?? 0) + 1);
    return createElement(DocumentPanel, {
      conversation: documents[id], isActive: true, isSubmitting: false, aiControls: null,
      recentModelSelections: [], anchors: [], theme: "light",
      onChange(document) { setDocuments((current) => ({ ...current, [id]: { ...current[id], document } })); },
      onRename(title) { setDocuments((current) => ({ ...current, [id]: { ...current[id], title } })); },
      onSubmit() {}, onStop() {}, onSelection() {}, onClearSelection() {},
      onOpenBranch() {}, onOpenNote() {}, onModelChange() {}, onUpload() {}, onRemoveAttachment() {},
      onAcceptVersion() {}, onUndoInsertion() {}, registerPanelRef() {}, registerAnchorRef() {}, registerBranchOriginRef() {},
    });
  };
  return createElement(ConversationGraphView, {
    workspaceKey, isVisible: visible, activeConversationId: "viewport-document-0",
    conversations: documents, graphLayouts: layouts, groups: {},
    onActivateConversation() {}, onAssignGroup() {}, onCreateChildConversation: () => null,
    onOpenConversation() {}, onToggleGroup() {}, onUpdateGraphNodeLayouts() {},
    renderExpandedConversation: reader,
  });
}

function element(selector: string): any {
  const found = container.querySelector(selector);
  assert(found, `Missing ${selector}`);
  return found;
}
function card(index: number): any { return element(`[data-conversation-id="viewport-document-${index}"]`); }
function editor(index: number): any { return card(index).querySelector(`[data-document-block-id="message:answer-${index}"] .tiptap`)?.editor; }
function camera() {
  const transform = element(".conversation-graph-stage").style.transform;
  const match = transform.match(/translate\(([-.\d]+)px, ([-.\d]+)px\) scale\(([-.\d]+)\)/);
  assert(match, `Expected finite map camera: ${transform}`);
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
}
function intersectsViewport(node: HTMLElement) {
  const view = camera();
  const width = parseFloat(node.style.width), height = parseFloat(node.style.height);
  const factor = Number(node.style.transform.match(/scale\(([-.\de]+)\)/)?.[1] ?? 1);
  const centerX = (parseFloat(node.style.left) + width / 2) * view.scale + view.x;
  const centerY = (parseFloat(node.style.top) + height / 2) * view.scale + view.y;
  return centerX + width * factor * view.scale / 2 > 0 && centerX - width * factor * view.scale / 2 < canvas.width
    && centerY + height * factor * view.scale / 2 > 0 && centerY - height * factor * view.scale / 2 < canvas.height;
}
async function nextFrame() {
  const callbacks = [...frames.values()];
  frames.clear();
  frameTime += 16;
  await act(async () => { callbacks.forEach((callback) => callback(frameTime)); });
}
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  for (let iteration = 0; frames.size && iteration < 40; iteration++) await nextFrame();
  assert.equal(frames.size, 0, "Content loading stops scheduling frames once the visible work is complete");
}
async function wheel(deltaX: number, deltaY = 0, ctrlKey = false, clientX = 500, clientY = 300) {
  const event = new browser.WheelEvent("wheel", { deltaX, deltaY, bubbles: true, cancelable: true });
  Object.defineProperties(event, {
    ctrlKey: { value: ctrlKey }, clientX: { value: clientX }, clientY: { value: clientY },
  });
  await act(async () => element(".conversation-graph-viewport").dispatchEvent(event));
}
function assertOnlyViewportBodies() {
  for (const node of container.querySelectorAll<HTMLElement>(".conversation-graph-node")) {
    if (node.querySelector(".conversation-graph-node-reader, .conversation-graph-node-preview")) {
      assert(intersectsViewport(node), `${node.dataset.conversationId} must intersect the viewport before mounting content`);
    } else if (node.dataset.graphDetail !== "compact") {
      assert(node.querySelector(".graph-node-content-skeleton"), "Unloaded document shells show a placeholder");
    }
  }
}

try {
  await act(async () => root.render(createElement(Host)));
  assert.equal(container.querySelectorAll(".document-panel").length, 0, "The initial camera can paint shells before mounting document editors");
  assert(card(0).querySelector(".graph-node-content-skeleton"));
  await nextFrame();
  assert.equal(readerCalls.size, 0, "The first paint is reserved for the map and its skeletons");
  for (let iteration = 0; frames.size && iteration < 40; iteration++) {
    const previousBodies = readerCalls.size;
    await nextFrame();
    assert(readerCalls.size - previousBodies <= 1, "A frame admits at most one new expensive document body");
  }
  await settle();
  assert(editor(0) && editor(1), "Both intersecting documents load their real editable content");
  assert(!intersectsViewport(card(2)), "The fixture includes a shell in overscan outside the actual viewport");
  assert(card(2).querySelector(".graph-node-content-skeleton"));
  assert.equal(readerCalls.get("viewport-document-2"), undefined, "Overscan never eagerly creates a document body");
  assertOnlyViewportBodies();
  assert(container.querySelectorAll(".document-panel").length < Object.keys(conversations).length);
  checks.push("initial content loads only in the actual viewport while overscan retains skeleton shells");

  const editable = editor(1);
  await act(async () => {
    editable.commands.setTextSelection(editable.state.doc.content.size - 1);
    editable.commands.insertContent(" Saved in the viewport.");
  });
  await settle();
  assert(latest["viewport-document-1"].document!.blocks.some((block) => block.content.includes("Saved in the viewport.")));
  const callsAfterEditing = readerCalls.get("viewport-document-1");
  await wheel(15);
  await settle();
  await wheel(0, -5, true, 800, 300);
  await settle();
  assert.strictEqual(editor(1), editable, "Camera gestures preserve the live editor instance");
  assert.equal(readerCalls.get("viewport-document-1"), callsAfterEditing, "Camera changes do not rebuild unchanged reader content");
  assert(editor(1).getMarkdown().includes("Saved in the viewport."));
  checks.push("panning and zooming preserve an existing editor and skip expensive reader rendering");

  await wheel(600);
  assert(intersectsViewport(card(2)));
  assert(card(2).querySelector(".graph-node-content-skeleton"), "An incoming document paints a skeleton before loading");
  assert.equal(readerCalls.get("viewport-document-2"), undefined);
  await wheel(-600);
  await settle();
  assert.equal(readerCalls.get("viewport-document-2"), undefined, "Work queued for a document that leaves before loading is discarded");
  checks.push("rapid camera reversal cancels obsolete queued document work");

  await wheel(600);
  assert(card(2).querySelector(".graph-node-content-skeleton"));
  await nextFrame();
  assert.equal(readerCalls.get("viewport-document-2"), undefined, "New content waits while the camera has just moved");
  await settle();
  assert(editor(2)?.isEditable, "Incoming skeletons resolve to the document editor once the camera settles");
  assert.equal(card(2).dataset.graphContent, "ready");
  assert(!card(2).querySelector(".graph-node-content-skeleton"));
  assert(!container.querySelector('[data-conversation-id="viewport-document-0"] .document-panel'), "Leaving the viewport unloads the expensive body");
  assert.strictEqual(editor(1), editable, "An editor that remained visible survives other document loads");
  assertOnlyViewportBodies();
  checks.push("incoming content loads after skeletons paint and outgoing content unloads");

  await wheel(600);
  assert(card(3).querySelector(".graph-node-content-skeleton"));
  await act(async () => root.render(createElement(Host, { visible: false })));
  const hiddenCalls = new Map(readerCalls);
  await settle();
  assert.deepEqual(readerCalls, hiddenCalls, "Hidden maps never consume pending document work");
  assert.equal(readerCalls.get("viewport-document-3"), undefined);
  await act(async () => root.render(createElement(Host, { visible: true })));
  await settle();
  assert(editor(3), "Visible work resumes when the map becomes active again");
  assertOnlyViewportBodies();
  checks.push("hidden maps cancel pending work and resume only current visible documents");

  await wheel(-1200);
  await settle();
  assert(editor(1).getMarkdown().includes("Saved in the viewport."), "Committed content survives leaving the viewport and returning");
  assertOnlyViewportBodies();
  checks.push("document edits survive viewport unloading and reloading");

  await wheel(0, -Math.log(1.5 / camera().scale) / 0.008, true, 500, 300);
  for (let step = 0; camera().scale > 1.500001 && step < 20; step++) {
    await wheel(0, -Math.log(1.5 / camera().scale) / 0.008, true, 500, 300);
  }
  assert(Math.abs(camera().scale - 1.5) < 0.000001, "The camera reaches preview detail");
  await settle();
  assert(container.querySelector(".conversation-graph-node-preview"), "Preview-level cards also hydrate visible content");
  assert.equal(container.querySelectorAll(".document-panel").length, 0, "Zooming out removes full editors");
  assertOnlyViewportBodies();
  checks.push("preview detail uses the same viewport boundary as full document editors");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
