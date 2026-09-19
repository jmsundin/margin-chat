import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { Conversation, ConversationGroup, GraphNodeLayout } from "../../client/src/types";
import type { GraphEvidenceRef } from "../../client/src/lib/graphExploration";

const browser = new Window({ url: "http://graph-exploration.test/" });
for (const name of ["window", "document", "navigator", "localStorage", "sessionStorage", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "ResizeObserver", "DOMRect"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  Object.defineProperty(globalThis, name, { configurable: true, value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperties(browser.HTMLElement.prototype, {
  clientWidth: { configurable: true, get: () => 1000 },
  clientHeight: { configurable: true, get: () => 700 },
});
let frameId = 0;
const frames = new Map<number, FrameRequestCallback>();
browser.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
browser.cancelAnimationFrame = (id) => { frames.delete(id); };

const { act, createElement, Fragment, useRef } = await import("../../client/node_modules/react/index.js");
const { createRoot } = await import("../../client/node_modules/react-dom/client.js");
const { default: ConversationGraphView } = await import("../../client/src/components/ConversationGraphView");
const { default: GraphSourceFocus } = await import("../../client/src/components/GraphSourceFocus");
const { createMainConversation, createChildConversation, createStandaloneNoteConversation } = await import("../../client/src/initialState");
const { buildThreadSummaries } = await import("../../client/src/lib/conversationSearch");
const { createDefaultGraphNodeLayout } = await import("../../client/src/lib/graphLayout");

const createdAt = "2000-01-01T00:00:00.000Z";
const quote = "Archive needle survives";
const rootChat = createMainConversation({ id: "root", createdAt });
rootChat.title = "Original research";
rootChat.messages = [{ id: "root-source", role: "assistant", content: `Context before. ${quote} beyond a recent-item sample. Context after.`, createdAt }];
const conversations: Record<string, Conversation> = { root: rootChat };
const layouts: Record<string, GraphNodeLayout> = { root: createDefaultGraphNodeLayout({ x: -500, y: -300, positioned: true }) };
function addBranch(id: string, title: string, parentId: string, x: number, y: number) {
  const parent = conversations[parentId];
  const child = createChildConversation({ id, createdAt, parentConversation: parent });
  child.title = title;
  child.messages = [{ id: `${id}-answer`, role: "assistant", content: `Evidence from ${title}.`, createdAt }];
  const content = parent.messages[0].content;
  const sourceQuote = parentId === "root" ? quote : content;
  const startOffset = content.indexOf(sourceQuote);
  child.branchAnchor = { id: `${id}-anchor`, createdAt, sourceConversationId: parentId,
    sourceMessageId: parent.messages[0].id, startOffset, endOffset: startOffset + sourceQuote.length,
    quote: sourceQuote, prompt: "Explore this evidence" };
  parent.childIds.push(id);
  conversations[id] = child;
  layouts[id] = createDefaultGraphNodeLayout({ x, y, positioned: true });
}
addBranch("child", "Hidden branch", "root", 200, -300);
addBranch("deep", "Deeper branch", "child", 900, -300);
addBranch("deeper", "Deepest branch", "deep", 1600, -300);
addBranch("aside", "Research comparison", "root", 200, 400);
for (let index = 0; index < 56; index++) {
  const note = createStandaloneNoteConversation({ id: `recent-${index}`, noteId: `body-${index}`, createdAt: "2026-09-19T12:00:00.000Z" });
  note.title = `Recent note ${index}`;
  note.notes![0].content = `Recent source ${index} about an unrelated topic.`;
  conversations[note.id] = note;
  layouts[note.id] = createDefaultGraphNodeLayout({ x: 2300 + (index % 8) * 650, y: Math.floor(index / 8) * 700, positioned: true });
}
const groups: Record<string, ConversationGroup> = {
  research: { id: "research", name: "Evidence research", color: "#4fbf9f", collapsed: false, conversationIds: ["root", "aside"] },
  hidden: { id: "hidden", name: "Hidden branches", color: "#6f88ff", collapsed: true, conversationIds: ["child", "deep", "deeper"] },
};
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
let account = "account-a";
let focusRequest: { conversationId: string; requestId: number } | null = null;
function Reader({ id, source }: { id: string; source?: GraphEvidenceRef }) {
  const panelRef = useRef<HTMLElement | null>(null);
  return createElement(Fragment, null,
    createElement(GraphSourceFocus, { source, getPanelElement: () => panelRef.current }),
    createElement("article", { className: "chat-panel", "data-reader-id": id, ref: panelRef },
      createElement("div", { className: "panel-body", "data-source-message": source?.messageId }, conversations[id].messages.map((message) => createElement("p", {
        key: message.id, "data-message-row-id": message.id, tabIndex: -1,
        ref(node: HTMLElement | null) {
          if (node) node.scrollIntoView = () => { node.closest<HTMLElement>(".panel-body")!.scrollTop = 120; };
        },
      }, message.content)))),
  );
}
function Graph() {
  return createElement(ConversationGraphView, {
    key: account, workspaceKey: account, activeConversationId: "root", conversations, groups,
    graphLayouts: layouts, threads: buildThreadSummaries(conversations), focusRequest,
    onFocusRequestHandled(requestId) { if (focusRequest?.requestId === requestId) focusRequest = null; },
    onActivateConversation() {}, onAssignGroup() {}, onCreateChildConversation: () => null,
    onOpenConversation() {}, onToggleGroup() {},
    renderDockedConversation: (id, source) => createElement(Reader, { id, source }),
  });
}
async function flushFrames() {
  for (let iteration = 0; frames.size && iteration < 20; iteration++) {
    const callbacks = [...frames.values()]; frames.clear();
    await act(async () => { callbacks.forEach((callback) => callback(0)); });
  }
  assert.equal(frames.size, 0, "Graph rendering settles without an animation-frame loop");
}
async function render() { await act(async () => { root.render(createElement(Graph)); }); await flushFrames(); }
async function remount() { await act(async () => { root.render(null); }); await render(); }
function element(selector: string) {
  const value = container.querySelector(selector);
  assert(value, `Missing ${selector}`);
  return value as any;
}
function button(text: string, selector = "button") {
  const value = [...container.querySelectorAll(selector)].find((item) => item.textContent.trim() === text);
  assert(value, `Missing button: ${text}`);
  return value as any;
}
async function click(target: any) { await act(async () => { target.click(); }); await flushFrames(); }
async function fill(selector: string, value: string) {
  await act(async () => {
    const input = element(selector);
    const prototype = input.tagName === "TEXTAREA" ? browser.HTMLTextAreaElement.prototype : browser.HTMLInputElement.prototype;
    Object.getOwnPropertyDescriptor(prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  await flushFrames();
}
async function searchForEvidence() {
  await fill('.graph-exploration-search input', "archive needle");
  const results = [...container.querySelectorAll(".graph-exploration-source-item")];
  assert.equal(results.length, 1, "Search includes old messages beyond the 40 most recent items");
  assert(results[0].textContent.includes("Original research"));
  await click(results[0]);
  assert.equal(element('.graph-map-evidence mark').textContent, "Archive needle", "The exact matched span is highlighted");
  assert.equal(element('[data-reader-id="root"] .panel-body').dataset.sourceMessage, "root-source");
}
function scopeLabel() { return element(".graph-map-scope").textContent; }
function stageCount() { return Number(element(".conversation-graph-stage").dataset.sceneNodeCount); }

async function checkTemporarySelectionSpacing() {
  const denseConversations = Object.fromEntries(["center", "right", "below"].map((id) => {
    const conversation = createMainConversation({ id: `dense-${id}`, createdAt });
    conversation.title = `Dense ${id}`;
    conversation.messages = [{ id: `${id}-message`, role: "assistant", content: "A discussion with enough content to preview and read.", createdAt }];
    return [conversation.id, conversation];
  }));
  const denseLayouts = {
    "dense-center": createDefaultGraphNodeLayout({ x: 0, y: 0, positioned: true }),
    "dense-right": createDefaultGraphNodeLayout({ x: 300, y: 0, positioned: true }),
    "dense-below": createDefaultGraphNodeLayout({ x: 0, y: 190, positioned: true }),
  };
  const savedLayouts = structuredClone(denseLayouts);
  const layoutWrites: Array<Record<string, Partial<GraphNodeLayout>>> = [];
  await act(async () => {
    root.render(createElement(ConversationGraphView, {
      workspaceKey: "temporary-spacing", activeConversationId: "dense-center", conversations: denseConversations,
      groups: {}, graphLayouts: denseLayouts,
      onActivateConversation() {}, onAssignGroup() {}, onCreateChildConversation: () => null,
      onOpenConversation() {}, onToggleGroup() {},
      onUpdateGraphNodeLayouts: (updates) => { layoutWrites.push(structuredClone(updates)); },
    }));
  });
  await flushFrames();
  await click(button("Show map"));
  const ids = ["dense-center", "dense-right", "dense-below"];
  function placement(id: string) {
    const node = element(`[data-conversation-id="${id}"]`);
    return { x: parseFloat(node.style.left), y: parseFloat(node.style.top), width: parseFloat(node.style.width), height: parseFloat(node.style.height) };
  }
  function positions() { return ids.map((id) => { const { x, y } = placement(id); return { id, x, y }; }); }
  function assertNoOverlaps() {
    for (let leftIndex = 0; leftIndex < ids.length; leftIndex++) {
      for (let rightIndex = leftIndex + 1; rightIndex < ids.length; rightIndex++) {
        const left = placement(ids[leftIndex]);
        const right = placement(ids[rightIndex]);
        assert(left.x + left.width <= right.x || right.x + right.width <= left.x || left.y + left.height <= right.y || right.y + right.height <= left.y,
          `Expanding a focused card must leave ${ids[leftIndex]} and ${ids[rightIndex]} readable without overlap`);
      }
    }
  }
  async function escape() {
    await act(async () => { browser.document.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
    await flushFrames();
  }
  const originalPositions = positions();
  assertNoOverlaps();
  await click(element('[aria-label="Preview Dense center"]'));
  const previewPositions = positions();
  assert.deepEqual(previewPositions[0], originalPositions[0], "Preview keeps the focused node anchored to its saved location");
  assert.notDeepEqual(previewPositions[1], originalPositions[1], "Preview temporarily moves the neighbor that the larger card would cover");
  assertNoOverlaps();
  assert.equal(layoutWrites.length, 0, "Selecting a preview never persists the temporary spacing");

  await click(element('[aria-label="Expand Dense center"]'));
  const readerPositions = positions();
  assert.deepEqual(readerPositions[0], originalPositions[0], "The expanded reader keeps the focused node anchored");
  assert.notDeepEqual(readerPositions[2], originalPositions[2], "Reader expansion also pushes aside the lower neighbor");
  assertNoOverlaps();
  assert.equal(layoutWrites.length, 0, "Expanding a reader never persists displaced neighbors");

  const moveHandle = element('[aria-label="Move Dense center"]');
  moveHandle.setPointerCapture = () => {};
  await act(async () => {
    moveHandle.dispatchEvent(new browser.PointerEvent("pointerdown", { pointerId: 7, button: 0, clientX: 100, clientY: 100, bubbles: true }));
    moveHandle.dispatchEvent(new browser.PointerEvent("pointerup", { pointerId: 7, button: 0, clientX: 100, clientY: 100, bubbles: true }));
  });
  await flushFrames();
  assert(layoutWrites.every((updates) => Object.keys(updates).length === 0), "Grabbing and releasing without moving cannot save temporary neighbor displacement");
  await escape();
  assert(element('[data-conversation-id="dense-center"]').classList.contains("is-preview"));
  assertNoOverlaps();
  await escape();
  assert.equal(container.querySelector(".conversation-graph-node.is-selected"), null);
  assert.deepEqual(positions(), originalPositions, "Deselecting restores every original node coordinate");
  assert.deepEqual(denseLayouts, savedLayouts, "Temporary focus spacing never mutates the saved layout objects");

  await click(element('[aria-label="Preview Dense center"]'));
  assert.deepEqual(positions(), previewPositions, "Repeated focusing starts from the saved positions without accumulating displacement");
  await click(element('[aria-label="Preview Dense center"]'));
  assert.equal(container.querySelector(".conversation-graph-node.is-selected"), null, "Clicking the selected card again deselects it");
  assert.deepEqual(positions(), originalPositions, "Clicking the selected card again restores original neighbor positions");

  await click(element('[aria-label="Preview Dense center"]'));
  const viewport = element(".conversation-graph-viewport");
  viewport.setPointerCapture = () => {};
  await act(async () => {
    viewport.dispatchEvent(new browser.PointerEvent("pointerdown", { pointerId: 8, button: 0, clientX: 970, clientY: 680, bubbles: true }));
    viewport.dispatchEvent(new browser.PointerEvent("pointerup", { pointerId: 8, button: 0, clientX: 970, clientY: 680, bubbles: true }));
  });
  await flushFrames();
  assert.equal(container.querySelector(".conversation-graph-node.is-selected"), null, "A blank-canvas click deselects the focused card");
  assert.deepEqual(positions(), originalPositions, "Blank-canvas deselection restores the authored positions");
  assert(layoutWrites.every((updates) => Object.keys(updates).length === 0));
}

try {
  await render();
  assert.equal(stageCount(), 61);
  assert.equal(element(".graph-overview-canvas h2").textContent, "Your ideas, connected", "The map starts with an overview of topics");
  assert.deepEqual([...container.querySelectorAll('[aria-label="Map topics"] strong')].map((item) => item.textContent), ["Evidence research", "Hidden branches", "Ungrouped"]);
  await click(button("Show map"));
  assert.equal(container.querySelector(".graph-overview-canvas"), null, "Show map switches from topics to discussion nodes");
  assert(button("Show themes"));
  await click(element('[aria-label="Back in map"]'));
  assert(container.querySelector(".graph-overview-canvas"), "Back restores the previous overview presentation");
  await click(element('[aria-label="Forward in map"]'));
  assert.equal(container.querySelector(".graph-overview-canvas"), null);
  await remount();
  assert.equal(container.querySelector(".graph-overview-canvas"), null, "The chosen map presentation survives leaving and returning");
  await click(button("Show themes"));
  await click(element('[aria-label="Inspect 1 branch from Evidence research to Hidden branches"]'));
  const connectionSources = [...element('[aria-label="Sources behind this connection"]').querySelectorAll(":scope > button")];
  assert.equal(connectionSources.length, 2, "The overview connection exposes the actual parent and child sources");
  assert(connectionSources.some((item: any) => item.textContent.includes("Original research")));
  await click(connectionSources.find((item: any) => item.textContent.includes("Hidden branch")));
  assert.equal(container.querySelector(".graph-overview-canvas"), null, "Inspecting an original source reveals its discussion on the map");
  assert(element('[data-conversation-id="child"]').classList.contains("is-selected"));
  assert(element(".conversation-graph-dock").getAttribute("aria-label").includes("Hidden branch"));
  await click(button("Show branch source"));
  assert.equal(element(".graph-map-evidence mark").textContent, quote, "An overview connection can be verified against its exact branch origin");
  await click(element('[aria-label="Back in map"]'));
  assert(element(".conversation-graph-dock").getAttribute("aria-label").includes("Hidden branch"));
  await click(element('[aria-label="Back in map"]'));
  assert(container.querySelector(".graph-overview-canvas"), "Back restores topics after inspecting their connection");
  assert.equal(container.querySelector('[aria-label="Sources behind this connection"]'), null);
  await click(element('[aria-label="Explore Hidden branches"]'));
  assert(scopeLabel().startsWith("Hidden branches"), "Explore enters the selected topic's conversations");
  assert.equal(stageCount(), 3);
  assert.equal(container.querySelector(".graph-overview-canvas"), null);
  await click(element('[aria-label="Back in map"]'));
  assert(container.querySelector(".graph-overview-canvas"));
  assert.equal(container.querySelectorAll(".graph-exploration-source-item").length, 0, "The closed source list does not mount every result");
  await click(button("Show list"));
  assert.equal(container.querySelectorAll(".graph-exploration-source-item").length, 40);
  assert(element('.graph-exploration-list-hint[role="status"]').textContent.includes("Showing 40 of 61 chats and notes"));
  assert(![...container.querySelectorAll(".graph-exploration-source-item strong")].some((item) => item.textContent === "Original research"), "The old source starts beyond the first results page");
  const explorerScroller = element('[aria-label="Map exploration lists"]');
  explorerScroller.scrollTop = 320;
  await click(button("Show 21 more chats and notes"));
  assert.equal(container.querySelectorAll(".graph-exploration-source-item").length, 61, "Loading more makes the complete source list reachable");
  assert.equal(explorerScroller.scrollTop, 320, "Loading more sources preserves the explorer's scroll position");
  assert([...container.querySelectorAll(".graph-exploration-source-item strong")].some((item) => item.textContent === "Original research"));
  await click(element(".graph-exploration-source-item"));
  assert.equal(explorerScroller.scrollTop, 320, "Selecting a listed source preserves the explorer's scroll position");
  await click(element('[aria-label="Back in map"]'));
  explorerScroller.scrollTop = 540;
  await fill('.graph-exploration-search input', "Recent source");
  assert.equal(explorerScroller.scrollTop, 0, "A new query starts at the first matching result");
  explorerScroller.scrollTop = 280;
  await click(element('[aria-label="Clear map search"]'));
  assert.equal(explorerScroller.scrollTop, 0, "Clearing the query starts the complete source list at the top");
  await click(button("Hide list"));
  await click(button("+ New"));
  await fill('form[aria-label="Create concept"] input', "Evidence across themes");
  await fill('form[aria-label="Create concept"] textarea', "Sources that connect an overview to its exact evidence.");
  explorerScroller.scrollTop = 460;
  await click(button("Create concept", 'form[aria-label="Create concept"] button'));
  assert(scopeLabel().includes("Evidence across themes · 0 of 61 sources"), scopeLabel());
  assert.equal(explorerScroller.scrollTop, 0, "Changing scope resets the explorer to the new topic's first source");
  await click(button("Overview"));
  await searchForEvidence();
  await click(button("Add selected source"));
  assert.equal(element(".graph-exploration-concept-open span").textContent, "1 reference");
  await click(element(".graph-exploration-concept-open"));
  assert.equal(stageCount(), 1, "A concept scopes the map to its member conversations");
  await remount();
  assert(scopeLabel().includes("Evidence across themes · 1 of 61 sources"));
  assert.equal(element(".graph-exploration-concept-open span").textContent, "1 reference", "Saved source memberships survive leaving and returning to the map");
  assert(element('.graph-exploration-list-hint[role="status"]').textContent.includes("Showing 1 of 1 references"), "Concept passage references are labeled separately from chat and note counts");
  await click(element(".graph-exploration-source-item"));
  assert.equal(element(".graph-map-evidence mark").textContent, "Archive needle", "Saved concept evidence retains its exact passage");

  account = "account-b"; await render();
  assert.equal(container.querySelector(".graph-exploration-concept-open"), null, "Another account does not inherit saved concepts");
  assert.equal(container.querySelector(".conversation-graph-dock"), null, "Another account does not inherit reader state");
  assert(scopeLabel().startsWith("All discussions"));
  account = "account-a"; await render();
  assert(element(".graph-exploration-concept-open").textContent.includes("Evidence across themes"));
  assert.equal(element(".graph-map-evidence mark").textContent, "Archive needle");

  account = "navigation-account"; await render();
  await click([...container.querySelectorAll(".graph-exploration-overview-item")].find((item) => item.querySelector("strong")?.textContent === "Evidence research"));
  assert.equal(stageCount(), 2);
  const groupTransform = element(".conversation-graph-stage").style.transform;
  await click([...container.querySelectorAll(".graph-exploration-source-item")].find((item) => item.textContent.includes("Research comparison")));
  assert(element(".conversation-graph-dock").getAttribute("aria-label").includes("Research comparison"));
  await act(async () => {
    const scroller = element('[data-reader-id="aside"] .panel-body');
    scroller.scrollTop = 340;
    scroller.dispatchEvent(new browser.Event("scroll", { bubbles: false }));
  });
  await click(button("Show branch source"));
  assert.equal(element(".graph-map-evidence mark").textContent, quote, "Branch provenance opens its exact source quote");
  assert(element(".conversation-graph-dock").getAttribute("aria-label").includes("Original research"));
  await click(element('[aria-label="Back in map"]'));
  assert(scopeLabel().startsWith("Evidence research"));
  assert(element(".conversation-graph-dock").getAttribute("aria-label").includes("Research comparison"));
  assert.equal(element('[data-reader-id="aside"] .panel-body').scrollTop, 340, "Back restores reader position after source focus has mounted");
  await click(element('[aria-label="Back in map"]'));
  assert.equal(container.querySelector(".conversation-graph-dock"), null);
  assert.equal(element(".conversation-graph-stage").style.transform, groupTransform, "Back restores the previous map camera instead of refitting it");

  focusRequest = { conversationId: "child", requestId: 1 }; await render();
  assert(scopeLabel().startsWith("All discussions"), "External navigation leaves a conflicting group scope");
  assert(element('[data-conversation-id="child"]').classList.contains("is-selected"), "A requested source is exposed even inside a collapsed group");
  await click(button("Focus neighborhood"));
  assert(scopeLabel().startsWith("Around Hidden branch"));
  assert.equal(stageCount(), 3, "Initial focus contains parents and immediate children");
  await click(button("Expand branches · depth 1"));
  assert.equal(stageCount(), 5, "Expanding focus reveals the next branch level and nearby sibling");
  await click(element('[aria-label="Back in map"]'));
  assert.equal(stageCount(), 3, "Back restores the earlier focus depth");
  const beforeReturn = element(".conversation-graph-stage").style.transform;
  await remount();
  assert(scopeLabel().startsWith("Around Hidden branch"), "Returning from chat does not replay a previously handled focus request");
  assert.equal(element(".conversation-graph-stage").style.transform, beforeReturn);
  focusRequest = { conversationId: "deeper", requestId: 2 }; await render();
  assert.equal(focusRequest, null, "External focus requests are acknowledged after consumption");
  assert(element('[data-conversation-id="deeper"]').classList.contains("is-selected"), "A later external request still reveals its requested source");
  await checkTemporarySelectionSpacing();
  console.log("Graph concept, source, search, scope, focus, history, and account-isolation checks passed.");
} finally {
  await act(async () => { root.unmount(); });
  await browser.happyDOM.close();
}
