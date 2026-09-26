import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { Conversation } from "../../client/src/types";

const browser = new Window({ url: "http://map-document-zoom.test/" });
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

const createdAt = "2026-09-25T00:00:00.000Z";
const initial = createMainConversation({ id: "map-document", createdAt });
initial.title = "Research in the map";
initial.messages = [{ id: "answer", role: "assistant", content: "An editable research finding.\n\nRead the evidence and refine this document in place.", createdAt }];
initial.document = getEditableDocument(initial);
const layouts = { [initial.id]: createDefaultGraphNodeLayout({ x: 2500, y: -1600, positioned: true }) };
const originalLayouts = structuredClone(layouts);
const companions = Object.fromEntries(Array.from({ length: 7 }, (_, index) => {
  const conversation = createMainConversation({ id: `related-${index}`, createdAt });
  conversation.title = `Related research ${index + 1}`;
  conversation.messages = [{ id: `related-answer-${index}`, role: "assistant", content: "A related source.", createdAt }];
  return [conversation.id, conversation];
}));
const groupedLayouts = { ...layouts, ...Object.fromEntries(Object.keys(companions).map((id, index) => [id,
  createDefaultGraphNodeLayout({ x: 2500 + index % 2 * 30, y: index === 6 ? 18000 : -1600 + index * 30, positioned: true })])) };
const grouped = { research: { id: "research", name: "Research collection", color: "#4fbf9f", collapsed: false,
  conversationIds: [initial.id, ...Object.keys(companions)] } };
let latest: Conversation = initial;
let edits = 0;
let layoutWrites = 0;
const checks: string[] = [];
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);

function Host({ workspaceKey = "map-document-zoom", withGroup = false }: { workspaceKey?: string; withGroup?: boolean }) {
  const [conversations, setConversations] = useState<Record<string, Conversation>>(() => ({
    ...(withGroup ? companions : {}), [initial.id]: initial,
  }));
  latest = conversations[initial.id];
  const reader = (id: string) => createElement(DocumentPanel, {
    conversation: conversations[id], isActive: true, isSubmitting: false, aiControls: null,
    recentModelSelections: [], anchors: [], theme: "light",
    onChange(document) { edits++; setConversations((current) => ({ ...current, [id]: { ...current[id], document } })); },
    onRename(title) { setConversations((current) => ({ ...current, [id]: { ...current[id], title } })); },
    onSubmit() {}, onStop() {}, onSelection() {}, onClearSelection() {},
    onOpenBranch() {}, onOpenNote() {}, onModelChange() {}, onUpload() {}, onRemoveAttachment() {},
    onAcceptVersion() {}, onUndoInsertion() {}, registerPanelRef() {}, registerAnchorRef() {}, registerBranchOriginRef() {},
  });
  return createElement(ConversationGraphView, {
    workspaceKey, activeConversationId: initial.id,
    conversations, graphLayouts: withGroup ? groupedLayouts : layouts, groups: withGroup ? grouped : {},
    onActivateConversation() {}, onAssignGroup() {}, onCreateChildConversation: () => null,
    onOpenConversation() {}, onToggleGroup() {}, onUpdateGraphNodeLayouts() { layoutWrites++; },
    renderExpandedConversation: reader, renderDockedConversation: reader,
  });
}

function element(selector: string): any {
  const found = container.querySelector(selector);
  assert(found, `Missing ${selector}`);
  return found;
}
function camera() {
  const transform = element(".conversation-graph-stage").style.transform;
  const match = transform.match(/translate\(([-.\d]+)px, ([-.\d]+)px\) scale\(([-.\d]+)\)/);
  assert(match, `Expected finite map camera: ${transform}`);
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
}
function card(): HTMLElement { return element(`[data-conversation-id="${initial.id}"]`); }
function cardBounds() {
  const node = card();
  const width = parseFloat(node.style.width), height = parseFloat(node.style.height);
  const scale = Number(node.style.transform.match(/scale\(([-.\de]+)\)/)?.[1] ?? 1);
  const view = camera();
  return {
    worldX: parseFloat(node.style.left) + width / 2,
    worldY: parseFloat(node.style.top) + height / 2,
    width: width * scale * view.scale,
    height: height * scale * view.scale,
  };
}
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); });
  for (let iteration = 0; frames.size && iteration < 30; iteration++) {
    const callbacks = [...frames.values()];
    frames.clear();
    await act(async () => { callbacks.forEach((callback) => callback(0)); });
  }
  assert.equal(frames.size, 0, "The map and document settle without an animation loop");
}
async function click(target: any) { await act(async () => target.click()); await settle(); }
async function wheel(target: any, deltaY: number, ctrlKey = false) {
  const bounds = cardBounds(), view = camera();
  const event = new browser.WheelEvent("wheel", {
    deltaY, bubbles: true, cancelable: true,
  });
  // Happy DOM does not initialize WheelEvent's inherited mouse properties.
  Object.defineProperties(event, {
    ctrlKey: { value: ctrlKey }, clientX: { value: bounds.worldX * view.scale + view.x },
    clientY: { value: bounds.worldY * view.scale + view.y },
  });
  await act(async () => target.dispatchEvent(event));
  await settle();
  return event;
}
async function zoomTo(scale: number) {
  for (let iteration = 0; Math.abs(camera().scale - scale) > 0.000001 && iteration < 30; iteration++) {
    const delta = -Math.log(scale / camera().scale) / 0.008;
    await wheel(element(".conversation-graph-viewport"), delta, true);
  }
  assert(Math.abs(camera().scale - scale) < 0.000001, `Requested zoom ${scale} is reachable`);
}
function editor(): any { return element('[data-document-block-id="message:answer"] .tiptap').editor; }
function assertNoDock() { assert.equal(container.querySelector(".conversation-graph-dock"), null, "Reading remains in the document node"); }
function assertCentered() {
  const bounds = cardBounds(), view = camera();
  assert(Math.abs(bounds.worldX * view.scale + view.x - canvas.width / 2) < 1, "Expand centers the document horizontally");
  assert(Math.abs(bounds.worldY * view.scale + view.y - canvas.height / 2) < 40, "Expand centers the document vertically within the canvas controls");
}
async function freshMap(workspaceKey: string, withGroup = false) {
  await act(async () => root.render(createElement(Host, { key: workspaceKey, workspaceKey, withGroup })));
  await settle();
}

try {
  await act(async () => root.render(createElement(Host)));
  await settle();
  await click([...container.querySelectorAll("button")].find((button) => button.textContent.trim() === "Documents and connections"));
  assert.equal(element(".conversation-graph").dataset.mapPresentation, "documents");
  assert(camera().scale <= 1, "Fit starts with compact document cards");
  assert.equal(card().querySelector(".conversation-graph-node-preview, .conversation-graph-node-reader"), null);
  assert.equal(element(".conversation-graph").dataset.hasSelection, "false");
  const compact = cardBounds();
  checks.push("fit shows compact documents without requiring selection");

  await zoomTo(1.5);
  assert(element(".conversation-graph-node-preview").textContent.includes("An editable research finding."));
  assert.equal(card().querySelector(".conversation-graph-node-reader"), null);
  assert(cardBounds().width > compact.width && cardBounds().height > compact.height);
  assert.equal(element(".conversation-graph").dataset.hasSelection, "false", "Zoom reveals text without clicking a document");
  checks.push("pinch zoom grows the card and automatically reveals a text preview");

  await zoomTo(2.4);
  assert(element(".conversation-graph-node-reader .document-panel"));
  assert(editor().isEditable, "The embedded real document editor is editable");
  assert.equal(element(".conversation-graph").dataset.hasSelection, "false");
  assertNoDock();
  const beforeEdit = camera();
  await act(async () => {
    const value = editor();
    value.commands.setTextSelection(value.state.doc.content.size - 1);
    value.commands.insertContent(" Refined while reading the map.");
  });
  await settle();
  assert(edits > 0);
  assert(latest.document!.blocks.find((block) => block.id === "message:answer")!.content.includes("Refined while reading the map."));
  assert.equal(latest.messages[0].content, initial.messages[0].content, "Editing leaves original generation history intact");
  assert.deepEqual(camera(), beforeEdit, "Saving an edit does not reset the reading camera");
  checks.push("zoom mounts the real editor and saves edits without leaving the map");

  const body = element(".conversation-graph-node-reader .document-body");
  Object.defineProperties(body, {
    clientHeight: { configurable: true, value: 260 },
    scrollHeight: { configurable: true, value: 1000 },
  });
  for (const [scrollTop, deltaY] of [[0, -80], [200, 80], [740, 80]]) {
    body.scrollTop = scrollTop;
    const before = camera();
    const event = await wheel(body, deltaY);
    assert.deepEqual(camera(), before, `Vertical reading gestures preserve the map at scroll position ${scrollTop}`);
    assert.equal(event.defaultPrevented, false, "The document retains native wheel scrolling");
  }
  for (const target of [element('[data-document-block-id="message:answer"] .tiptap'), element('[aria-label="Document title"]')]) {
    const before = camera();
    await act(async () => target.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true })));
    await settle();
    assert.deepEqual(camera(), before, "Caret movement inside document controls never pans the map");
  }
  const beforePinch = camera();
  await wheel(body, -20, true);
  assert(camera().scale > beforePinch.scale, "Pinching over document content still zooms the map");
  checks.push("reading wheel gestures and editor arrows preserve the map while pinch still zooms");

  await zoomTo(0.8);
  assert.equal(card().querySelector(".conversation-graph-node-reader"), null);
  await zoomTo(2.4);
  assert(editor().getMarkdown().includes("Refined while reading the map."), "Saved edits survive unmounting and remounting at zoom thresholds");
  assertNoDock();
  checks.push("edits survive zooming out to compact cards and back into the document");

  await zoomTo(0.8);
  await click(element(`[aria-label="Expand ${initial.title}"]`));
  assert(element(".conversation-graph-node-reader .document-panel"));
  assert(cardBounds().width >= 360 && cardBounds().height >= 190, "Expand zooms the packed card to a readable size");
  assertCentered();
  assertNoDock();
  checks.push("Expand zooms and centers an inline editor without opening a split view");

  await zoomTo(5);
  assert(editor().getMarkdown().includes("Refined while reading the map."));
  assert.equal(layoutWrites, 0, "Reading gestures never persist new authored graph positions");
  assert.deepEqual(layouts, originalLayouts);
  assert(Math.abs(cardBounds().worldX - compact.worldX) < 0.000001 && Math.abs(cardBounds().worldY - compact.worldY) < 0.000001,
    "Progressive details preserve the document's packed world center");
  checks.push("large reading zoom remains available without moving authored document positions");

  await click(element(`[aria-label="Dock ${initial.title} in split view"]`));
  assert(element(".conversation-graph-dock .document-panel"));
  assert.equal(card().querySelector(".conversation-graph-node-reader"), null);
  assert.equal(container.querySelectorAll(".document-panel").length, 1, "A docked document has only one live editor");
  await zoomTo(5.5);
  assert.equal(container.querySelectorAll(".document-panel").length, 1, "Further zoom never duplicates the docked editor");
  await click(element(`[aria-label="Close ${initial.title} split view"]`));
  assert(card().querySelector(".document-panel"), "Closing the dock reveals the inline reader again");
  assert.equal(container.querySelectorAll(".document-panel").length, 1);
  checks.push("a docked document never also mounts an inline editor at high zoom");

  await freshMap("sparse-default-map-zoom");
  assert.equal(element(".conversation-graph").dataset.mapPresentation, "map");
  await click(element(`[aria-label="Preview ${initial.title}"]`));
  assert(card().querySelector(".conversation-graph-node-preview"), "Selecting a sparse default-map document opens its existing preview");
  assertNoDock();
  await zoomTo(2.4);
  assert(card().querySelector(".conversation-graph-node-reader .document-panel"), "A selected default-map preview becomes an inline editor on zoom");
  assert(editor().isEditable);
  assertNoDock();
  checks.push("sparse default-map previews also become editable readers while zooming");

  await freshMap("grouped-overview-map-zoom", true);
  for (let step = 0; !container.querySelector(`[data-conversation-id="${initial.id}"]`) && step < 15; step++) {
    await click(element('[aria-label="Zoom in"]'));
  }
  assert(card(), "The grouped overview reveals its document cards");
  await click(element(`[aria-label="Expand ${initial.title}"]`));
  assert(card().querySelector(".conversation-graph-node-reader .document-panel"));
  assertCentered();
  assertNoDock();
  checks.push("grouped overview Expand centers the document after its zoom-dependent layout changes");

  await freshMap("focused-dense-map-zoom", true);
  await click(element('[aria-label="Explore Research collection, 8 chats and notes"]'));
  assert.equal(element(".conversation-graph-stage").dataset.groupLayout, "spaced", "The dense group uses its temporary packed layout");
  assert.equal(element(".conversation-graph").dataset.hasSelection, "false");
  const fittedScale = camera().scale;
  const fittedCard = cardBounds();
  await zoomTo(Math.min(5.5, fittedScale * Math.max(400 / fittedCard.width, 240 / fittedCard.height)));
  assert(card().querySelector(".conversation-graph-node-reader .document-panel"), "Zooming a dense group's card reveals the real editor");
  assert.equal(element(".conversation-graph").dataset.hasSelection, "false");
  assertNoDock();
  assert.equal(layoutWrites, 0);
  checks.push("focused dense-group cards reveal inline editors without selection or layout writes");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
