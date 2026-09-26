import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { GraphEvidenceRef } from "../../client/src/lib/graphExploration";

const browser = new Window({ url: "http://graph-view-modes.test/" });
for (const name of ["window", "document", "navigator", "localStorage", "sessionStorage", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "ResizeObserver", "DOMRect", "HTMLInputElement", "HTMLSelectElement"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperties(browser.HTMLElement.prototype, {
  clientWidth: { configurable: true, get: () => 1000 },
  clientHeight: { configurable: true, get: () => 700 },
  setPointerCapture: { configurable: true, value() {} },
  releasePointerCapture: { configurable: true, value() {} },
  hasPointerCapture: { configurable: true, value: () => false },
});
browser.HTMLElement.prototype.getBoundingClientRect = function () { return new browser.DOMRect(0, 0, 1000, 700); };
let frameId = 0;
const frames = new Map<number, FrameRequestCallback>();
browser.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
browser.cancelAnimationFrame = (id) => { frames.delete(id); };

const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: ConversationGraphView } = await import("../../client/src/components/ConversationGraphView");
const { createMainConversation, createChildConversation } = await import("../../client/src/initialState");
const { createDefaultGraphNodeLayout } = await import("../../client/src/lib/graphLayout");
const { defaultGraphLocation } = await import("../../client/src/lib/useGraphExplorationNavigation");
const { writeGraphConcepts } = await import("../../client/src/lib/graphExploration");

const createdAt = "2026-09-25T00:00:00.000Z";
const rootDocument = createMainConversation({ id: "root", createdAt });
rootDocument.title = "Original research";
rootDocument.messages = [{ id: "root-answer", role: "assistant", content: "An evidence passage for research.", createdAt }];
const child = createChildConversation({ id: "child", parentConversation: rootDocument, createdAt });
child.title = "Branch research";
child.messages = [{ id: "child-answer", role: "assistant", content: "More evidence in a branch.", createdAt }];
child.branchAnchor = { id: "branch-anchor", sourceConversationId: "root", sourceMessageId: "root-answer", startOffset: 3,
  endOffset: 19, quote: "evidence passage", prompt: "Explore this source", createdAt };
rootDocument.childIds = [child.id];
const side = createMainConversation({ id: "side", createdAt });
side.title = "Linked comparison";
side.messages = [{ id: "side-answer", role: "assistant", content: "Contrasting evidence for comparison.", createdAt }];
const isolated = createMainConversation({ id: "isolated", createdAt });
isolated.title = "Independent note";
isolated.messages = [{ id: "isolated-answer", role: "assistant", content: "Other evidence from an independent source.", createdAt }];
rootDocument.linkedConversationIds = [side.id];
const conversations = { root: rootDocument, child, side, isolated };
const layouts = {
  root: createDefaultGraphNodeLayout({ x: -400, y: -200, positioned: true }),
  child: createDefaultGraphNodeLayout({ x: 350, y: -200, positioned: true }),
  side: createDefaultGraphNodeLayout({ x: 0, y: 450, positioned: true }),
  isolated: createDefaultGraphNodeLayout({ x: 750, y: 450, positioned: true }),
};
const originalLayouts = structuredClone(layouts);
const groups = {
  research: { id: "research", name: "Research", color: "#4fbf9f", collapsed: false, conversationIds: ["root", "child"] },
  notes: { id: "notes", name: "Notes", color: "#6f88ff", collapsed: false, conversationIds: ["side", "isolated"] },
};
const source: GraphEvidenceRef = { conversationId: "root", sourceKind: "message", messageId: "root-answer", quote: "evidence passage", startOffset: 3, endOffset: 19 };
const container = browser.document.createElement("div");
browser.document.body.append(container);
const reactRoot = createRoot(container as unknown as Element);
let workspaceKey = "";
let layoutWrites = 0;
let focusRequest: { conversationId: string; requestId: number; openReader?: boolean } | null = null;
const checks: string[] = [];

function Reader({ id }: { id: string }) {
  return createElement("article", { className: "chat-panel", "data-reader-id": id },
    createElement("div", { className: "panel-body", tabIndex: 0 }, conversations[id as keyof typeof conversations].messages[0].content));
}
function Host() {
  return createElement(ConversationGraphView, {
    key: workspaceKey, workspaceKey, activeConversationId: "root", conversations, graphLayouts: layouts, groups, focusRequest,
    onFocusRequestHandled(requestId) { if (focusRequest?.requestId === requestId) focusRequest = null; },
    onActivateConversation() {}, onAssignGroup() {}, onCreateChildConversation: () => null,
    onOpenConversation() {}, onToggleGroup() {}, onUpdateGraphNodeLayouts() { layoutWrites++; },
    renderExpandedConversation: (id) => createElement(Reader, { id }),
    renderDockedConversation: (id) => createElement(Reader, { id }),
  });
}
function element(selector: string): any {
  const found = container.querySelector(selector);
  assert(found, `Missing ${selector}`);
  return found;
}
function button(label: string): any {
  const found = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent.trim() === label);
  assert(found, `Missing button ${label}`);
  return found;
}
function state() { return JSON.parse(browser.sessionStorage.getItem(`margin-graph-location:${workspaceKey}`)!).present; }
function mode() { return element("section[data-view-mode]").dataset.viewMode; }
function positions() {
  return Object.fromEntries([...container.querySelectorAll<HTMLElement>("[data-conversation-id]")].map((node) => [node.dataset.conversationId,
    { x: Number.parseFloat(node.style.left), y: Number.parseFloat(node.style.top), width: Number.parseFloat(node.style.width), height: Number.parseFloat(node.style.height) }]));
}
function assertUnmoved(before: ReturnType<typeof positions>, ignoredIds: string[] = []) {
  const after = positions();
  for (const [id, position] of Object.entries(before)) {
    if (ignoredIds.includes(id)) continue;
    assert(after[id], `Unmodified network node ${id} remains visible`);
    for (const key of ["x", "y", "width", "height"] as const) {
      assert(Math.abs(after[id][key] - position[key]) < 0.00001, `Unmodified network node ${id} keeps its ${key} until Relax`);
    }
  }
}
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 5)); });
  for (let index = 0; frames.size && index < 30; index++) {
    const callbacks = [...frames.values()]; frames.clear();
    await act(async () => { callbacks.forEach((callback) => callback(0)); });
  }
  assert.equal(frames.size, 0, "Switching views settles without animation loops");
}
async function click(target: any) { await act(async () => target.click()); await settle(); }
async function choose(label: string, value: string) {
  await act(async () => {
    const select = element(`select[aria-label="${label}"]`);
    select.value = value;
    select.dispatchEvent(new browser.Event("change", { bubbles: true }));
  });
  await settle();
}
async function show(mode: string) {
  if (["canvas", "focus", "topics", "lineage"].includes(mode)) await click(element(`[aria-label="${mode[0].toUpperCase()}${mode.slice(1)} view"]`));
  else await choose("More graph views", mode);
  assert.equal(element("section[data-view-mode]").dataset.viewMode, mode);
}
async function fresh(name: string, patch: Record<string, unknown> = {}) {
  workspaceKey = name;
  focusRequest = null;
  browser.sessionStorage.setItem(`margin-graph-location:${workspaceKey}`, JSON.stringify({ ...defaultGraphLocation(), viewMode: "canvas", overviewPresentation: "canvas", ...patch }));
  await act(async () => reactRoot.render(createElement(Host)));
  await settle();
}
async function wheel(target: any, ctrlKey = false) {
  const event = new browser.WheelEvent("wheel", { deltaY: 80, bubbles: true, cancelable: true });
  Object.defineProperties(event, { ctrlKey: { value: ctrlKey }, clientX: { value: 350 }, clientY: { value: 220 } });
  await act(async () => target.dispatchEvent(event)); await settle();
  return event;
}
function checkbox(label: string): any {
  const found = [...container.querySelectorAll("label")].find((candidate) => candidate.textContent.trim() === label)?.querySelector("input");
  assert(found, `Missing ${label} filter`);
  return found;
}
async function pointer(target: any, type: string, x: number, y: number) {
  await act(async () => target.dispatchEvent(new browser.PointerEvent(type, { pointerId: 7, pointerType: "mouse", button: 0, buttons: type === "pointerup" ? 0 : 1,
    clientX: x, clientY: y, bubbles: true, cancelable: true })));
  await settle();
}

try {
  await fresh("legacy-view", { viewMode: undefined, contentLens: undefined, relationKinds: undefined, networkPins: undefined,
    overviewPresentation: "documents", documentLayoutMode: "tree-down", selectedConversationId: "root", dockedConversationId: "root", source,
    query: "evidence", readerScroll: 187, viewport: { x: 120, y: 80, scale: 0.65 } });
  assert.equal(mode(), "documents");
  assert.equal(element(".conversation-graph-stage").dataset.documentLayoutMode, "tree-down");
  assert.equal(state().viewMode, null, "Legacy placement remains intact until an explicit mode choice");
  assert.equal(state().query, "evidence");
  assert.deepEqual(state().source, source);
  assert.deepEqual(state().relationKinds, ["branch", "link"]);
  assert.deepEqual(state().networkPins, {});
  assert.equal(element('[data-reader-id="root"] .panel-body').scrollTop, 187);
  checks.push("legacy map restoration retains layout, source, query and reading location");

  await fresh("mode-retention", { selectedConversationId: "root", dockedConversationId: "root", detailLevel: "preview", query: "evidence", readerScroll: 211, source });
  const authored = positions();
  const canvasViewport = state().viewport;
  for (const next of ["focus", "topics", "lineage", "network", "timeline", "matrix", "flow", "canvas"]) {
    await show(next);
    assert.equal(state().selectedConversationId, "root", `${next} retains the selected source`);
    assert.equal(state().dockedConversationId, "root", `${next} retains the docked reader`);
    assert.equal(state().query, "evidence", `${next} retains map search`);
    assert.equal(state().readerScroll, 211, `${next} retains reader scroll`);
    assert.deepEqual(state().source, source);
    assert.equal(element('.conversation-graph-dock [data-reader-id="root"] .panel-body').scrollTop, 211);
  }
  assert.deepEqual(positions(), authored, "Returning to Canvas restores authored card placement");
  assert.deepEqual(state().viewport, canvasViewport, "Returning to Canvas restores its own camera");
  assert.equal(layoutWrites, 0, "Changing automatic views does not write Canvas layouts");
  assert.deepEqual(layouts, originalLayouts);
  await click(element('[aria-label="Back in map"]'));
  assert.equal(mode(), "flow");
  await click(element('[aria-label="Forward in map"]'));
  assert.equal(mode(), "canvas");
  await fresh("inline-reader-mode-switch", { selectedConversationId: "root", detailLevel: "reader", source, query: "evidence" });
  assert(element('.conversation-graph-node-reader [data-reader-id="root"]'));
  await show("matrix");
  assert.equal(state().dockedConversationId, "root", "Changing an inline reader to an analytical view keeps its source open in the dock");
  assert.equal(state().detailLevel, "preview");
  assert.equal(container.querySelectorAll('[data-reader-id="root"]').length, 1, "Mode changes retain only one reader for the document");
  assert.deepEqual(state().source, source);
  checks.push("all mode changes preserve selection, source, dock, scroll, query, Canvas positions and history");

  await fresh("lineage-relations");
  await show("network");
  assert.equal(container.querySelectorAll(".graph-personal-connection").length, 1);
  await show("lineage");
  assert.equal(container.querySelectorAll(".graph-personal-connection").length, 0);
  assert.equal(container.querySelectorAll("path[data-parent-conversation-id]").length, 1);
  const branch = element('path[data-child-conversation-id="child"]');
  assert.equal(branch.dataset.parentConversationId, "root");
  assert.equal(checkbox("Branch ancestry").checked, true);
  assert.equal(checkbox("Authored links").checked, false);
  assert.equal(checkbox("Authored links").disabled, true);
  await show("network");
  assert.equal(container.querySelectorAll(".graph-personal-connection").length, 1, "Leaving Lineage restores authored-link visibility");
  await click(checkbox("Authored links"));
  assert.equal(container.querySelectorAll(".graph-personal-connection").length, 0);
  assert.equal(container.querySelectorAll("path[data-parent-conversation-id]").length, 1);
  checks.push("Lineage shows only branch ancestry and relation filters apply independently elsewhere");

  await fresh("matrix-read");
  await show("matrix");
  const matrix = element(".graph-analysis-matrix");
  const matrixSource = [...matrix.querySelectorAll("button")].find((candidate: any) => candidate.textContent.trim() === "Linked comparison");
  await click(matrixSource);
  assert.equal(mode(), "matrix");
  assert.equal(state().selectedConversationId, "side");
  assert.equal(state().dockedConversationId, "side");
  assert(element('.conversation-graph-dock [data-reader-id="side"]'));
  for (const next of ["matrix", "timeline", "flow"]) {
    if (mode() !== next) await show(next);
    const before = state().viewport;
    const panel = element(`.graph-analysis-${next}`);
    for (const pinch of [false, true]) {
      const event = await wheel(panel, pinch);
      assert.deepEqual(state().viewport, before, `${next} panel gestures cannot pan or zoom the map`);
      assert.equal(event.defaultPrevented, false, `${next} retains native scrolling`);
    }
  }
  checks.push("matrix source opens in the dock without leaving its view and analysis panels keep native scrolling");

  await fresh("network-pins", { selectedConversationId: "root", detailLevel: "compact" });
  await show("network");
  const beforePin = positions();
  await click(button("Pin selected"));
  assertUnmoved(beforePin);
  await click(button("Unpin selected"));
  assertUnmoved(beforePin);
  assert.equal(state().networkPins.root, undefined);
  await click(button("Pin selected"));
  assertUnmoved(beforePin);
  const pin = structuredClone(state().networkPins.root);
  assert(pin && Number.isFinite(pin.x) && Number.isFinite(pin.y));
  await click(button("Relax network"));
  assert.equal(state().networkIteration, 1);
  assert.deepEqual(state().networkPins.root, pin);
  const pinnedNode = positions().root;
  assert(Math.abs(pinnedNode.x + pinnedNode.width / 2 - pin.x - 90) < 0.00001, "Pinned network card retains its world center after relaxing");
  const beforeDrag = state().networkPins.root;
  const positionsBeforeDrag = positions();
  const dragCamera = state().viewport;
  await pointer(element('[data-conversation-id="root"] .conversation-graph-node-move-handle'), "pointerdown", 120, 140);
  await pointer(element(".conversation-graph-viewport"), "pointermove", 210, 185);
  await pointer(element(".conversation-graph-viewport"), "pointerup", 210, 185);
  assert(Math.abs(state().networkPins.root.x - beforeDrag.x - 90 / dragCamera.scale) < 0.001, "Dragging pins at the moved world coordinate");
  assert(Math.abs(state().networkPins.root.y - beforeDrag.y - 45 / dragCamera.scale) < 0.001);
  assertUnmoved(positionsBeforeDrag, ["root"]);
  await click(button("Unpin selected"));
  assertUnmoved(positionsBeforeDrag, ["root"]);
  await click(button("Pin selected"));
  assertUnmoved(positionsBeforeDrag, ["root"]);
  assert.equal(layoutWrites, 0, "Network pins and drags never write authored Canvas layouts");
  await show("canvas");
  await show("network");
  assert.equal(state().networkIteration, 1);
  assert(state().networkPins.root);
  checks.push("network pinning, relaxation and dragging persist separately from Canvas geometry");

  await choose("Graph content lens", "concepts");
  assert.equal(element("section[data-content-lens]").dataset.contentLens, "concepts");
  assert(element('.graph-evidence-view[aria-label="Concepts view"]'));
  assert.equal(container.querySelector(".conversation-graph-stage"), null, "The Concepts lens replaces the document map with its source view");
  await choose("Graph content lens", "evidence");
  assert.equal(mode(), "evidence");
  assert.equal(element("section[data-content-lens]").dataset.contentLens, "documents");
  assert.equal(element('select[aria-label="Graph content lens"]').value, "evidence");
  assert(element('.graph-evidence-view[aria-label="Evidence view"]'));
  await choose("Graph content lens", "documents");
  assert.equal(mode(), "network", "Returning to Documents restores the preceding document mode");
  assert.equal(element('select[aria-label="Graph content lens"]').value, "documents");
  await choose("Graph content lens", "concepts");
  focusRequest = { conversationId: "side", requestId: 103, openReader: true };
  await act(async () => reactRoot.render(createElement(Host)));
  await settle();
  assert.equal(focusRequest, null, "The external focus request is acknowledged");
  assert.equal(state().selectedConversationId, "side");
  assert.equal(state().dockedConversationId, "side");
  assert.equal(mode(), "network");
  assert.equal(element("section[data-content-lens]").dataset.contentLens, "concepts");
  assert(element('.graph-evidence-view[aria-label="Concepts view"]'));
  assert(element('.conversation-graph-dock [data-reader-id="side"]'));
  await show("canvas");
  assert.equal(element('select[aria-label="Graph content lens"]').value, "documents");
  checks.push("content controls switch Concepts and Claims & evidence while document modes remain available");

  assert(writeGraphConcepts("concept-navigation", [
    { id: "first", label: "First concept", description: "The previously selected concept.", members: [source] },
    { id: "second", label: "Second concept", description: "The concept selected through Explore.", members: [{ conversationId: "side", sourceKind: "conversation" }] },
  ]));
  await fresh("concept-navigation", { selectedConceptId: "first" });
  await choose("Graph content lens", "concepts");
  assert.equal(element(".graph-evidence-heading h3").textContent, "First concept");
  await click(element('[aria-label="Explore map collections and sources"]'));
  const concept = [...container.querySelectorAll(".graph-exploration-concept-open")].find((candidate) => candidate.textContent.includes("Second concept"));
  assert(concept);
  await click(concept);
  assert.equal(state().selectedConceptId, "second", "Explore synchronizes the concept selected in the source panel");
  assert.deepEqual(state().scope, { kind: "concept", conceptId: "second" });
  assert.equal(element(".graph-evidence-heading h3").textContent, "Second concept");
  checks.push("Explore concept navigation updates both graph scope and the displayed concept");

  assert.equal(layoutWrites, 0);
  assert.deepEqual(layouts, originalLayouts);
  process.stdout.write(`${JSON.stringify({ checks })}\n`);
} finally {
  await act(async () => reactRoot.unmount());
  browser.happyDOM.abort();
}
