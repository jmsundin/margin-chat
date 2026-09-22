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
let canvasWidth = 1000;
let canvasHeight = 700;
Object.defineProperties(browser.HTMLElement.prototype, {
  clientWidth: { configurable: true, get: () => canvasWidth },
  clientHeight: { configurable: true, get: () => canvasHeight },
});
let frameId = 0;
const frames = new Map<number, FrameRequestCallback>();
browser.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
browser.cancelAnimationFrame = (id) => { frames.delete(id); };

const { act, createElement, Fragment, useRef } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: ConversationGraphView } = await import("../../client/src/components/ConversationGraphView");
const { default: GraphSourceFocus } = await import("../../client/src/components/GraphSourceFocus");
const { createMainConversation, createChildConversation, createStandaloneNoteConversation } = await import("../../client/src/initialState");
const { buildThreadSummaries } = await import("../../client/src/lib/conversationSearch");
const { createDefaultGraphNodeLayout } = await import("../../client/src/lib/graphLayout");
const { getConversationGraphNodeDimensions } = await import("../../client/src/lib/conversationGraph");

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
async function render() {
  await act(async () => { root.render(createElement(Graph)); }); await flushFrames();
  if (!container.querySelector('.graph-exploration-panel')) await click(element('[aria-label="Explore map collections and sources"]'));
}
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
function mapCamera() {
  const parts = element(".conversation-graph-stage").style.transform.match(/translate\(([-.\d]+)px, ([-.\d]+)px\) scale\(([-.\d]+)\)/);
  assert(parts, "The map exposes a finite camera transform");
  return { x: Number(parts[1]), y: Number(parts[2]), scale: Number(parts[3]) };
}
function styledRect(node: HTMLElement) {
  return { x: parseFloat(node.style.left), y: parseFloat(node.style.top), width: parseFloat(node.style.width), height: parseFloat(node.style.height) };
}
function assertPackedOverview(expectedGroups: number, inViewport = false) {
  const layer = element('.graph-territories[data-territory-mode="overview"]');
  const regions = [...layer.querySelectorAll('.graph-territory-region')] as HTMLElement[];
  assert.equal(regions.length, expectedGroups, "Overview shows one colored container per group");
  assert.equal(layer.querySelectorAll('.graph-territory-skeleton, .graph-territory-node, .is-group-marker, .graph-territory-links circle, .graph-territory-links rect').length, 0,
    "Overview contains named group boxes without untitled miniature nodes");
  regions.forEach((region, index) => {
    const box = styledRect(region);
    const heading = layer.querySelector(`button[data-territory-id="${region.dataset.territoryId}"]`) as HTMLElement;
    assert(heading?.querySelector('strong')?.textContent?.trim(), "Every group container has a readable name");
    const label = styledRect(heading);
    assert(label.x >= box.x && label.y >= box.y && label.x + label.width <= box.x + box.width && label.y + label.height <= box.y + box.height,
      "The group's heading stays inside its colored container");
    if (inViewport) assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= canvasWidth && box.y + box.height <= canvasHeight,
      "All groups fits every overview container inside the available canvas");
    for (const other of regions.slice(index + 1).map(styledRect)) {
      assert(box.x + box.width < other.x || other.x + other.width < box.x || box.y + box.height < other.y || other.y + other.height < box.y,
        "Sibling overview containers have space between them");
    }
  });
}
function screenRect(node: HTMLElement) {
  const bounds = styledRect(node), camera = mapCamera();
  const factor = Number(node.style.transform.match(/scale\(([-.\de]+)\)/)?.[1] ?? 1);
  return { x: camera.x + (bounds.x + bounds.width * (1 - factor) / 2) * camera.scale,
    y: camera.y + (bounds.y + bounds.height * (1 - factor) / 2) * camera.scale,
    width: bounds.width * factor * camera.scale, height: bounds.height * factor * camera.scale };
}
function assertDocumentCards(ids: string[], requireInside = false) {
  const camera = mapCamera();
  const cards = ids.map((id) => element(`.conversation-graph-node[data-conversation-id="${id}"]`));
  const boxes = cards.map(screenRect);
  boxes.forEach((box, index) => {
    assert(Math.abs(box.width - 180 * camera.scale) < 1e-6 && Math.abs(box.height - 96 * camera.scale) < 1e-6,
      "Document cards scale with the camera instead of retaining an overlapping readable-size floor");
    assert.equal(cards[index].classList.contains('is-title-hidden'), camera.scale < 0.4,
      "Document labels remain until their projected font is smaller than 8px");
    if (requireInside) assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= canvasWidth && box.y + box.height <= canvasHeight - 55,
      `The documents fit leaves room for the bottom navigation controls: ${JSON.stringify({ id: ids[index], box, camera })}`);
    for (const other of boxes.slice(index + 1)) assert(box.x + box.width <= other.x || other.x + other.width <= box.x
      || box.y + box.height <= other.y || other.y + other.height <= box.y,
    "Document cards never overlap, including dense or widely scattered saved layouts");
  });
  return boxes;
}
function assertReadableGroupCards(ids: string[]) {
  assert.equal(container.querySelector('.graph-group-contents'), null, "Group navigation uses canvas cards without a contents overlay");
  assert.equal(container.querySelector('.is-group-marker'), null, "Group members remain named cards instead of numbered markers");
  const regions = [...container.querySelectorAll('.graph-territory-region')];
  assert.equal(regions.length, 1, "A focused group has one colored container");
  const region = styledRect(regions[0] as unknown as HTMLElement);
  const boxes = ids.map((id) => screenRect(element(`.conversation-graph-node[data-conversation-id="${id}"]`)));
  boxes.forEach((box, index) => {
    assert(box.width >= 139 && box.height >= 87, "Temporarily spaced cards retain a readable size");
    assert(box.x >= region.x && box.y >= region.y && box.x + box.width <= region.x + region.width && box.y + box.height <= region.y + region.height,
      "Each focused card stays inside its group's colored container");
    for (const other of boxes.slice(index + 1)) {
      assert(box.x + box.width <= other.x || other.x + other.width <= box.x || box.y + box.height <= other.y || other.y + other.height <= box.y,
        "Temporarily spaced group cards do not overlap");
    }
  });
  return boxes;
}

async function checkAtlasCanvasNavigation() {
  const atlasConversations: Record<string, Conversation> = {};
  const atlasLayouts: Record<string, GraphNodeLayout> = {};
  const fixtures = [
    ["shade", "Tree shade", -2000, 0],
    ["water", "Water cycles", -1380, 440],
    ["soil", "Healthy soil", -800, 100],
    ["feedback", "Feedback loops", 1900, 0],
    ["systems", "Systems thinking", 2500, 450],
    ["field", "Field notes", 5500, 0],
    ["sources", "Source readings", 6200, 450],
  ] as const;
  for (const [id, title, x, y] of fixtures) {
    const note = createStandaloneNoteConversation({ id, noteId: `${id}-body`, createdAt });
    note.title = title;
    note.notes![0].content = `Research notes about ${title.toLowerCase()}.`;
    atlasConversations[id] = note;
    atlasLayouts[id] = createDefaultGraphNodeLayout({ x, y, positioned: true });
  }
  const atlasGroups: Record<string, ConversationGroup> = {
    climate: { id: "climate", name: "Climate", color: "#4fbf9f", collapsed: true, conversationIds: ["shade", "water", "soil"] },
    systems: { id: "systems", name: "Systems", color: "#6f88ff", collapsed: false, conversationIds: ["feedback", "systems"] },
    evidence: { id: "evidence", name: "Evidence", color: "#cf986b", collapsed: false, conversationIds: ["field", "sources"] },
  };
  const authoredLayouts = structuredClone(atlasLayouts);
  atlasConversations.shade.linkedConversationIds = ["water"];
  const layoutWrites: Array<Record<string, Partial<GraphNodeLayout>>> = [];
  const originalRect = browser.HTMLElement.prototype.getBoundingClientRect;
  const originalResizeObserver = globalThis.ResizeObserver;
  const resizeNotifications = new Set<() => void>();
  class NotifyingResizeObserver {
    private active = false;
    constructor(private callback: ResizeObserverCallback) {}
    notify = () => { if (this.active) this.callback([], this as unknown as ResizeObserver); };
    observe() { this.active = true; resizeNotifications.add(this.notify); queueMicrotask(this.notify); }
    unobserve() { this.disconnect(); }
    disconnect() { this.active = false; resizeNotifications.delete(this.notify); }
  }
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: NotifyingResizeObserver });
  browser.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.classList.contains("conversation-graph-viewport")
      ? new browser.DOMRect(0, 0, canvasWidth, canvasHeight)
      : originalRect.call(this);
  };
  function climateButton() { return element('button[aria-label="Explore Climate, 3 chats and notes"]'); }
  function assertClimateFits() {
    const camera = mapCamera();
    const region = styledRect(element('.graph-territory-region[data-territory-id="climate"]'));
    const spaced = element('.conversation-graph-stage').dataset.groupLayout === "spaced";
    if (spaced) assertReadableGroupCards(atlasGroups.climate.conversationIds);
    for (const id of atlasGroups.climate.conversationIds) {
      const node = element(`[data-conversation-id="${id}"]`);
      const x = parseFloat(node.style.left), y = parseFloat(node.style.top);
      const width = parseFloat(node.style.width), height = parseFloat(node.style.height);
      const magnification = Number(node.style.transform.match(/scale\(([-.\d]+)\)/)?.[1] ?? 1);
      const left = camera.x + (x + width * (1 - magnification) / 2) * camera.scale;
      const top = camera.y + (y + height * (1 - magnification) / 2) * camera.scale;
      const right = left + width * magnification * camera.scale;
      const bottom = top + height * magnification * camera.scale;
      assert(left >= 0 && top >= 0 && right <= canvasWidth && bottom <= canvasHeight,
        `Zoom-to-fit keeps ${id}'s readable card inside ${canvasWidth}×${canvasHeight}: ${JSON.stringify({ left, top, right, bottom })}`);
      assert(left >= region.x && top >= region.y && right <= region.x + region.width && bottom <= region.y + region.height,
        "Focused members stay inside their colored group even when authored positions need no rearrangement");
      if (!spaced) {
        const originalSize = getConversationGraphNodeDimensions({ conversation: atlasConversations[id], detailLevel: "compact", isSelected: false, mode: "overview", semanticLevel: "compact" });
        assert.equal(x + width / 2, atlasLayouts[id].x + originalSize.width / 2, "Uncrowded regions preserve their authored horizontal node centers");
        assert.equal(y + height / 2, atlasLayouts[id].y + originalSize.height / 2, "Uncrowded regions preserve their authored vertical node centers");
      }
    }
  }
  function assertAllGroupContents() {
    assert.equal(element('.conversation-graph-stage').hidden, false, "Manual zoom reveals the groups' document cards");
    assertPackedOverview(3);
    assert.equal(stageCount(), fixtures.length, "Manual zoom retains every group and its documents");
    const cards: Array<{ id: string; x: number; y: number; width: number; height: number }> = [];
    for (const group of Object.values(atlasGroups)) {
      const heading = element(`button.graph-territory[data-territory-id="${group.id}"]`);
      assert.equal(heading.getAttribute('aria-pressed'), 'false', "Manual zoom does not select or isolate a group");
      const headingBox = styledRect(heading);
      const region = styledRect(element(`.graph-territory-region[data-territory-id="${group.id}"]`));
      for (const id of group.conversationIds) {
        const node = element(`.conversation-graph-node[data-conversation-id="${id}"]`);
        const card = screenRect(node);
        assert(node.textContent.includes(atlasConversations[id].title), "Grouped browsing shows each document's title");
        assert(card.width >= 71 && card.height >= 37, "Document cards retain space for readable small titles");
        const titleFont = parseFloat(node.style.getPropertyValue('--map-card-title-size'));
        assert(titleFont >= 8, "Document titles stay at or above the readable font floor");
        assert(card.x >= region.x && card.y >= headingBox.y + headingBox.height + 3.99
          && card.x + card.width <= region.x + region.width && card.y + card.height <= region.y + region.height,
        `Grouped browsing contains ${id} inside its colored box`);
        cards.push({ id, ...card });
      }
    }
    for (let index = 0; index < cards.length; index++) {
      const a = cards[index];
      for (const b of cards.slice(index + 1)) {
        assert(a.x + a.width < b.x || b.x + b.width < a.x || a.y + a.height < b.y || b.y + b.height < a.y,
          "Document cards from the complete grouped map never overlap");
      }
    }
    return cards;
  }
  try {
    for (const size of [{ width: 1000, height: 700 }, { width: 390, height: 844 }]) {
      await act(async () => { root.render(null); });
      canvasWidth = size.width; canvasHeight = size.height;
      async function renderAtlas() { await act(async () => {
        root.render(createElement(ConversationGraphView, {
          workspaceKey: `atlas-${size.width}`, activeConversationId: "shade", conversations: atlasConversations,
          groups: atlasGroups, graphLayouts: atlasLayouts,
          onActivateConversation() {}, onAssignGroup() {}, onCreateChildConversation: () => null,
          onOpenConversation() {}, onToggleGroup() {},
          onUpdateGraphNodeLayouts: (updates) => { layoutWrites.push(structuredClone(updates)); },
        }));
      }); await flushFrames(); }
      await renderAtlas();
      let overviewCamera = mapCamera();
      assert.equal(element('.graph-territories').getAttribute("data-territory-mode"), "overview");
      assertPackedOverview(3, true);
      const locationKey = `margin-graph-location:atlas-${size.width}`;
      const legacy = JSON.parse(browser.sessionStorage.getItem(locationKey)!);
      legacy.present.viewport = { x: 90000, y: -70000, scale: 0.2 };
      delete legacy.present.groupOverviewVersion;
      legacy.past = []; legacy.future = [];
      await act(async () => { root.render(null); });
      browser.sessionStorage.setItem(locationKey, JSON.stringify(legacy));
      await renderAtlas();
      assert.deepEqual(mapCamera(), overviewCamera, "Legacy overview cameras refit once to the packed group's coordinate system");
      assert.equal(JSON.parse(browser.sessionStorage.getItem(locationKey)!).present.groupOverviewVersion, 1);
      assertPackedOverview(3, true);
      await act(async () => {
        canvasWidth = size.width - 40; canvasHeight = size.height - 60;
        resizeNotifications.forEach((notify) => notify());
      });
      await flushFrames();
      assertPackedOverview(3, true);
      assert.notDeepEqual(mapCamera(), overviewCamera, "Resizing All groups refits its packed boxes to the measured canvas");
      await act(async () => {
        canvasWidth = size.width; canvasHeight = size.height;
        resizeNotifications.forEach((notify) => notify());
      });
      await flushFrames();
      assert.deepEqual(mapCamera(), overviewCamera, "Restoring the canvas size restores the overview fit");
      assert(element('[aria-label="Zoom out to all groups"]'), "The way back to the whole map is always available");
      let atlasViewport = element('.conversation-graph-viewport');
      atlasViewport.setPointerCapture = () => {};
      for (const selector of ['[aria-label="Zoom out"]', '.graph-map-layout-options > summary']) {
        const cameraBeforeControl = mapCamera();
        const press = new browser.PointerEvent("pointerdown", { pointerId: 80, pointerType: "mouse", button: 0, clientX: 100, clientY: 200, bubbles: true, cancelable: true });
        await act(async () => {
          element(selector).dispatchEvent(press);
          element(selector).dispatchEvent(new browser.PointerEvent("pointerup", { pointerId: 80, pointerType: "mouse", button: 0, clientX: 100, clientY: 200, bubbles: true }));
        });
        await flushFrames();
        assert.equal(press.defaultPrevented, false, "Map controls retain their native pointer behavior instead of starting canvas pan");
        assert.deepEqual(mapCamera(), cameraBeforeControl);
        assert(!atlasViewport.classList.contains("is-panning"));
        const controlWheel = new browser.WheelEvent("wheel", { deltaX: 14, deltaY: 27, bubbles: true, cancelable: true });
        await act(async () => { element(selector).dispatchEvent(controlWheel); });
        await flushFrames();
        assert.equal(controlWheel.defaultPrevented, false, "Scrolling over map controls retains the control's native behavior");
        assert.deepEqual(mapCamera(), cameraBeforeControl, "Scrolling over map controls does not pan the canvas");
      }
      const beforeHeadingWheel = mapCamera();
      const headingBeforeWheel = styledRect(climateButton());
      const regionBeforeWheel = styledRect(element('.graph-territory-region[data-territory-id="climate"]'));
      const headingWheel = new browser.WheelEvent("wheel", { deltaX: 12.5, deltaY: -27.25, bubbles: true, cancelable: true });
      await act(async () => { climateButton().querySelector("strong").dispatchEvent(headingWheel); });
      await flushFrames();
      assert.equal(headingWheel.defaultPrevented, true, "Two-finger scrolling over a group heading belongs to the map");
      assert.deepEqual(mapCamera(), { ...beforeHeadingWheel, x: beforeHeadingWheel.x - 12.5, y: beforeHeadingWheel.y + 27.25 }, "Group headings pan by the exact wheel delta on both axes");
      for (const [before, after] of [[headingBeforeWheel, styledRect(climateButton())], [regionBeforeWheel, styledRect(element('.graph-territory-region[data-territory-id="climate"]'))]]) {
        assert(Math.abs(after.x - before.x + 12.5) < 0.000001 && Math.abs(after.y - before.y - 27.25) < 0.000001, "Group headings and regions translate with the camera without layout jitter");
        assert.equal(after.width, before.width, "Panning preserves group width");
        assert.equal(after.height, before.height, "Panning preserves group height");
      }
      await act(async () => {
        element('.graph-territory-region[data-territory-id="climate"]').dispatchEvent(new browser.PointerEvent("pointerdown", { pointerId: 81, pointerType: "mouse", button: 0, clientX: 100, clientY: 200, bubbles: true }));
        atlasViewport.dispatchEvent(new browser.PointerEvent("pointermove", { pointerId: 81, pointerType: "mouse", clientX: 140, clientY: 220, bubbles: true }));
        atlasViewport.dispatchEvent(new browser.PointerEvent("pointerup", { pointerId: 81, pointerType: "mouse", clientX: 140, clientY: 220, bubbles: true }));
      });
      await flushFrames();
      assert.equal(climateButton().getAttribute("aria-pressed"), "false", "Dragging a group region pans without entering it");
      await click(element('[aria-label="Zoom out to all groups"]'));
      overviewCamera = mapCamera();
      assertPackedOverview(3, true);
      assert(Math.abs(mapCamera().scale - 0.65) < 1e-6, "The fixture exercises titles at an overview fit below the former .75 cutoff");
      assertAllGroupContents();
      for (let step = 0; mapCamera().scale < 0.8 && step < 30; step++) {
        await act(async () => { atlasViewport.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "+", bubbles: true, cancelable: true })); });
        await flushFrames();
        assert.equal(climateButton().getAttribute('aria-pressed'), 'false', "Zooming through the overview retains every group");
      }
      const beforeBrowsingPan = mapCamera();
      const beforeBrowsingCards = assertAllGroupContents();
      await act(async () => { atlasViewport.dispatchEvent(new browser.WheelEvent("wheel", { deltaX: 31, deltaY: -42, bubbles: true, cancelable: true })); });
      await flushFrames();
      assert.deepEqual(mapCamera(), { ...beforeBrowsingPan, x: beforeBrowsingPan.x - 31, y: beforeBrowsingPan.y + 42 });
      const afterBrowsingCards = assertAllGroupContents();
      afterBrowsingCards.forEach((card, index) => {
        assert(Math.abs(card.x - beforeBrowsingCards[index].x + 31) < 1e-6 && Math.abs(card.y - beforeBrowsingCards[index].y - 42) < 1e-6,
          "Grouped document cards follow camera pan without shifting their layout");
      });
      for (let step = 0; mapCamera().scale >= 0.4 && step < 30; step++) {
        await act(async () => { atlasViewport.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "-", bubbles: true, cancelable: true })); });
        await flushFrames();
        if (mapCamera().scale >= 0.4) assertAllGroupContents();
      }
      assert.equal(element('.conversation-graph-stage').hidden, true, "Document titles hide only after zooming below a readable 8px font");
      assertPackedOverview(3);
      assert.equal(climateButton().getAttribute('aria-pressed'), 'false');
      await click(element('[aria-label="Zoom out to all groups"]'));
      assert.deepEqual(mapCamera(), overviewCamera);
      assertAllGroupContents();
      await click(button("Documents and connections", '.graph-map-view-options button'));
      assert.equal(element('.semantic-map').dataset.mapPresentation, "documents");
      assert.equal(element('.conversation-graph-stage').hidden, false, "Documents view reveals the complete scene at its fitted scale");
      assert.equal(stageCount(), fixtures.length, "Documents view includes members of collapsed groups");
      assert.equal(container.querySelectorAll('.graph-territories, .conversation-graph-group').length, 0,
        "Documents and connections omits group containers and aggregates");
      assert(element('[aria-label="My connection: Tree shade and Water cycles"]'), "The documents view retains saved edges");
      assert.equal(element('.conversation-graph-stage').dataset.documentLayout, "spaced",
        "Widely scattered authored cards get a temporary readable documents layout");
      assertDocumentCards(fixtures.map(([id]) => id), true);
      const documentCenters = () => fixtures.map(([id]) => {
        const node = styledRect(element(`.conversation-graph-node[data-conversation-id="${id}"]`));
        return { x: node.x + node.width / 2, y: node.y + node.height / 2 };
      });
      const initialDocumentCenters = documentCenters();
      const documentsFit = mapCamera();
      const oldDocumentHistory = JSON.parse(browser.sessionStorage.getItem(`margin-graph-location:atlas-${size.width}`)!);
      oldDocumentHistory.present.documentLayoutVersion = 0;
      oldDocumentHistory.present.viewport = { x: -12000, y: -18000, scale: 0.0349 };
      browser.sessionStorage.setItem(`margin-graph-location:atlas-${size.width}`, JSON.stringify(oldDocumentHistory));
      await act(async () => { root.render(null); });
      await renderAtlas();
      atlasViewport = element('.conversation-graph-viewport');
      atlasViewport.setPointerCapture = () => {};
      assert.deepEqual(mapCamera(), documentsFit, "Legacy documents cameras migrate once to the readable temporary layout");
      for (let step = 0; step < 8; step++) {
        await click(element('[aria-label="Zoom out"]'));
        assert.equal(element('.semantic-map').dataset.mapPresentation, "documents", "Zooming documents never switches into group mode");
        assert.equal(element('.conversation-graph-stage').hidden, false, "Documents remain on the canvas at low zoom");
        assertDocumentCards(fixtures.map(([id]) => id));
        documentCenters().forEach((center, index) => {
          assert(Math.abs(center.x - initialDocumentCenters[index].x) < 1e-6 && Math.abs(center.y - initialDocumentCenters[index].y) < 1e-6,
            "Zoom does not rearrange document world positions");
        });
      }
      const documentsCamera = mapCamera();
      assert(documentsCamera.scale < 0.4 && documentsCamera.scale < documentsFit.scale);
      await act(async () => { root.render(null); });
      await renderAtlas();
      atlasViewport = element('.conversation-graph-viewport');
      atlasViewport.setPointerCapture = () => {};
      assert.equal(element('.semantic-map').dataset.mapPresentation, "documents", "The selected map mode survives reopening the map");
      assert.deepEqual(mapCamera(), documentsCamera, "Documents view preserves its saved manual camera");
      await fill('[aria-label="Search this map"]', "Systems thinking");
      await click(element('[aria-label="Map search results"] button'));
      assert.equal(element('.semantic-map').dataset.mapPresentation, "documents", "Searching and reading a document preserves documents mode");
      assert.equal(container.querySelectorAll('.graph-territories').length, 0);
      assert(element('[data-conversation-id="systems"]').classList.contains("is-selected"));
      await click(element('[aria-label="Back in map"]'));
      assert.equal(element('.semantic-map').dataset.mapPresentation, "documents");
      assert.deepEqual(mapCamera(), documentsCamera, "Back from search restores the documents camera");
      await click(element('[aria-label="Zoom out to all groups"]'));
      assert.equal(element('.semantic-map').dataset.mapPresentation, "map", "All groups explicitly returns to the grouped presentation");
      assertPackedOverview(3, true);
      assert.deepEqual(mapCamera(), overviewCamera);
      await click(element('[aria-label="Back in map"]'));
      assert.equal(element('.semantic-map').dataset.mapPresentation, "documents", "History restores the documents-only presentation");
      assert.deepEqual(mapCamera(), documentsCamera);
      await click(element('[aria-label="Forward in map"]'));
      assert.equal(element('.semantic-map').dataset.mapPresentation, "map");
      await act(async () => {
        element('.graph-territory-region[data-territory-id="climate"]').dispatchEvent(new browser.PointerEvent("pointerdown", { pointerId: 82, pointerType: "mouse", button: 0, clientX: 100, clientY: 200, bubbles: true }));
        atlasViewport.dispatchEvent(new browser.PointerEvent("pointerup", { pointerId: 82, pointerType: "mouse", clientX: 100, clientY: 200, bubbles: true }));
      });
      await flushFrames();
      assert.equal(climateButton().getAttribute("aria-pressed"), "true", "Clicking the group region fits its members");
      const groupCamera = mapCamera();
      assert.notDeepEqual(groupCamera, overviewCamera, "Opening a group fits its own member cards");
      assert.equal(stageCount(), 3, "Opening a group isolates its own member cards");
      assert(scopeLabel().startsWith("Climate"), "The toolbar identifies the focused group");
      assert.equal(JSON.parse(browser.sessionStorage.getItem(locationKey)!).present.scope.kind, "all",
        "Spatial group navigation does not turn into a collection filter");
      assert.equal(element('.conversation-graph-stage').hidden, false, "A fitted group reveals nodes even below the usual overview zoom threshold");
      assert.equal(element('.graph-territories').getAttribute("data-territory-mode"), "canvas");
      assert.equal(climateButton().getAttribute("aria-pressed"), "true");
      assert.equal(container.querySelector('.graph-territory-region[data-territory-id="systems"]'), null, "Other colored groups do not overlap the focused container");
      assert.equal(container.querySelector('[data-conversation-id="feedback"]'), null, "Other groups' member cards stay outside the focused view");
      assertClimateFits();
      if (size.width === 390) assert(groupCamera.scale < 0.7, "The mobile fixture exercises a group that needs a low fit scale");

      await act(async () => {
        atlasViewport.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true, cancelable: true }));
        atlasViewport.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "+", bubbles: true, cancelable: true }));
      });
      await flushFrames();
      const manualCamera = mapCamera();
      assert.notDeepEqual(manualCamera, groupCamera, "The fixture preserves a manually changed group camera");
      await act(async () => { root.render(null); });
      await renderAtlas();
      assert.deepEqual(mapCamera(), manualCamera, "Remounting a focused group preserves its saved pan and zoom despite the observer's initial notification");
      assert.equal(climateButton().getAttribute("aria-pressed"), "true");
      await act(async () => {
        canvasWidth = size.width - 40; canvasHeight = size.height - 30;
        resizeNotifications.forEach((notify) => notify());
      });
      await flushFrames();
      assert.notDeepEqual(mapCamera(), manualCamera, "An actual canvas resize still refits a focused group");
      assertClimateFits();
      await act(async () => {
        canvasWidth = size.width; canvasHeight = size.height;
        resizeNotifications.forEach((notify) => notify());
      });
      await flushFrames();
      assert.deepEqual(mapCamera(), groupCamera, "Restoring the canvas size recovers the correct fitted group camera");

      assert.equal(container.querySelector('.graph-group-contents'), null, "Group members are selected directly on the canvas");
      await click(element('[aria-label="Preview Water cycles"]'));
      assert.equal(mapCamera().scale, groupCamera.scale, "Selecting a group member preserves the zoom chosen by group fit");
      assert(element('[data-conversation-id="water"]').classList.contains("is-selected"));
      const selectionCamera = mapCamera();
      await click(element('[aria-label="Zoom out to all groups"]'));
      assert.equal(container.querySelector('.conversation-graph-node.is-selected'), null, "All groups clears the selected card");
      assert.equal(container.querySelector('.conversation-graph-dock'), null, "All groups closes any detail reader");
      assert.equal(climateButton().getAttribute("aria-pressed"), "false", "All groups clears the focused region");
      assert.equal(stageCount(), fixtures.length, "All groups restores the complete map after temporary group spacing");
      assert.deepEqual(mapCamera(), overviewCamera, "All groups restores a fit of the complete map");
      assertPackedOverview(3, true);

      await click(element('[aria-label="Back in map"]'));
      assert.equal(climateButton().getAttribute("aria-pressed"), "true", "Back restores the focused group alongside selection");
      assert(element('[data-conversation-id="water"]').classList.contains("is-selected"));
      assert.deepEqual(mapCamera(), selectionCamera, "Back restores the prior camera without refitting selection");
      await click(element('[aria-label="Back in map"]'));
      assert.equal(container.querySelector('.conversation-graph-node.is-selected'), null);
      assert.deepEqual(mapCamera(), groupCamera, "Back from a node restores its fitted group");
      await click(element('[aria-label="Back in map"]'));
      for (const axis of ["x", "y", "scale"] as const) assert(Math.abs(mapCamera()[axis] - overviewCamera[axis]) < 1e-8,
        "Group entry adds a recoverable map history step");
      await click(element('[aria-label="Forward in map"]'));
      assert.equal(climateButton().getAttribute("aria-pressed"), "true");
      assert.deepEqual(mapCamera(), groupCamera, "Forward restores group focus and its fitted camera together");
      assertClimateFits();

      await click(element('[aria-label="Dock Water cycles in split view"]'));
      assert(element('.conversation-graph-dock').getAttribute("aria-label").includes("Water cycles"));
      await click(element('[aria-label="Zoom out to all groups"]'));
      assert.equal(container.querySelector('.conversation-graph-dock'), null, "Zooming back out closes an open reader");
      assert.deepEqual(mapCamera(), overviewCamera, "Zooming back out from a reader fits the full map");
      await click(element('[aria-label="Back in map"]'));
      assert(element('.conversation-graph-dock').getAttribute("aria-label").includes("Water cycles"), "History can recover the reader closed by All groups");
      assert.equal(climateButton().getAttribute("aria-pressed"), "true");

      const beforeEvidenceCamera = mapCamera();
      await fill('[aria-label="Search this map"]', "Systems thinking");
      await click(element('[aria-label="Map search results"] button'));
      assert(element('[data-conversation-id="systems"]').classList.contains("is-selected"));
      assert(element('.conversation-graph-dock').getAttribute("aria-label").includes("Systems thinking"));
      assert.equal(climateButton().getAttribute("aria-pressed"), "false", "Opening evidence in another group clears the earlier spatial focus");
      assert(!scopeLabel().includes("Climate"), "The navigation label describes the new evidence location");
      assert.equal(button("Fit").textContent, "Fit", "Fit no longer returns to a group the evidence navigation left behind");
      await click(element('[aria-label="Back in map"]'));
      assert.equal(climateButton().getAttribute("aria-pressed"), "true", "Back from external evidence restores the earlier focused group");
      assert.deepEqual(mapCamera(), beforeEvidenceCamera, "Back from external evidence restores the original group camera");

      await click(element('[aria-label="Close Water cycles split view"]'));
      assert(element('[data-conversation-id="water"]').classList.contains("is-selected"), "Closing the reader keeps the spatial selection");
      assert.equal(container.querySelector('.graph-group-contents'), null, "Closing the reader keeps navigation on the canvas");
      await click(element('[aria-label="Preview Water cycles"]'));
      assert(element('.conversation-graph-dock').getAttribute("aria-label").includes("Water cycles"), "Selecting the same compact member reopens its closed reader");

      const zoomViewport = element('.conversation-graph-viewport');
      async function zoomKey(value: string) {
        await act(async () => { zoomViewport.dispatchEvent(new browser.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })); });
        await flushFrames();
      }
      await zoomKey("+");
      await zoomKey("-");
      assert(Math.abs(mapCamera().scale - groupCamera.scale) < 1e-12, "Zooming in and out restores the low fitted scale");
      await zoomKey("-");
      assert.equal(climateButton().getAttribute("aria-pressed"), "true", "A small zoom adjustment keeps group focus");
      await zoomKey("-");
      assert.equal(climateButton().getAttribute("aria-pressed"), "false", "Zooming out beyond the fitted neighborhood returns to the atlas");
      assert.equal(container.querySelector('.conversation-graph-node.is-selected'), null);
      assert.equal(container.querySelector('.conversation-graph-dock'), null);
      assert.equal(element('.graph-territories').getAttribute("data-territory-mode"), "overview");

      await click(climateButton());
      zoomViewport.setPointerCapture = () => {};
      async function touch(type: string, pointerId: number, x: number) {
        await act(async () => { zoomViewport.dispatchEvent(new browser.PointerEvent(type, { pointerId, pointerType: "touch", button: 0, clientX: x, clientY: 200, bubbles: true, cancelable: true })); });
        await flushFrames();
      }
      await touch("pointerdown", 91, 100);
      await touch("pointerdown", 92, 300);
      await touch("pointermove", 92, 240);
      assert.equal(climateButton().getAttribute("aria-pressed"), "false", "Pinching out also leaves the focused group");
      await touch("pointerup", 92, 240);
      await touch("pointerup", 91, 100);
    }
    assert.deepEqual(atlasLayouts, authoredLayouts, "Atlas navigation never mutates authored layout objects");
    assert.equal(layoutWrites.length, 0, "Atlas navigation never persists a rearrangement of the user's map");
  } finally {
    browser.HTMLElement.prototype.getBoundingClientRect = originalRect;
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: originalResizeObserver });
    canvasWidth = 1000; canvasHeight = 700;
  }
}

async function checkDocumentLayoutChoices() {
  const ids = ["tree-root", "tree-child", "tree-leaf", "tree-sibling", "manual-hub", "link-a", "link-b", "link-c", "link-d"];
  const documents = Object.fromEntries(ids.map((id) => {
    const conversation = createMainConversation({ id, createdAt });
    conversation.title = id === "manual-hub" ? "Manual connection hub" : id;
    return [id, conversation];
  }));
  const branches = [["tree-root", "tree-child"], ["tree-child", "tree-leaf"], ["tree-root", "tree-sibling"]];
  for (const [parentId, childId] of branches) {
    documents[parentId].childIds.push(childId);
    documents[childId].parentId = parentId;
  }
  documents["manual-hub"].linkedConversationIds = ["link-a", "link-b", "link-c", "link-d"];
  const authored = Object.fromEntries(ids.map((id, index) => [id,
    createDefaultGraphNodeLayout({ x: index * 5000, y: index % 2 * 16000, positioned: true })]));
  const unchanged = structuredClone(authored);
  const unchangedDocuments = structuredClone(documents);
  const writes: unknown[] = [];
  const key = "document-layout-choices";
  const location = () => JSON.parse(browser.sessionStorage.getItem(`margin-graph-location:${key}`)!).present;
  const originalRect = browser.HTMLElement.prototype.getBoundingClientRect;
  browser.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.classList.contains("conversation-graph-viewport") ? new browser.DOMRect(0, 0, canvasWidth, canvasHeight) : originalRect.call(this);
  };
  const props = {
    key, workspaceKey: key, activeConversationId: "tree-root", conversations: documents, graphLayouts: authored,
    groups: { collection: { id: "collection", name: "Saved collection", color: "#4fbf9f", collapsed: true, conversationIds: ids } },
    onActivateConversation() {}, onAssignGroup(...args: unknown[]) { writes.push({ assignGroup: args }); }, onCreateChildConversation: () => null,
    onOpenConversation() {}, onToggleGroup(...args: unknown[]) { writes.push({ toggleGroup: args }); }, onUpdateGraphNodeLayouts: (updates: unknown) => { writes.push(updates); },
  };
  const unchangedGroups = structuredClone(props.groups);
  async function renderDocuments() {
    await act(async () => { root.render(createElement(ConversationGraphView, props)); });
    await flushFrames();
  }
  const centers = () => Object.fromEntries(ids.map((id) => {
    const box = styledRect(element(`.conversation-graph-node[data-conversation-id="${id}"]`));
    return [id, { x: box.x + box.width / 2, y: box.y + box.height / 2 }];
  }));
  function assertSameCenters(expected: ReturnType<typeof centers>) {
    const current = centers();
    for (const id of ids) assert(Math.abs(current[id].x - expected[id].x) < 1e-6 && Math.abs(current[id].y - expected[id].y) < 1e-6,
      "Camera changes preserve the chosen arrangement's document world centers");
  }
  function assertDocumentScene(mode: string) {
    assert.equal(location().overviewPresentation, "documents");
    assert.equal(location().documentLayoutMode, mode);
    assertDocumentCards(ids);
    assert.equal(container.querySelectorAll('.graph-territories, .conversation-graph-group').length, 0,
      "Changing document layouts never restores group containers");
    assert.equal(container.querySelectorAll('.conversation-graph-edges path[data-child-conversation-id]').length, branches.length,
      "Every branch connection survives document layout changes");
    assert.equal(container.querySelectorAll('.graph-personal-connection').length, 4,
      "Every manually saved connection survives document layout changes");
    assert.equal(writes.length, 0, "Choosing a document layout never persists its temporary positions");
    assert.deepEqual(authored, unchanged);
  }
  const renderedIds = () => [...container.querySelectorAll('.conversation-graph-node[data-conversation-id]')]
    .map((node) => (node as HTMLElement).dataset.conversationId!).sort();
  function assertFocusedDocuments(anchorId: string, depth: number, expectedIds: string[], checkCenter = true) {
    const current = location();
    assert.deepEqual(current.scope, { kind: "focus", conversationId: anchorId, depth });
    assert.equal(current.overviewPresentation, "documents", "Connection focus stays in the document map");
    assert.equal(current.selectedConversationId, anchorId, "The focused document remains selected");
    assert.equal(current.detailLevel, "compact", "Exploration focus keeps document scanning compact");
    assert.equal(current.dockedConversationId, null, "Focusing connections closes any previous reader");
    assert.equal(stageCount(), expectedIds.length);
    assert.deepEqual(renderedIds(), [...expectedIds].sort(), "Focus renders exactly the documents within the requested relationship depth");
    assertDocumentCards(expectedIds, true);
    assert.equal(container.querySelectorAll('.graph-territories, .conversation-graph-group').length, 0,
      "Focused documents do not revive group containers");
    if (checkCenter) {
      assert.equal(element('.conversation-graph-stage').dataset.documentCenterNodeId, anchorId, "The explicit focus overrides the most-connected document");
      const anchorBox = screenRect(element(`.conversation-graph-node[data-conversation-id="${anchorId}"]`));
      assert(Math.abs(anchorBox.x + anchorBox.width / 2 - canvasWidth / 2) < 1e-6
        && Math.abs(anchorBox.y + anchorBox.height / 2 - (canvasHeight / 2 - 20)) < 1e-6,
      "The focused document anchors the radial layout at the map center");
    }
    assert.equal(writes.length, 0, "Focusing, expanding and arranging connections never persist group or coordinate changes");
    assert.deepEqual(authored, unchanged);
    assert.deepEqual(documents, unchangedDocuments, "Subgraph navigation never changes saved ancestry or personal links");
    assert.deepEqual(props.groups, unchangedGroups, "Connection focus never rewrites collection membership or collapse state");
  }
  async function selectDocument(id: string) {
    await click(element(`.conversation-graph-node[data-conversation-id="${id}"] .conversation-graph-node-select`));
  }
  async function chooseLayout(label: string, mode: string) {
    await click(button(label, '.graph-map-layout-options button'));
    assertDocumentScene(mode);
  }
  async function assertEdgeWheelPans(selectors: string[], storageKey = key) {
    const savedHistory = () => JSON.parse(browser.sessionStorage.getItem(`margin-graph-location:${storageKey}`)!);
    for (const selector of selectors) {
      const edgeTarget = element(selector);
      assert.equal(edgeTarget.namespaceURI, "http://www.w3.org/2000/svg", "The wheel regression targets rendered SVG connection geometry");
      const before = mapCamera(), historyBefore = savedHistory();
      const edgeWheel = new browser.WheelEvent("wheel", { deltaX: 14.5, deltaY: -26.25, bubbles: true, cancelable: true });
      await act(async () => { edgeTarget.dispatchEvent(edgeWheel); });
      await flushFrames();
      assert.equal(edgeWheel.defaultPrevented, true, "Two-finger scrolling over an SVG edge belongs to the map");
      assert.deepEqual(mapCamera(), { ...before, x: before.x - 14.5, y: before.y + 26.25 },
        "Branch, manual, and aggregate connection SVG targets pan by the exact wheel delta on both axes");
      const after = savedHistory();
      assert.equal(after.present.selectedConversationId, historyBefore.present.selectedConversationId, "Panning over an edge does not open its source");
      assert.equal(after.present.dockedConversationId, historyBefore.present.dockedConversationId);
      assert.equal(container.querySelector('.graph-map-edge-inspector'), null, "Panning over an edge does not activate its connection inspector");
      assert.equal(after.past.length, historyBefore.past.length, "Scrolling over an edge updates only the camera, not navigation history");
    }
  }
  try {
    await renderDocuments();
    await click(button("Documents and connections", '.graph-map-view-options button'));
    assertDocumentScene("auto");
    await assertEdgeWheelPans(['.conversation-graph-edges .graph-map-edge-hit[data-graph-ui]', '.graph-personal-connection .graph-map-edge-hit', '.graph-personal-connection text']);
    const automaticCenters = centers();
    await chooseLayout("Tree: left to right", "tree-right");
    const rightCenters = centers();
    for (const [parentId, childId] of branches) assert(rightCenters[childId].x > rightCenters[parentId].x,
      "A left-to-right tree places each child beyond its parent horizontally");
    await click(element('[aria-label="Zoom out"]'));
    assert.equal(location().documentLayoutMode, "tree-right", "Manual zoom preserves the selected document layout");
    const rightCamera = mapCamera();
    await chooseLayout("Tree: top down", "tree-down");
    const downCenters = centers(), downCamera = mapCamera();
    for (const [parentId, childId] of branches) assert(downCenters[childId].y > downCenters[parentId].y,
      "A top-down tree places each child below its parent");
    assert.notDeepEqual(downCenters, rightCenters, "The two tree choices produce distinct arrangements");
    await click(element('[aria-label="Back in map"]'));
    assertDocumentScene("tree-right");
    assert.deepEqual(mapCamera(), rightCamera, "Back restores both the tree orientation and its manually adjusted camera");
    assertSameCenters(rightCenters);
    await click(element('[aria-label="Forward in map"]'));
    assertDocumentScene("tree-down");
    assert.deepEqual(mapCamera(), downCamera);

    await chooseLayout("Most connections", "connections");
    assert.equal(element('.conversation-graph-stage').dataset.documentCenterNodeId, "manual-hub");
    const hubBox = screenRect(element('.conversation-graph-node[data-conversation-id="manual-hub"]'));
    assert(Math.abs(hubBox.x + hubBox.width / 2 - canvasWidth / 2) < 1e-6
      && Math.abs(hubBox.y + hubBox.height / 2 - (canvasHeight / 2 - 20)) < 1e-6,
    "The document with four manual neighbors is centered ahead of the branch tree's two-connection nodes");
    const connectedCenters = centers();
    await click(element('[aria-label="Zoom out"]'));
    const connectedCamera = mapCamera();
    assertDocumentScene("connections");
    await act(async () => { root.render(null); });
    await renderDocuments();
    assertDocumentScene("connections");
    assert.deepEqual(mapCamera(), connectedCamera, "Reopening the map restores the most-connected layout and exact camera");
    assertSameCenters(connectedCenters);
    await chooseLayout("Auto layout", "auto");
    assertSameCenters(automaticCenters);
    await click(element('[aria-label="Back in map"]'));
    assertDocumentScene("connections");
    assert.deepEqual(mapCamera(), connectedCamera);
    assert.equal(writes.length, 0);

    await selectDocument("link-a");
    const beforeFocus = structuredClone(location());
    await click(button("Focus connections", '.conversation-graph-zoom button'));
    assertFocusedDocuments("link-a", 1, ["link-a", "manual-hub"]);
    assert.equal(container.querySelectorAll('.graph-personal-connection').length, 1, "Focusing a link's target includes its incoming saved relationship");
    assert.equal(container.querySelectorAll('.conversation-graph-edges path[data-child-conversation-id]').length, 0,
      "The disconnected branch tree does not leak into a manual neighborhood");
    const incomingFocusCamera = mapCamera();
    await click(element('[aria-label="Back in map"]'));
    assert.deepEqual(location().scope, beforeFocus.scope);
    assert.equal(location().selectedConversationId, beforeFocus.selectedConversationId);
    assert.equal(location().dockedConversationId, beforeFocus.dockedConversationId, "Back restores the reader that was open before focusing");
    assert.deepEqual(mapCamera(), beforeFocus.viewport, "Back restores the exact pre-focus camera");
    await click(element('[aria-label="Forward in map"]'));
    assertFocusedDocuments("link-a", 1, ["link-a", "manual-hub"]);
    assert.deepEqual(mapCamera(), incomingFocusCamera, "Forward restores the explicit center and exact focus camera");

    await selectDocument("manual-hub");
    assertFocusedDocuments("manual-hub", 1, ["manual-hub", "link-a", "link-b", "link-c", "link-d"]);
    assert.equal(container.querySelectorAll('.graph-personal-connection').length, 4, "Pivoting to the hub exposes all four direct saved connections");
    assert.equal(button("Show more connections").disabled, true, "A complete connected component does not offer an empty expansion");
    await selectDocument("link-b");
    assertFocusedDocuments("link-b", 1, ["manual-hub", "link-b"]);
    await click(button("Show more connections"));
    assertFocusedDocuments("link-b", 2, ["manual-hub", "link-a", "link-b", "link-c", "link-d"]);
    await click(button("Tree: top down", '.graph-map-layout-options button'));
    assert.equal(location().documentLayoutMode, "tree-down", "Arrange remains available within a focused neighborhood");
    assertFocusedDocuments("link-b", 2, ["manual-hub", "link-a", "link-b", "link-c", "link-d"], false);
    await click(button("Around focused node", '.graph-map-layout-options button'));
    assertFocusedDocuments("link-b", 2, ["manual-hub", "link-a", "link-b", "link-c", "link-d"]);
    const focusedCenters = Object.fromEntries(renderedIds().map((id) => [id, styledRect(element(`.conversation-graph-node[data-conversation-id="${id}"]`))]));
    const focusWheel = new browser.WheelEvent("wheel", { deltaX: 12.5, deltaY: -18.25, bubbles: true, cancelable: true });
    await act(async () => { element('.conversation-graph-viewport').dispatchEvent(focusWheel); });
    await flushFrames();
    const manuallyPannedFocus = mapCamera();
    await click(button("All nodes"));
    assert.deepEqual(location().scope, { kind: "all" }, "All nodes exits only the neighborhood scope");
    assert.equal(location().overviewPresentation, "documents", "All nodes returns to document exploration");
    assert.equal(stageCount(), ids.length);
    assert.equal(location().selectedConversationId, null);
    assert.equal(container.querySelectorAll('.graph-territories, .conversation-graph-group').length, 0);
    await click(element('[aria-label="Back in map"]'));
    assert.deepEqual(location().scope, { kind: "focus", conversationId: "link-b", depth: 2 });
    assert.deepEqual(mapCamera(), manuallyPannedFocus, "Back from All nodes restores the exact manually panned subgraph camera");
    assert.deepEqual(Object.fromEntries(renderedIds().map((id) => [id, styledRect(element(`.conversation-graph-node[data-conversation-id="${id}"]`))])), focusedCenters,
      "Back restores the same temporary document arrangement");
    await act(async () => { root.render(null); });
    await renderDocuments();
    assert.deepEqual(location().scope, { kind: "focus", conversationId: "link-b", depth: 2 });
    assert.equal(element('.conversation-graph-stage').dataset.documentCenterNodeId, "link-b");
    assert.deepEqual(mapCamera(), manuallyPannedFocus, "Remount preserves subgraph center, depth and manual camera");
    await click(button("All nodes"));

    await selectDocument("tree-leaf");
    await click(button("Focus connections", '.conversation-graph-zoom button'));
    assertFocusedDocuments("tree-leaf", 1, ["tree-leaf", "tree-child"]);
    assert.equal(container.querySelector('[data-conversation-id="tree-root"]'), null, "Breadcrumb ancestors do not bypass the map's one-hop boundary");
    await click(button("Show more connections"));
    assertFocusedDocuments("tree-leaf", 2, ["tree-leaf", "tree-child", "tree-root"]);
    await click(button("Show more connections"));
    assertFocusedDocuments("tree-leaf", 3, ["tree-leaf", "tree-child", "tree-root", "tree-sibling"]);
    await selectDocument("tree-root");
    assertFocusedDocuments("tree-root", 3, ["tree-leaf", "tree-child", "tree-root", "tree-sibling"]);
    await click(button("All nodes"));
    assert.equal(writes.length, 0);
    assert.deepEqual(authored, unchanged);
    assert.deepEqual(documents, unchangedDocuments);
    console.log("Personal connection subgraphs preserve strict neighborhoods, inbound links, anchor, pivot depth, arrangement, history, and remount camera.");

    const aggregateKey = "aggregate-edge-pan";
    browser.sessionStorage.setItem(`margin-graph-location:${aggregateKey}`, JSON.stringify({ ...location(),
      overviewPresentation: "canvas", selectedConversationId: "tree-root", detailLevel: "compact", viewport: { x: 40, y: 80, scale: 1 } }));
    await act(async () => { root.render(createElement(ConversationGraphView, { ...props, key: aggregateKey, workspaceKey: aggregateKey,
      graphLayouts: Object.fromEntries(ids.map((id, index) => [id, createDefaultGraphNodeLayout({ x: index % 3 * 340, y: Math.floor(index / 3) * 220, positioned: true })])),
      groups: { collection: { ...props.groups.collection, conversationIds: ["tree-child", "tree-leaf"] } },
    })); });
    await flushFrames();
    assert.equal(element('.conversation-graph-stage').hidden, false, "The aggregate-edge fixture displays its collapsed branch group on the canvas");
    await assertEdgeWheelPans(['.graph-map-aggregate-edge .graph-map-edge-hit', '.graph-map-aggregate-edge text'], aggregateKey);
  } finally {
    browser.HTMLElement.prototype.getBoundingClientRect = originalRect;
  }
}

async function checkSparseMapPresentation() {
  const sparseConversations = Object.fromEntries(["first", "second"].map((id) => {
    const note = createStandaloneNoteConversation({ id: `sparse-${id}`, noteId: `${id}-note`, createdAt });
    note.title = `Sparse ${id}`;
    return [note.id, note];
  }));
  const sparseLayouts = {
    "sparse-first": createDefaultGraphNodeLayout({ x: 0, y: 0, positioned: true }),
    "sparse-second": createDefaultGraphNodeLayout({ x: 0, y: 1000, positioned: true }),
  };
  const props = {
    key: "sparse-map", workspaceKey: "sparse-map", activeConversationId: "sparse-first",
    conversations: sparseConversations, groups: {}, graphLayouts: sparseLayouts,
    onActivateConversation() {}, onAssignGroup() {}, onCreateChildConversation: () => null,
    onOpenConversation() {}, onToggleGroup() {},
  };
  async function renderSparse(related = false) {
    await act(async () => { root.render(createElement(ConversationGraphView, {
      ...props, relatedStatus: related ? "ready" : "off",
      relatedItems: related ? [{ id: "sparse-second", score: 0.8 }] : [],
    })); });
    await flushFrames();
  }
  async function zoomToTitles() {
    for (let step = 0; element('.semantic-map').dataset.mapScale === "groups" && step < 30; step++) {
      await click(element('[aria-label="Zoom in"]'));
    }
  }
  await renderSparse();
  const fittedCamera = element(".conversation-graph-stage").style.transform;
  assert.equal(element('.semantic-map').dataset.mapScale, "titles", "Fitting a few distant notes keeps individual titles discoverable");
  assert.equal(element(".conversation-graph-stage").hidden, false);
  assert.equal(container.querySelector('.graph-territories[data-territory-mode="overview"]'), null);
  assert.equal(container.querySelector(".graph-map-filters"), null, "A map with no available filters does not offer an empty menu");
  await click(element('[aria-label="Zoom out to all groups"]'));
  assert.equal(element('.semantic-map').dataset.mapScale, "groups", "All groups opens the aggregate overview");
  assert.equal(element(".conversation-graph-stage").hidden, true);
  assert(element('.graph-territory').textContent.includes("2 chats and notes"));
  await zoomToTitles();
  await click(button("Fit"));
  assert.equal(element('.semantic-map').dataset.mapScale, "titles");
  assert.equal(element(".conversation-graph-stage").style.transform, fittedCamera, "Fit restores the complete authored extent without changing node positions");
  await act(async () => { root.render(null); });
  await renderSparse();
  assert.equal(element('.semantic-map').dataset.mapScale, "titles", "Returning to a fitted sparse map preserves its title presentation");
  await renderSparse(true);
  assert(element('.graph-map-filters input[type="checkbox"]'), "Available related suggestions reveal a usable filter");
  await renderSparse();
  await click(element('[aria-label="Preview Sparse first"]'));
  await click(element('[aria-label="Explore map collections and sources"]'));
  await click(button("Focus neighborhood"));
  assert(button("Show more connections"), "Connection expansion remains discoverable in focused maps");
}

async function checkVeryWideMapZoom() {
  const wideConversations: Record<string, Conversation> = {};
  const wideLayouts: Record<string, GraphNodeLayout> = {};
  for (const [index, x] of [-10_000_000, 0, 10_000_000].entries()) {
    const id = `wide-${index}`;
    const note = createStandaloneNoteConversation({ id, noteId: `${id}-body`, createdAt });
    note.title = `Wide source ${index}`;
    wideConversations[id] = note;
    wideLayouts[id] = createDefaultGraphNodeLayout({ x, y: 0, positioned: true });
  }
  await act(async () => {
    root.render(createElement(ConversationGraphView, {
      key: "very-wide-map", workspaceKey: "very-wide-map", activeConversationId: "wide-0",
      conversations: wideConversations, graphLayouts: wideLayouts,
      groups: { wide: { id: "wide", name: "Wide research", color: "#4fbf9f", collapsed: false, conversationIds: Object.keys(wideConversations) } },
      onActivateConversation() {}, onAssignGroup() {}, onCreateChildConversation: () => null,
      onOpenConversation() {}, onToggleGroup() {},
    }));
  });
  await flushFrames();
  await click(element('[aria-label="Explore Wide research, 3 chats and notes"]'));
  const fitted = mapCamera();
  assert(fitted.scale < 0.001, "The wide fixture needs a fit below the former culling floor");
  assert.equal(container.querySelectorAll('[data-conversation-id]').length, 3, "Every in-frame node remains mounted at a tiny fit scale");
  const viewport = element('.conversation-graph-viewport');
  async function zoom(value: string) {
    await act(async () => { viewport.dispatchEvent(new browser.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })); });
    await flushFrames();
  }
  await zoom("+");
  assert(mapCamera().scale > fitted.scale, "A useful zoom step is applied even when its scale delta is below 0.001");
  await zoom("-");
  assert(Math.abs(mapCamera().scale - fitted.scale) < 1e-12, "The same low fit scale remains reachable after zooming in");
  await zoom("-");
  await zoom("-");
  assert.equal(element('[aria-label="Explore Wide research, 3 chats and notes"]').getAttribute("aria-pressed"), "false", "Very low manual zoom can still leave the fitted group");
  assert.equal(element('.graph-territories').getAttribute("data-territory-mode"), "overview");
}

async function checkTallDenseGroupZoom() {
  const tallConversations: Record<string, Conversation> = {};
  const tallLayouts: Record<string, GraphNodeLayout> = {};
  const layoutWrites: Array<Record<string, Partial<GraphNodeLayout>>> = [];
  for (let index = 0; index < 33; index++) {
    const id = `tall-${index}`;
    const note = createStandaloneNoteConversation({ id, noteId: `${id}-body`, createdAt });
    note.title = index < 8 ? `Coding source ${index + 1}` : `Other source ${index + 1}`;
    tallConversations[id] = note;
    const y = index < 7 ? index * 90 : index === 7 ? 20374 : 800 + (index - 8) / 24 * 20442;
    tallLayouts[id] = createDefaultGraphNodeLayout({ x: index % 2 * 982, y, positioned: true });
  }
  const savedLayouts = structuredClone(tallLayouts);
  const previousSize = { width: canvasWidth, height: canvasHeight };
  const originalRect = browser.HTMLElement.prototype.getBoundingClientRect;
  const originalResizeObserver = globalThis.ResizeObserver;
  const resizeNotifications = new Set<() => void>();
  class GroupResizeObserver {
    private active = false;
    constructor(private callback: ResizeObserverCallback) {}
    notify = () => { if (this.active) this.callback([], this as unknown as ResizeObserver); };
    observe() { this.active = true; resizeNotifications.add(this.notify); queueMicrotask(this.notify); }
    unobserve() { this.disconnect(); }
    disconnect() { this.active = false; resizeNotifications.delete(this.notify); }
  }
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: GroupResizeObserver });
  browser.HTMLElement.prototype.getBoundingClientRect = function () {
    return this.classList.contains("conversation-graph-viewport") ? new browser.DOMRect(0, 0, canvasWidth, canvasHeight) : originalRect.call(this);
  };
  async function resizeGroup(width: number) {
    await act(async () => { canvasWidth = width; resizeNotifications.forEach((notify) => notify()); });
    await flushFrames();
  }
  function assertSelectedCardVisible() {
    const box = screenRect(element('.conversation-graph-node[data-conversation-id="tall-2"]'));
    assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= canvasWidth && box.y + box.height <= canvasHeight,
      `The selected card remains fully visible after the group reflows: ${JSON.stringify({ ...box, canvasWidth, canvasHeight })}`);
    return assertReadableGroupCards([...container.querySelectorAll('.conversation-graph-node')].map((node) => node.getAttribute("data-conversation-id")!));
  }
  try {
    canvasWidth = 753; canvasHeight = 623;
    await act(async () => {
      root.render(createElement(ConversationGraphView, {
        key: "tall-dense-map", workspaceKey: "tall-dense-map", activeConversationId: "tall-0",
        conversations: tallConversations, graphLayouts: tallLayouts,
        groups: { coding: { id: "coding", name: "Coding", color: "#4fbf9f", collapsed: false,
          conversationIds: Array.from({ length: 8 }, (_, index) => `tall-${index}`) } },
        onActivateConversation() {}, onAssignGroup() {}, onCreateChildConversation: () => null,
        onOpenConversation() {}, onToggleGroup() {},
        onUpdateGraphNodeLayouts: (updates) => { layoutWrites.push(structuredClone(updates)); },
      }));
    });
    await flushFrames();
    const groupButton = () => element('[aria-label="Explore Coding, 8 chats and notes"]');
    await click(groupButton());
    const fittedCamera = mapCamera(), fittedScale = fittedCamera.scale;
    assert.equal(element('.conversation-graph-stage').dataset.groupLayout, "spaced", "A tall, crowded group temporarily spaces its actual cards");
    assert(scopeLabel().startsWith("Coding"), "The toolbar identifies the temporarily spaced group");
    assert.equal(JSON.parse(browser.sessionStorage.getItem('margin-graph-location:tall-dense-map')!).present.scope.kind, "all",
      "Temporary group spacing does not change the collection filter");
    const memberIds = Array.from({ length: 8 }, (_, index) => `tall-${index}`);
    const boxes = assertReadableGroupCards(memberIds);
    assert.equal(new Set(boxes.map((box) => Math.round(box.x))).size, 3, "The resize fixture starts with three card columns");
    boxes.forEach((box) => assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= canvasWidth && box.y + box.height <= canvasHeight,
      "Eight dense-group cards fit together on the available desktop canvas"));
    await click(element('[aria-label="Preview Coding source 3"]'));
    assert(element('.conversation-graph-dock').getAttribute("aria-label").includes("Coding source 3"));
    await resizeGroup(365);
    assert.equal(mapCamera().scale, fittedScale, "Opening a reader preserves zoom while the group changes from three columns to one");
    const narrowBoxes = assertSelectedCardVisible();
    assert.equal(new Set(narrowBoxes.map((box) => Math.round(box.x))).size, 1, "Opening the reader reflows the group into one readable column");
    await click(element('[aria-label="Close Coding source 3 split view"]'));
    await resizeGroup(753);
    assert.equal(mapCamera().scale, fittedScale, "Closing the reader preserves the selected group's zoom");
    assertSelectedCardVisible();
    await click(button("Fit group"));
    assert.deepEqual(mapCamera(), fittedCamera, "Fit group restores the original group camera after the reader closes");
    for (let step = 0; step < 3; step++) {
      const before = mapCamera().scale;
      await click(element('[aria-label="Zoom out"]'));
      if (groupButton().getAttribute("aria-pressed") === "true") assert(mapCamera().scale < before,
        "Zoom-out decreases the scale while still inside the focused group");
    }
    assert.equal(groupButton().getAttribute("aria-pressed"), "false", "Manual zoom can leave a very tall dense group");
    assert.equal(element('.graph-territories').getAttribute("data-territory-mode"), "overview");
    assert.equal(container.querySelector('.conversation-graph-dock'), null);
    assert.equal(container.querySelector('.conversation-graph-node.is-selected'), null);
    await click(element('[aria-label="Zoom out to all groups"]'));
    assertPackedOverview(2, true);
    assert.equal(stageCount(), 33, "All groups restores every source to the map");
    assert.equal(element('.conversation-graph-stage').dataset.groupLayout, undefined);
    await click(button("Documents and connections", '.graph-map-view-options button'));
    assert.equal(element('.conversation-graph-stage').dataset.documentLayout, "spaced");
    assert(mapCamera().scale >= 0.5, "An outlying saved document cannot force an unreadable initial document fit");
    const allIds = Object.keys(tallConversations);
    assertDocumentCards(allIds, true);
    const documentsScale = mapCamera().scale;
    await click(element('[aria-label="Preview Coding source 3"]'));
    await resizeGroup(365);
    assert.equal(mapCamera().scale, documentsScale, "Opening a document reader preserves the camera scale after reflow");
    assertDocumentCards([...container.querySelectorAll('.conversation-graph-node')].map((node) => node.getAttribute('data-conversation-id')!));
    const selectedDocument = screenRect(element('.conversation-graph-node[data-conversation-id="tall-2"]'));
    assert(selectedDocument.x >= 0 && selectedDocument.y >= 0 && selectedDocument.x + selectedDocument.width <= canvasWidth
      && selectedDocument.y + selectedDocument.height <= canvasHeight, "The document selected for reading stays visible beside its reader");
    await click(element('[aria-label="Close Coding source 3 split view"]'));
    await resizeGroup(753);
    await resizeGroup(390);
    await click(button("Documents and connections", '.graph-map-view-options button'));
    const phoneDocumentsFit = mapCamera();
    assert(phoneDocumentsFit.scale >= 0.5, "A phone opens documents with readable title cards and a pannable extent");
    await act(async () => { element('.conversation-graph-viewport').dispatchEvent(new browser.WheelEvent('wheel', {
      deltaY: 400, bubbles: true, cancelable: true,
    })); });
    await flushFrames();
    const lastDocument = screenRect(element('.conversation-graph-node[data-conversation-id="tall-32"]'));
    assert(lastDocument.y >= 0 && lastDocument.y + lastDocument.height <= canvasHeight - 55,
      "Ordinary panning reaches documents below the initial phone frame");
    await click(button("Fit"));
    assert.deepEqual(mapCamera(), phoneDocumentsFit, "Fit returns the phone document grid to its first row");
    assert.deepEqual(tallLayouts, savedLayouts, "Packed overview leaves every saved card position unchanged, including cards culled offscreen");
    assert.deepEqual(layoutWrites, [], "Entering and leaving a dense group never saves temporary node positions");
  } finally {
    canvasWidth = previousSize.width; canvasHeight = previousSize.height;
    browser.HTMLElement.prototype.getBoundingClientRect = originalRect;
    Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: originalResizeObserver });
  }
}

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
  const cameraBeforeSelection = element(".conversation-graph-stage").style.transform;
  await click(element('[aria-label="Preview Dense center"]'));
  assert.equal(element(".conversation-graph-stage").style.transform, cameraBeforeSelection, "Selecting a nearby card preserves the user's camera and zoom");
  let previewPositions = positions();
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
  const inlineReader = element('[data-graph-reader-scroll]');
  Object.defineProperty(inlineReader, "scrollHeight", { configurable: true, value: 1400 });
  inlineReader.scrollTop = 100;
  const cameraBeforeReaderScroll = mapCamera();
  for (const deltaY of [40, -40]) {
    const readerWheel = new browser.WheelEvent("wheel", { deltaY, bubbles: true, cancelable: true });
    await act(async () => { inlineReader.querySelector("p").dispatchEvent(readerWheel); });
    await flushFrames();
    assert.equal(readerWheel.defaultPrevented, false, "An inline reader with scrollable content keeps vertical wheel events");
    assert.deepEqual(mapCamera(), cameraBeforeReaderScroll, "Scrolling reader content does not move the map behind it");
  }

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
  // Reading changes the zoom; compare repeated previews at the same scale.
  previewPositions = positions();
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

  function camera() {
    const parts = element(".conversation-graph-stage").style.transform.match(/translate\(([-.\d]+)px, ([-.\d]+)px\) scale\(([-.\d]+)\)/);
    assert(parts);
    return { x: Number(parts[1]), y: Number(parts[2]), scale: Number(parts[3]) };
  }
  async function key(target: any, value: string) {
    await act(async () => { target.dispatchEvent(new browser.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true })); });
    await flushFrames();
  }
  await click(button("Fit"));
  const fit = camera();
  assert.equal(viewport.tabIndex, 0, "The canvas can receive keyboard focus");
  await key(viewport, "ArrowRight");
  assert.equal(camera().x, fit.x - 60);
  await key(viewport, "+");
  assert(camera().scale > fit.scale, "The canvas zooms from the keyboard");
  await key(element('[aria-label="Preview Dense center"]'), "ArrowRight");
  const beforeIgnoredKey = camera();
  await key(element('[aria-label="Preview Dense center"]'), "+");
  assert.deepEqual(camera(), beforeIgnoredKey, "Map shortcuts do not override focused node controls");
  await key(viewport, "Home");
  assert.equal(element('.conversation-graph-stage').hidden, true, "Home opens the all-groups overview");
  assertPackedOverview(1, true);
  for (let step = 0; element('.semantic-map').dataset.mapScale === "groups" && step < 30; step++) {
    await click(element('[aria-label="Zoom in"]'));
  }
  await click(button("Fit"));
  assert.deepEqual(camera(), fit, "Returning to titles restores the authored-card fit");

  async function touch(target: any, type: string, pointerId: number, clientX: number, clientY: number) {
    await act(async () => { target.dispatchEvent(new browser.PointerEvent(type, { pointerId, pointerType: "touch", button: 0, clientX, clientY, bubbles: true, cancelable: true })); });
    await flushFrames();
  }
  const node = element('[aria-label="Preview Dense center"]');
  await touch(node, "pointerdown", 41, 100, 200);
  await touch(node, "pointerdown", 42, 200, 200);
  await touch(viewport, "pointermove", 42, 300, 200);
  assert.equal(camera().scale, fit.scale * 2, "Two touches starting on a node zoom the map");
  await touch(viewport, "pointerup", 42, 300, 200);
  const afterPinch = camera();
  await touch(viewport, "pointermove", 41, 120, 210);
  await touch(viewport, "pointerup", 41, 120, 210);
  assert.deepEqual(camera(), { ...afterPinch, x: afterPinch.x + 20, y: afterPinch.y + 10 }, "The remaining finger continues panning without a camera jump");
  await act(async () => { node.dispatchEvent(new browser.MouseEvent("click", { bubbles: true, cancelable: true, detail: 1 })); });
  await flushFrames();
  assert.equal(container.querySelector(".conversation-graph-node.is-selected"), null, "Completing a pinch cannot accidentally select its starting node");
  assert.deepEqual(positions(), originalPositions, "Pinching never moves authored nodes");

  await click(element('[aria-label="Dock Dense center in split view"]'));
  const splitter = element('[aria-label="Resize docked chat"]');
  const widthBefore = Number(splitter.getAttribute("aria-valuenow"));
  await key(splitter, "ArrowLeft");
  assert.equal(Number(splitter.getAttribute("aria-valuenow")), widthBefore + 24, "The desktop reader can be widened with the keyboard");
  await key(splitter, "Home");
  assert.equal(Number(splitter.getAttribute("aria-valuenow")), 280);
  await click(element('[aria-label="Collapse docked chat"]'));
  assert.equal(element('[aria-label="Expand docked chat"]').getAttribute("aria-expanded"), "false");
  assert(element('.conversation-graph-dock').classList.contains("is-collapsed"), "The mobile reader can collapse without losing the selected discussion");
  await click(element('[aria-label="Expand docked chat"]'));
  assert.equal(element('[aria-label="Collapse docked chat"]').getAttribute("aria-expanded"), "true");
}

try {
  await render();
  assert.equal(stageCount(), 61);
  assert.equal(element('.semantic-map').dataset.mapPresentation, 'map', 'A large map starts in its grouped presentation');
  assert.equal(container.querySelectorAll('.graph-territory').length, 3);
  assertPackedOverview(3, true);
  await click(button("Show themes"));
  assert.equal(element(".graph-overview-canvas h2").textContent, "Your ideas, connected", "The optional themes view remains available");
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
  await click(element('[aria-label="Zoom out to all groups"]'));
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
  await click(button("Focus here", '.conversation-graph-node button'));
  assert(scopeLabel().startsWith("Around Hidden branch"));
  assert.equal(stageCount(), 3, "Initial focus contains parents and immediate children");
  await click(button("Show more connections"));
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
  await checkSparseMapPresentation();
  await checkAtlasCanvasNavigation();
  await checkDocumentLayoutChoices();
  await checkVeryWideMapZoom();
  await checkTallDenseGroupZoom();
  console.log("Graph concept, source, search, scope, focus, history, account-isolation, and atlas navigation checks passed.");
} finally {
  await act(async () => { root.unmount(); });
  await browser.happyDOM.close();
}
