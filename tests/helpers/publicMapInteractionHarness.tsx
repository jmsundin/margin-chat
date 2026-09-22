import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { AppState } from "../../client/src/types";

const browser = new Window({ url: "http://public-map-interactions.test/" });
for (const name of ["window", "document", "navigator", "localStorage", "sessionStorage", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "ResizeObserver", "DOMRect"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
let canvasWidth = 1000;
let canvasHeight = 700;
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
Object.defineProperties(browser.HTMLElement.prototype, {
  clientWidth: { configurable: true, get: () => canvasWidth },
  clientHeight: { configurable: true, get: () => canvasHeight },
});
browser.HTMLElement.prototype.getBoundingClientRect = () => new browser.DOMRect(0, 0, canvasWidth, canvasHeight);
const pointerCaptures = new Map<number, any>();
browser.HTMLElement.prototype.setPointerCapture = function (id: number) { pointerCaptures.set(id, this); };
browser.HTMLElement.prototype.hasPointerCapture = function (id: number) { return pointerCaptures.get(id) === this; };
browser.HTMLElement.prototype.releasePointerCapture = function (id: number) {
  if (!this.hasPointerCapture(id)) return;
  pointerCaptures.delete(id);
  this.dispatchEvent(new browser.PointerEvent("lostpointercapture", { pointerId: id, bubbles: true }));
};
let frameId = 0;
const frames = new Map<number, FrameRequestCallback>();
browser.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
browser.cancelAnimationFrame = (id) => { frames.delete(id); };

// Only this isolated test replaces network reads. Production still uses Wikimedia APIs.
const apiCalls: URL[] = [];
let delayNextEngineeringRead = false;
let delayedOpen: { release(): void; signal: AbortSignal | null | undefined } | null = null;
function entity(id: string) {
  const labels: Record<string, string> = { Q990001: "Systems thinking", Q990002: "Feedback", Q990003: "Cybernetics", Q990004: "Category:Systems thinking", Q11023: "Engineering", P279: "subclass of", P361: "part of", P910: "topic's main category" };
  const links = id === "Q990001" ? { P279: ["Q990002"], P361: ["Q990002"], P910: ["Q990004"] }
    : id === "Q990002" ? { P279: ["Q990003"] } : {};
  return {
    id, type: id.startsWith("Q") ? "item" : "property", lastrevid: 123,
    labels: { en: { language: "en", value: labels[id] ?? id } },
    descriptions: { en: { language: "en", value: `A deterministic public description for ${labels[id] ?? id}.` } },
    sitelinks: id.startsWith("Q") ? { enwiki: { title: labels[id] } } : {},
    claims: Object.fromEntries(Object.entries(links).map(([propertyId, targetIds]) => [propertyId, targetIds!.map((targetId) => ({ rank: "normal", mainsnak: {
      snaktype: "value", datatype: "wikibase-item", datavalue: { type: "wikibase-entityid", value: { "entity-type": "item", id: targetId } },
    } }))])),
  };
}
globalThis.fetch = (async (input, init) => {
  const url = new URL(String(input));
  assert.equal(url.origin + url.pathname, "https://www.wikidata.org/w/api.php", "The component only makes expected public API reads");
  assert.equal(init?.credentials, "omit");
  apiCalls.push(url);
  if (url.searchParams.get("action") === "wbsearchentities") {
    assert.equal(url.searchParams.get("search"), "systems");
    return Response.json({ search: [{ id: "Q990001" }] });
  }
  assert.equal(url.searchParams.get("action"), "wbgetentities");
  if (delayNextEngineeringRead && url.searchParams.get("ids") === "Q11023") {
    delayNextEngineeringRead = false;
    return new Promise<Response>((resolve) => {
      delayedOpen = { signal: init?.signal, release() { resolve(Response.json({ entities: { Q11023: entity("Q11023") } })); } };
    });
  }
  return Response.json({ entities: Object.fromEntries(url.searchParams.get("ids")!.split("|").map((id) => [id, entity(id)])) });
}) as typeof fetch;

const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: KnowledgeGraphWorkspace } = await import("../../client/src/components/KnowledgeGraphWorkspace");
const { createEmptyState } = await import("../../client/src/initialState");
const { buildThreadSummaries } = await import("../../client/src/lib/conversationSearch");
const { savePublicTopic } = await import("../../client/src/lib/publicTopicWorkspace");
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const accounts = new Map<string, AppState>();
let account = "public-map-account-a";
let createdCount = 0;
function initialState() {
  const state = createEmptyState();
  state.conversations[state.rootId].title = "Private research";
  state.conversations[state.rootId].messages = [{ id: "private-message", role: "assistant", content: "My personal evidence and reading context.", createdAt: "2026-09-20T00:00:00.000Z" }];
  return state;
}
function Workspace() {
  const [state, setState] = useState(() => accounts.get(account) ?? initialState());
  accounts.set(account, state);
  const reader = (id: string) => createElement("article", { className: "chat-panel", "data-reader-id": id },
    createElement("div", { className: "panel-body" }, state.conversations[id].notes?.[0]?.content || state.conversations[id].messages[0]?.content || "Your personal note."));
  return createElement(KnowledgeGraphWorkspace, {
    workspaceKey: account, activeConversationId: state.activeConversationId,
    conversations: state.conversations, groups: state.groups, graphLayouts: state.graphLayouts,
    threads: buildThreadSummaries(state.conversations),
    onSavePublicTopic(topic) {
      setState((previous) => {
        const result = savePublicTopic(previous, topic);
        if (result.created) createdCount++;
        return result.state;
      });
    },
    onActivateConversation(id) { setState((previous) => ({ ...previous, activeConversationId: id })); },
    onCreateMapNote() {}, onSetMapConnection() {}, onRemoveMapNote() {}, onUndoMapEdit() {},
    onAssignGroup() {}, onCreateChildConversation: () => null, onOpenConversation() {}, onToggleGroup() {},
    renderDockedConversation: reader, renderExpandedConversation: reader,
  });
}
async function flushFrames() {
  for (let iteration = 0; frames.size && iteration < 20; iteration++) {
    const callbacks = [...frames.values()]; frames.clear();
    await act(async () => { callbacks.forEach((callback) => callback(0)); });
  }
  assert.equal(frames.size, 0, "Rendering settles without a frame loop");
}
async function render() { await act(async () => { root.render(createElement(Workspace, { key: account })); }); await flushFrames(); }
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
async function key(target: any, value: string, shiftKey = false) { await act(async () => { target.dispatchEvent(new browser.KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true })); }); await flushFrames(); }
async function pointer(target: any, type: string, pointerId: number, clientX: number, clientY: number, pointerType = "touch") {
  await act(async () => {
    target.dispatchEvent(new browser.PointerEvent(type, { pointerId, pointerType, button: 0, clientX, clientY, bubbles: true, cancelable: true }));
    if (type === "pointerup" || type === "pointercancel") pointerCaptures.get(pointerId)?.releasePointerCapture(pointerId);
  });
  await flushFrames();
}
async function setRelationship(value: string) {
  await act(async () => {
    const select = element(".public-map-filters select");
    select.value = value;
    select.dispatchEvent(new browser.Event("change", { bubbles: true }));
  });
  await flushFrames();
}
function camera() {
  const transform = element(".public-map-stage").style.transform;
  const match = transform.match(/^translate\(([-\d.e]+)px, ([-\d.e]+)px\) scale\(([-\d.e]+)\)$/);
  assert(match, `Unexpected camera transform: ${transform}`);
  return { x: Number(match[1]), y: Number(match[2]), scale: Number(match[3]) };
}
function near(actual: number, expected: number, message: string) { assert(Math.abs(actual - expected) < 0.000001, `${message}: ${actual} vs ${expected}`); }
function styledRect(node: HTMLElement) {
  return { x: parseFloat(node.style.left), y: parseFloat(node.style.top), width: parseFloat(node.style.width), height: parseFloat(node.style.height) };
}
function assertPackedPublicOverview(expectedGroups: number, inViewport = false) {
  const layer = element('.public-knowledge-map .graph-territories[data-territory-mode="overview"]');
  const regions = [...layer.querySelectorAll('.graph-territory-region')] as HTMLElement[];
  assert.equal(regions.length, expectedGroups, "The public overview has one colored container per group");
  assert.equal(layer.querySelectorAll('.graph-territory-skeleton, .graph-territory-node, .is-group-marker, .graph-territory-links circle, .graph-territory-links rect').length, 0,
    "The public overview has named group boxes without miniature topic nodes");
  regions.forEach((region, index) => {
    const box = styledRect(region);
    const heading = layer.querySelector(`button[data-territory-id="${region.dataset.territoryId}"]`) as HTMLElement;
    assert(heading?.querySelector('strong')?.textContent?.trim(), "Every public group container has a readable name");
    const label = styledRect(heading);
    assert(label.x >= box.x && label.y >= box.y && label.x + label.width <= box.x + box.width && label.y + label.height <= box.y + box.height,
      "Public group headings stay inside their colored containers");
    if (inViewport) assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= canvasWidth && box.y + box.height <= canvasHeight,
      "All groups fits the public group containers inside the available canvas");
    for (const other of regions.slice(index + 1).map(styledRect)) {
      assert(box.x + box.width < other.x || other.x + other.width < box.x || box.y + box.height < other.y || other.y + other.height < box.y,
        "Sibling public group containers have space between them");
    }
  });
}
function publicScreenRect(node: HTMLElement) {
  const bounds = styledRect(node), viewport = camera();
  const factor = Number(node.style.transform.match(/scale\(([-.\de]+)\)/)?.[1] ?? 1);
  return { x: viewport.x + (bounds.x + bounds.width * (1 - factor) / 2) * viewport.scale,
    y: viewport.y + (bounds.y + bounds.height * (1 - factor) / 2) * viewport.scale,
    width: bounds.width * factor * viewport.scale, height: bounds.height * factor * viewport.scale };
}
function assertPublicCurveTouchesCards(sourceLabel: string, targetLabel: string) {
  const path = element('.public-map-edges g > path');
  const data = path.getAttribute('d');
  assert(data.includes('C') && !data.includes('L'), "Public connections use cubic Bézier paths");
  assert.equal(path.getAttribute('marker-end'), 'url(#public-map-arrow)', "Curved public connections retain directional arrowheads");
  const values = data.match(/-?\d+(?:\.\d+)?(?:e[+-]?\d+)?/gi).map(Number);
  assert.equal(values.length, 8, "A public edge has one cubic segment");
  const view = camera();
  function touches(label: string, x: number, y: number) {
    const bounds = publicScreenRect(element(`.public-map-node[aria-label="${label}"]`));
    const sx = view.x + x * view.scale, sy = view.y + y * view.scale;
    const onVerticalFace = (Math.abs(sx - bounds.x) < 0.001 || Math.abs(sx - bounds.x - bounds.width) < 0.001) && sy >= bounds.y - 0.001 && sy <= bounds.y + bounds.height + 0.001;
    const onHorizontalFace = (Math.abs(sy - bounds.y) < 0.001 || Math.abs(sy - bounds.y - bounds.height) < 0.001) && sx >= bounds.x - 0.001 && sx <= bounds.x + bounds.width + 0.001;
    assert(onVerticalFace || onHorizontalFace, `${label}'s curve attaches to its actual visible card face`);
  }
  touches(sourceLabel, values[0], values[1]);
  touches(targetLabel, values[6], values[7]);
  const label = container.querySelector('.public-map-edges g text');
  if (label) {
    near(Number(label.getAttribute('x')), (values[0] + 3 * values[2] + 3 * values[4] + values[6]) / 8, "A relation label follows the curve midpoint horizontally");
    near(Number(label.getAttribute('y')) + 8, (values[1] + 3 * values[3] + 3 * values[5] + values[7]) / 8, "A relation label follows the curve midpoint vertically");
  }
}
function assertReadablePublicGroupCards(labels: string[]) {
  assert.equal(container.querySelector('.graph-group-contents'), null, "Public groups use canvas cards without a contents overlay");
  assert.equal(container.querySelector('.is-group-marker'), null, "Public group members remain named cards instead of numbered markers");
  const regions = [...container.querySelectorAll('.public-knowledge-map .graph-territory-region')];
  assert.equal(regions.length, 1, "The focused public group has one colored container");
  const region = styledRect(regions[0] as unknown as HTMLElement);
  const boxes = labels.map((label) => publicScreenRect(element(`.public-map-node[aria-label="${label}"]`)));
  boxes.forEach((box, index) => {
    assert(box.width >= 139 && box.height >= 87, "Temporarily spaced public cards retain a readable size");
    assert(box.x >= region.x && box.y >= region.y && box.x + box.width <= region.x + region.width && box.y + box.height <= region.y + region.height,
      "Each focused topic card stays inside its colored group");
    for (const other of boxes.slice(index + 1)) {
      assert(box.x + box.width <= other.x || other.x + other.width <= box.x || box.y + box.height <= other.y || other.y + other.height <= box.y,
        "Temporarily spaced public group cards do not overlap");
    }
  });
  return boxes;
}
function assertPublicBrowseCards(groups: { id: string; labels: string[] }[]) {
  assertPackedPublicOverview(groups.length);
  assert.equal(element('.public-map-stage').dataset.presentation, "groups", "Manual zoom keeps the grouped canvas presentation");
  assert.equal(container.querySelectorAll('.public-knowledge-map .graph-territory[aria-pressed="true"]').length, 0,
    "Revealing group contents never chooses a focused neighborhood");
  const expectedCount = groups.reduce((count, group) => count + group.labels.length, 0);
  assert.equal(container.querySelectorAll('.public-map-node').length, expectedCount, "Manual zoom reveals members from every group");
  for (const group of groups) {
    const region = styledRect(element(`.public-knowledge-map .graph-territory-region[data-territory-id="${group.id}"]`));
    const headingElement = element(`.public-knowledge-map button.graph-territory[data-territory-id="${group.id}"]`);
    const heading = styledRect(headingElement);
    assert.equal(headingElement.classList.contains('is-distant'), camera().scale < 0.5,
      "Distant group headings simplify before their count can crowd the document titles");
    assert(headingElement.getAttribute('aria-label').includes(`${group.labels.length} topics`), "Simplified headings retain their accessible topic count");
    const boxes = group.labels.map((label) => {
      const node = element(`.public-map-node[aria-label="${label}"]`);
      near(parseFloat(node.style.getPropertyValue('--map-card-title-size')), Math.min(13, 20 * camera().scale),
        "Grouped document titles shrink gradually with zoom until their legibility limit");
      return publicScreenRect(node);
    });
    boxes.forEach((box, index) => {
      assert(box.width >= 71 && box.height >= 38, "Grouped topics remain visible while their projected titles are readable");
      assert(box.x >= region.x && box.y >= region.y && box.x + box.width <= region.x + region.width && box.y + box.height <= region.y + region.height,
        "Each revealed topic stays inside its own colored group");
      assert(box.y >= heading.y + heading.height, "Group headings never overlap readable topic titles as the map zooms out");
      for (const other of boxes.slice(index + 1)) assert(box.x + box.width <= other.x || other.x + other.width <= box.x || box.y + box.height <= other.y || other.y + other.height <= box.y,
        "Revealed topic title cards do not overlap");
    });
  }
}
function assertPublicBrowseVisibility(memberCount: number, message: string) {
  assert.equal(element('.public-map-stage').dataset.presentation, "groups", message);
  const readable = camera().scale >= 0.4;
  assert.equal(element('.public-map-stage').hidden, !readable, "Group titles disappear only below their legibility threshold");
  assert.equal(container.querySelectorAll('.public-map-node').length, readable ? memberCount : 0,
    "Grouped browsing renders named cards only while their titles remain readable");
}
async function zoomPublicTo(scale: number) {
  const event = new browser.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: -Math.log(scale / camera().scale) / 0.008 });
  // Happy DOM does not currently implement WheelEvent's inherited mouse modifiers.
  Object.defineProperties(event, { ctrlKey: { value: true }, clientX: { value: canvasWidth / 2 }, clientY: { value: canvasHeight / 2 } });
  await act(async () => { element('.public-map-viewport').dispatchEvent(event); });
  await flushFrames();
}
async function resizePublicGroup(width: number) {
  await act(async () => { canvasWidth = width; resizeNotifications.forEach((notify) => notify()); });
  await flushFrames();
}
function selectedTopic() { return container.querySelector(".public-map-node.is-selected strong")?.textContent; }
function publicNode(label: string) { return element(`.public-map-node[aria-label="${label}"] .public-map-node-body`); }
async function settle(milliseconds = 20) { await act(async () => { await new Promise((resolve) => setTimeout(resolve, milliseconds)); }); await flushFrames(); }
async function fillSearch() {
  await act(async () => {
    const input = element("#public-topic-search");
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, "systems");
    input.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  await settle(360);
}
function personalNode() { return element('[data-conversation-id="public-topic-Q990001"]'); }
function personalHistory() { return JSON.parse(browser.sessionStorage.getItem(`margin-graph-location:${account}`)!).present; }
function publicPanel() { return element(".public-knowledge-map").closest(".knowledge-map-panel"); }
function personalPanel() { return element(".conversation-graph-stage").closest(".knowledge-map-panel"); }
function assertMode(mode: "public" | "personal") {
  assert.equal(publicPanel().hidden, mode !== "public");
  assert.equal(personalPanel().hidden, mode !== "personal");
}
function savedCount() { return Object.values(accounts.get(account)!.conversations).filter((conversation) => conversation.publicTopic).length; }

try {
  await render();
  await click(button("Public", ".knowledge-map-switcher button"));
  assertMode("public");
  await fillSearch();
  assert.equal(container.querySelectorAll('.graph-map-search-results button strong').length, 1, "Live search plumbing renders the fixed API topic in the visible search popover");
  await key(element("#public-topic-search"), "ArrowDown");
  assert.equal(browser.document.activeElement, element(".graph-map-search-results button"), "Arrow Down moves from search to its first result");
  await key(browser.document.activeElement, "Escape");
  assert.equal(container.querySelector(".graph-map-search-results"), null, "Escape dismisses search results");
  assert.equal(browser.document.activeElement, element("#public-topic-search"), "Dismissing search returns keyboard focus to the input");
  assert.equal(element("#public-topic-search").value, "systems", "Dismissing results preserves the query");
  await act(async () => { element(".public-map-search").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })); });
  await settle(360);
  await click(element(".graph-map-search-results button"));
  await settle();
  assert.equal(container.querySelectorAll(".public-map-node").length, 2, "Opening a topic loads its bounded neighborhood");
  assert.equal(element(".public-map-node.is-selected strong").textContent, "Systems thinking");
  assert.equal(savedCount(), 0, "Public exploration alone never adds workspace data");
  assertPublicCurveTouchesCards("Systems thinking", "Feedback");

  for (const selector of ['.public-map-edges > g path', '.public-map-edges > g text']) {
    const edgeTarget = element(selector);
    assert.equal(edgeTarget.namespaceURI, "http://www.w3.org/2000/svg");
    const before = camera();
    const edgeWheel = new browser.WheelEvent("wheel", { deltaX: -18.5, deltaY: 29.25, bubbles: true, cancelable: true });
    await act(async () => { edgeTarget.dispatchEvent(edgeWheel); });
    await flushFrames();
    assert.equal(edgeWheel.defaultPrevented, true, "Scrolling over public SVG edges belongs to the map");
    assert.deepEqual(camera(), { ...before, x: before.x + 18.5, y: before.y - 29.25 }, "Public edge paths and labels pan by the exact wheel delta");
    assert.equal(selectedTopic(), "Systems thinking", "Scrolling over a public connection never selects another topic");
    assert.equal(container.querySelector('.public-map-details-dock'), null, "Public edge scrolling does not open details");
  }

  const viewport = element(".public-map-viewport");
  await click(button("Fit map", ".public-map-zoom button"));
  const fittedCamera = camera();
  await click(publicNode("Feedback"));
  assert.equal(selectedTopic(), "Feedback");
  assert.deepEqual(camera(), fittedCamera, "Selecting a nearby fully visible topic preserves camera and zoom");
  await key(viewport, "ArrowRight");
  const feedbackCamera = camera();
  assert.equal(feedbackCamera.x, fittedCamera.x - 60, "Arrow keys pan the focused map canvas");
  await click(element('[aria-label="Back in public map"]'));
  assert.equal(selectedTopic(), "Systems thinking");
  assert.deepEqual(camera(), fittedCamera, "Back restores the previous topic and camera");
  await click(element('[aria-label="Forward in public map"]'));
  assert.equal(selectedTopic(), "Feedback");
  assert.deepEqual(camera(), feedbackCamera, "Forward restores the topic and its panned camera");
  await click(element('[aria-label="Back in public map"]'));
  await key(viewport, "+");
  near(camera().scale, fittedCamera.scale * 1.2, "Plus zooms the canvas");
  await key(viewport, "-");
  near(camera().scale, fittedCamera.scale, "Minus reverses the zoom step");
  await key(publicNode("Systems thinking"), "ArrowLeft");
  const beforeControlKey = camera();
  await key(publicNode("Systems thinking"), "+");
  assert.deepEqual(camera(), beforeControlKey, "Canvas shortcuts do not steal keys from focused topic controls");
  await key(viewport, "Home");
  const keyboardOverviewCamera = camera();
  assertPublicBrowseVisibility(2, "Home returns to the all-groups overview");
  assert.equal(selectedTopic(), undefined, "Home clears the individual topic selection");
  await key(viewport, "ArrowUp", true);
  assert.equal(camera().y, keyboardOverviewCamera.y + 120, "Shift-arrow provides a larger canvas pan");
  await key(viewport, "0");
  assert.deepEqual(camera(), keyboardOverviewCamera, "Zero also restores the all-groups overview");
  await click(element('[aria-label="Back in public map"]'));
  await click(element('[aria-label="Back in public map"]'));
  for (const key of ["x", "y", "scale"] as const) assert(Math.abs(camera()[key] - fittedCamera[key]) < 1e-8,
    "Shortcut navigation keeps the previously selected topic and camera in history");
  await key(publicNode("Systems thinking"), "ArrowRight");
  assert.equal(browser.document.activeElement, publicNode("Feedback"), "Arrow keys on a topic move keyboard focus to its spatial neighbor");
  assert.equal(selectedTopic(), "Systems thinking", "Moving keyboard focus does not change the selected topic");

  const networkBeforeFilters = apiCalls.length;
  assert.equal(container.querySelector('.public-map-node[aria-label="Category:Systems thinking"]'), null, "Wikimedia category pages are hidden by default");
  assert(element(".public-map-context").textContent.includes("1 filtered"));
  await setRelationship("types");
  assert.equal(container.querySelectorAll(".public-map-node").length, 2);
  assert.equal(container.querySelectorAll(".public-map-edges g").length, 1, "Types shows only the classification relationship");
  await setRelationship("parts");
  assert.equal(container.querySelectorAll(".public-map-node").length, 2);
  assert.equal(element(".public-map-edges g text").textContent, "part of");
  await key(viewport, "ArrowDown");
  const partsCamera = camera();
  await setRelationship("other");
  assert.equal(container.querySelectorAll(".public-map-node").length, 1, "A filter with no matching connections keeps the root available");
  await key(viewport, "ArrowLeft");
  const otherCamera = camera();
  await click(element('[aria-label="Back in public map"]'));
  assert.equal(element(".public-map-filters select").value, "parts");
  assert.deepEqual(camera(), partsCamera, "Back restores a relationship filter and its camera");
  await click(element('[aria-label="Forward in public map"]'));
  assert.equal(element(".public-map-filters select").value, "other");
  assert.deepEqual(camera(), otherCamera, "Forward restores the filtered view and its camera");
  await click(element('.public-map-filters input[type="checkbox"]'));
  assert(element('.public-map-node[aria-label="Category:Systems thinking"]'), "Metadata can be explicitly revealed");
  assert.equal(container.querySelectorAll(".public-map-node").length, 2);
  await setRelationship("all");
  assert.equal(container.querySelectorAll(".public-map-node").length, 3, "All loaded neighbors return when filters allow them");
  await click(element('.public-map-filters input[type="checkbox"]'));
  assert.equal(container.querySelectorAll(".public-map-node").length, 2);
  assert.equal(apiCalls.length, networkBeforeFilters, "Relationship and metadata filters restore loaded data without new requests");

  await key(viewport, "Escape");
  await click(button("Explore", ".public-map-topbar button"));
  delayNextEngineeringRead = true;
  await click(element(".public-map-seeds button"));
  assert(delayedOpen, "The new seed's read is pending while existing topics remain usable");
  await click(publicNode("Systems thinking"));
  const cameraAfterNewSelection = camera();
  assert.equal((delayedOpen as { signal: AbortSignal }).signal.aborted, true, "Selecting a known topic cancels the older opening request");
  await act(async () => { (delayedOpen as { release(): void }).release(); });
  await settle();
  assert.equal(selectedTopic(), "Systems thinking", "A late opening response cannot replace a newer selection");
  assert.deepEqual(camera(), cameraAfterNewSelection);
  assert.equal(container.querySelector('.public-map-node[aria-label="Engineering"]'), null);
  await click(element('[aria-label="Close explorer"]'));
  console.log("Public nearby selection, keyboard camera controls, history, and reversible relationship filters passed.");

  await click(button("Fit map", ".public-map-zoom button"));
  await key(viewport, "-");
  const beforePinch = camera();
  await pointer(publicNode("Feedback"), "pointerdown", 51, 100, 200);
  await pointer(publicNode("Feedback"), "pointerdown", 52, 300, 200);
  assert.equal(pointerCaptures.get(51), viewport);
  assert.equal(pointerCaptures.get(52), viewport, "The viewport captures both contacts when a pinch begins on a topic");
  await act(async () => { publicNode("Feedback").dispatchEvent(new browser.PointerEvent("lostpointercapture", { pointerId: 51, pointerType: "touch", bubbles: true })); });
  assert.equal(pointerCaptures.size, 2, "Transferring implicit node capture to the viewport does not cancel a pinch");
  await pointer(viewport, "pointerdown", 56, 500, 200);
  await pointer(viewport, "pointerup", 56, 500, 200);
  assert.equal(pointerCaptures.size, 2, "An ignored third contact ending does not release the pinch contacts");
  await pointer(viewport, "pointerdown", 56, 500, 200);
  await pointer(viewport, "pointercancel", 56, 500, 200);
  assert.equal(pointerCaptures.size, 2, "Cancelling an ignored third contact also leaves the active pinch intact");
  await pointer(viewport, "pointermove", 52, 400, 240);
  const pinchScale = Math.min(1.6, beforePinch.scale * Math.hypot(300, 40) / 200);
  near(camera().scale, pinchScale, "Actual touch contacts control scale");
  near(camera().x, 250 - (200 - beforePinch.x) * pinchScale / beforePinch.scale, "Pinch keeps the map point beneath the moving horizontal midpoint");
  near(camera().y, 220 - (200 - beforePinch.y) * pinchScale / beforePinch.scale, "Pinch keeps the map point beneath the moving vertical midpoint");
  await pointer(viewport, "pointerup", 52, 400, 240);
  assert.equal(pointerCaptures.has(52), false);
  const afterPinch = camera();
  await pointer(viewport, "pointermove", 51, 130, 215);
  assert.deepEqual(camera(), { ...afterPinch, x: afterPinch.x + 30, y: afterPinch.y + 15 }, "The remaining finger pans smoothly without jumping");
  await pointer(viewport, "pointerup", 51, 130, 215);
  assert.equal(pointerCaptures.size, 0, "Ending the gesture releases both pointer captures");
  const beforeGestureClick = selectedTopic();
  await click(publicNode("Feedback"));
  assert.equal(selectedTopic(), beforeGestureClick, "The click following a pinch does not activate its starting topic");
  assert.equal(viewport.classList.contains("is-panning"), false);
  await pointer(viewport, "pointerdown", 53, 150, 250);
  await pointer(viewport, "pointermove", 53, 180, 270);
  await pointer(viewport, "pointercancel", 53, 180, 270);
  const cancelledCamera = camera();
  await pointer(viewport, "pointermove", 53, 250, 320);
  assert.deepEqual(camera(), cancelledCamera, "Cancelled contacts cannot keep moving the map");
  assert.equal(viewport.classList.contains("is-panning"), false);
  assert.equal(pointerCaptures.size, 0);
  await click(viewport); // Consume the cancelled drag's synthetic click.
  for (const termination of ["pointercancel", "lostpointercapture"]) {
    await pointer(viewport, "pointerdown", 54, 100, 200);
    await pointer(viewport, "pointerdown", 55, 300, 200);
    assert.equal(pointerCaptures.size, 2);
    if (termination === "pointercancel") await pointer(viewport, termination, 54, 100, 200);
    else {
      await act(async () => { viewport.releasePointerCapture(54); });
      await flushFrames();
    }
    assert.equal(pointerCaptures.size, 0, `${termination} releases the other active pinch contact too`);
    const afterTermination = camera();
    await pointer(viewport, "pointermove", 55, 350, 250);
    assert.deepEqual(camera(), afterTermination, `${termination} ends all gesture motion`);
    assert.equal(viewport.classList.contains("is-panning"), false);
    await click(viewport);
  }
  await click(button("Fit map", ".public-map-zoom button"));
  console.log("Public touch midpoint zoom, continued panning, tap suppression, and pointer cleanup passed.");

  await click(element('[aria-label="Details and sources for Systems thinking"]'));
  assert.equal(browser.document.activeElement, element(".public-map-sidebar-scroll"), "Opening topic details focuses the scrollable explorer");
  assert(element('.public-map-sources a[href="https://www.wikidata.org/wiki/Q990001"]'), "Details expose the selected topic's source");
  const beforeReaderWheel = camera();
  const readerWheel = new browser.WheelEvent("wheel", { deltaY: 40, bubbles: true, cancelable: true });
  await act(async () => { element('.public-map-sidebar-scroll').dispatchEvent(readerWheel); });
  await flushFrames();
  assert.equal(readerWheel.defaultPrevented, false, "Public details retain native scrolling");
  assert.deepEqual(camera(), beforeReaderWheel, "Scrolling public details does not pan the canvas");
  await click(element(".public-map-sheet-toggle"));
  assert(element(".public-map-details-dock").classList.contains("is-collapsed"));
  assert.equal(element(".public-map-sheet-toggle").getAttribute("aria-expanded"), "false");
  assert.equal(element(".public-map-viewport"), viewport, "Collapsing details keeps the original canvas mounted");
  await click(element(".public-map-sheet-toggle"));
  assert.equal(element(".public-map-details-dock").classList.contains("is-collapsed"), false);
  const resizer = element('[aria-label="Resize public map details"]');
  const initialWidth = Number(resizer.getAttribute("aria-valuenow"));
  await key(resizer, "ArrowLeft");
  assert.equal(Number(resizer.getAttribute("aria-valuenow")), initialWidth + 24, "The details dock resizes from its keyboard separator");
  await key(resizer, "Home");
  assert.equal(Number(resizer.getAttribute("aria-valuenow")), 260);
  await pointer(resizer, "pointerdown", 61, 600, 200, "mouse");
  await pointer(resizer, "pointermove", 61, 530, 200, "mouse");
  assert.equal(Number(resizer.getAttribute("aria-valuenow")), 330, "Dragging the dock boundary changes its width");
  await pointer(resizer, "pointerup", 61, 530, 200, "mouse");
  await pointer(resizer, "pointermove", 61, 500, 200, "mouse");
  assert.equal(Number(resizer.getAttribute("aria-valuenow")), 330, "Releasing the separator stops resizing");
  assert.equal(pointerCaptures.size, 0);
  await pointer(resizer, "pointerdown", 62, 600, 200, "mouse");
  await pointer(resizer, "pointermove", 62, 590, 200, "mouse");
  await act(async () => { resizer.releasePointerCapture(62); });
  await pointer(resizer, "pointermove", 62, 520, 200, "mouse");
  assert.equal(Number(resizer.getAttribute("aria-valuenow")), 340, "Losing pointer capture also ends details resizing");
  console.log("Public details collapse and keyboard/pointer resizing passed.");
  await click(element(".public-map-relations button"));
  assert.equal(element(".public-map-inspector h3").textContent, "Feedback", "Following a relationship updates the inspector");
  assert(element(".public-map-details-dock"), "Following connections keeps the explorer open");
  assert.equal(element(".public-map-relations button strong").textContent, "Systems thinking", "Incoming connections name the topic their button will open");
  await click(element(".public-map-relations button"));
  await key(element(".public-map-sidebar-scroll"), "Escape");
  assert.equal(container.querySelector(".public-map-details-dock"), null, "Escape closes the explorer");
  assert.equal(browser.document.activeElement, button("Explore", ".public-map-topbar button"), "Closing details restores focus to Explore");
  const anchor = element('.public-map-node[aria-label="Systems thinking"]');
  const anchorPosition = { left: anchor.style.left, top: anchor.style.top };
  await click(element('[aria-label="Expand Feedback"]'));
  await settle();
  assert.equal(container.querySelectorAll(".public-map-node").length, 3, "The top-right Expand action adds the next direct neighborhood");
  assert.deepEqual({ left: anchor.style.left, top: anchor.style.top }, anchorPosition, "Expansion keeps the established anchor stable");
  assert(apiCalls.some((url) => url.searchParams.get("ids") === "Q990002" && url.searchParams.get("props")?.includes("claims")), "Expansion requests the selected topic’s statements");

  await click(element('[aria-label="Add Systems thinking to my map"]'));
  assertMode("public");
  assert.equal(savedCount(), 1, "Adding saves only the chosen public topic");
  assert.equal(createdCount, 1);
  assert(element('[aria-label="Show Systems thinking in my map"]'), "The saved action remains clickable and becomes Show in my map");
  await click(button("Explore", ".public-map-topbar button"));
  assert.equal(element(".public-map-inspector .public-map-primary").textContent, "Show in my map");
  await click(element('[aria-label="Show Systems thinking in my map"]'));
  assertMode("personal");
  assert.equal(savedCount(), 1, "Showing an existing topic does not duplicate it");
  assert(personalNode().classList.contains("is-selected"));
  assert.equal(accounts.get(account)!.activeConversationId, "public-topic-Q990001");

  await click(element('[aria-label="Expand Systems thinking"]'));
  assert.equal(personalHistory().detailLevel, "reader");
  element('.conversation-graph-node.is-reader .panel-body').scrollTop = 180;
  await click(element('.knowledge-map-panel:not([hidden]) [aria-label="Zoom in"]'));
  const beforePublic = structuredClone(personalHistory());
  const personalTransform = element(".conversation-graph-stage").style.transform;
  await click(element('[aria-label="Explore Systems thinking in public map"]'));
  await settle();
  assertMode("public");
  assert.equal(container.querySelectorAll(".public-map-node").length, 3, "Returning to a known topic restores its public neighborhood");
  assert.equal(element(".public-map-node.is-selected strong").textContent, "Systems thinking");
  await act(async () => { element(".public-map-viewport").dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true })); });
  await flushFrames();
  assert.equal(personalHistory().detailLevel, "reader", "Escape in Public cannot collapse the hidden personal reader");
  assert.equal(personalHistory().selectedConversationId, beforePublic.selectedConversationId, "Hidden personal selection stays intact");
  assert.deepEqual(personalHistory().viewport, beforePublic.viewport, "Public keyboard actions cannot alter the hidden personal camera");
  await click(button("Back to my map", ".knowledge-map-switcher button"));
  assertMode("personal");
  assert.equal(personalHistory().detailLevel, "reader", "Back restores the same personal reader mode");
  assert(personalNode().classList.contains("is-selected"));
  assert.equal(element('.conversation-graph-node.is-reader .panel-body').scrollTop, 180, "Back retains the personal reader’s scroll position");
  assert.equal(element(".conversation-graph-stage").style.transform, personalTransform, "Back restores the camera instead of fitting the map again");

  await click(element('[aria-label="Explore Systems thinking in public map"]'));
  await settle();
  await click(element('[aria-label="Show Systems thinking in my map"]'));
  assert.equal(savedCount(), 1);
  assert.equal(createdCount, 1, "Repeated cross-map navigation continues to reuse the same saved node");
  await settle(330);
  account = "public-map-account-b";
  await render();
  assert.equal(savedCount(), 0, "A different account receives no saved topics");
  await click(button("Public", ".knowledge-map-switcher button"));
  assert.equal(container.querySelectorAll(".public-map-node").length, 0, "Public exploration locations are scoped to the account");
  await fillSearch();
  await click(element(".graph-map-search-results button"));
  await settle();
  assert(element('[aria-label="Add Systems thinking to my map"]'), "Public API caching cannot leak another account’s saved badge");
  assert.equal(container.querySelector(".public-map-node.is-saved"), null);
  account = "public-map-account-a";
  await render();
  assert.equal(savedCount(), 1);
  await click(button("Public", ".knowledge-map-switcher button"));
  assert.equal(container.querySelectorAll(".public-map-node").length, 3, "Returning to the original account restores its own public view");
  assert(element('[aria-label="Show Systems thinking in my map"]'));
  console.log("Public search, expansion, save, existing identity, return navigation, and account isolation passed.");

  const { addPublicGraphRoot, appendPublicGraphExpansion, emptyPublicGraph } = await import("../../client/src/lib/publicGraphScene");
  const atlasTopic = (id: string, label: string) => ({ id, label, description: `Explore ${label}.`, aliases: [], wikidataUrl: `https://www.wikidata.org/wiki/${id}`, retrievedAt: "2026-09-21T00:00:00.000Z" });
  const atlasRoot = atlasTopic("Q880001", "Atlas neighborhood");
  const atlasNeighbors = Array.from({ length: 24 }, (_, index) => atlasTopic(`Q${880010 + index}`, `Atlas topic ${index + 1}`));
  let atlasGraph = addPublicGraphRoot(emptyPublicGraph(), atlasRoot);
  atlasGraph = appendPublicGraphExpansion(atlasGraph, { topic: atlasRoot, topics: atlasNeighbors, hasMore: false, nextOffset: 24,
    relations: atlasNeighbors.map((topic) => ({ id: `Q880001:P279:${topic.id}`, sourceId: atlasRoot.id, targetId: topic.id, propertyId: "P279", label: "subclass of", sourceUrl: atlasRoot.wikidataUrl })) });
  atlasNeighbors.forEach((topic, index) => { atlasGraph.positions[topic.id] = { x: (index % 6 + 1) * 360, y: (Math.floor(index / 6) - 2) * 270 }; });
  atlasGraph = addPublicGraphRoot(atlasGraph, atlasTopic("Q880099", "Distant neighborhood"));
  atlasGraph.positions.Q880099 = { x: 8000, y: 0 };
  account = "public-map-atlas";
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: GroupResizeObserver });
  browser.sessionStorage.setItem(`margin-public-map:${account}`, JSON.stringify({ version: 1, graph: atlasGraph, selectedId: null, viewport: { x: 60, y: 200, scale: 0.1 }, query: "", filters: { relation: "types", includeMetadata: false } }));
  await render();
  await click(button("Public", ".knowledge-map-switcher button"));
  const groupButton = () => element('.public-knowledge-map [aria-label="Explore Atlas neighborhood, 25 topics"]');
  assertPublicBrowseVisibility(26, "The distant view starts in the grouped map");
  assertPackedPublicOverview(2);
  const atlasViewport = element(".public-map-viewport");
  const beforeHeadingWheel = camera();
  const headingBeforeWheel = styledRect(groupButton());
  const regionBeforeWheel = styledRect(element('.public-knowledge-map .graph-territory-region[data-territory-id="Q880001"]'));
  const headingWheel = new browser.WheelEvent("wheel", { deltaX: 12.5, deltaY: -27.25, bubbles: true, cancelable: true });
  await act(async () => { groupButton().querySelector("strong").dispatchEvent(headingWheel); });
  await flushFrames();
  assert.equal(headingWheel.defaultPrevented, true, "Two-finger scrolling over a public group heading belongs to the map");
  assert.deepEqual(camera(), { ...beforeHeadingWheel, x: beforeHeadingWheel.x - 12.5, y: beforeHeadingWheel.y + 27.25 }, "Public group headings pan by the exact wheel delta on both axes");
  for (const [before, after] of [[headingBeforeWheel, styledRect(groupButton())], [regionBeforeWheel, styledRect(element('.public-knowledge-map .graph-territory-region[data-territory-id="Q880001"]'))]]) {
    near(after.x, before.x - 12.5, "Public group headings and regions pan horizontally with the camera");
    near(after.y, before.y + 27.25, "Public group headings and regions pan vertically with the camera");
    assert.equal(after.width, before.width, "Panning preserves public group width");
    assert.equal(after.height, before.height, "Panning preserves public group height");
  }
  const beforeControlWheel = camera();
  await act(async () => { element('.public-map-filters select').dispatchEvent(new browser.WheelEvent("wheel", { deltaX: 14, deltaY: 27, bubbles: true, cancelable: true })); });
  await flushFrames();
  assert.deepEqual(camera(), beforeControlWheel, "Scrolling public-map toolbar controls does not pan the canvas");
  const overviewRegion = element('.public-knowledge-map .graph-territory-region[data-territory-id="Q880001"]');
  const beforeRegionPan = camera();
  await pointer(overviewRegion, "pointerdown", 71, 200, 250, "mouse");
  await pointer(atlasViewport, "pointermove", 71, 240, 270, "mouse");
  await pointer(atlasViewport, "pointerup", 71, 240, 270, "mouse");
  assertPublicBrowseVisibility(26, "Dragging an overview region pans without entering the group");
  assert.deepEqual(camera(), { ...beforeRegionPan, x: beforeRegionPan.x + 40, y: beforeRegionPan.y + 20 });
  await click(atlasViewport); // Consume the drag's synthesized click.
  const overviewCamera = camera();
  const beforeGroupReads = apiCalls.length;
  await pointer(overviewRegion, "pointerdown", 72, 200, 250, "mouse");
  await pointer(atlasViewport, "pointerup", 72, 200, 250, "mouse");
  const neighborhoodCamera = camera();
  assert(neighborhoodCamera.scale > overviewCamera.scale && neighborhoodCamera.scale < 0.7, "The group fits its full bounds even when it is too large for title-scale zoom");
  assert.equal(element(".public-map-stage").hidden, false, "Fitting a large group reveals its member nodes below the usual overview threshold");
  assert.equal(element('.public-map-stage').dataset.groupLayout, "spaced", "Crowded public groups temporarily space their named cards");
  assert.equal(container.querySelectorAll(".public-map-node.is-compact").length, 25, "Temporary group spacing shows every member in the focused neighborhood");
  assert.equal(container.querySelector('.public-map-node[aria-label="Distant neighborhood"]'), null, "The focused public group excludes unrelated member cards");
  assert.equal(container.querySelector('.public-knowledge-map .graph-territory-region[data-territory-id="Q880099"]'), null, "Other public groups do not overlap the focused container");
  assert(groupButton(), "The group region stays available behind the canvas nodes");
  assert(button("Fit group", ".public-map-zoom button"), "The fit action names the current neighborhood scope");
  const atlasTopics = [atlasRoot, ...atlasNeighbors];
  assertReadablePublicGroupCards(atlasTopics.map((topic) => topic.label));
  await click(publicNode("Atlas topic 1"));
  assert.equal(camera().scale, neighborhoodCamera.scale, "Opening a topic inside a fitted group never changes zoom");
  assert.equal(element(".public-map-inspector h3").textContent, "Atlas topic 1", "Compact topic selection opens its details");
  const selectedCamera = camera();
  await click(button("All groups", ".public-map-topbar button"));
  const allGroupsCamera = camera();
  assert(allGroupsCamera.scale < neighborhoodCamera.scale, "All groups fits the distant neighborhood as well");
  assertPublicBrowseVisibility(26, "All groups returns to the grouped map");
  assertPackedPublicOverview(2, true);
  assert.equal(selectedTopic(), undefined, "All groups clears the selected topic");
  assert.equal(container.querySelector(".public-map-details-dock"), null, "All groups closes topic details");
  assert.equal(element(".public-map-filters select").value, "types", "Returning to all groups preserves relationship filters");
  assert.equal(element('.public-map-stage').dataset.groupLayout, undefined);
  await click(element('[aria-label="Back in public map"]'));
  assert.deepEqual(camera(), selectedCamera, "Back restores the focused neighborhood and exact camera");
  assert.equal(element(".public-map-stage").hidden, false);
  await click(element('[aria-label="Forward in public map"]'));
  assert.deepEqual(camera(), allGroupsCamera, "Forward restores the all-groups camera");
  assertPublicBrowseVisibility(26, "Forward restores the grouped presentation");
  assert.equal(apiCalls.length, beforeGroupReads, "Atlas navigation uses already loaded graph data");
  await settle(330);
  assert.equal(JSON.parse(browser.sessionStorage.getItem(`margin-public-map:${account}`)!).neighborhoodId, null);

  const browseGroups = [{ id: atlasRoot.id, labels: atlasTopics.map((topic) => topic.label) }, { id: "Q880099", labels: ["Distant neighborhood"] }];
  await zoomPublicTo(0.82);
  near(camera().scale, 0.82, "Manual zoom crosses the card threshold without snapping to a group fit");
  assertPublicBrowseCards(browseGroups);
  await zoomPublicTo(0.65);
  near(camera().scale, 0.65, "Zooming out retains an exact camera while titles are still legible");
  assertPublicBrowseCards(browseGroups);
  const expandedCamera = camera();
  await resizePublicGroup(700);
  near(camera().scale, expandedCamera.scale, "Resizing an expanded grouped canvas preserves the user's zoom");
  near(camera().x, expandedCamera.x - 150, "An unselected expanded canvas follows the available viewport center");
  assertPublicBrowseCards(browseGroups);
  await resizePublicGroup(1000);
  assert.deepEqual(camera(), expandedCamera, "Restoring the canvas width restores the unselected grouped camera");

  await click(publicNode("Distant neighborhood"));
  near(camera().scale, expandedCamera.scale, "Selecting a card in grouped browsing preserves its zoom");
  assert.equal(element('.public-map-inspector h3').textContent, "Distant neighborhood");
  assertPublicBrowseCards(browseGroups);
  await resizePublicGroup(660);
  near(camera().scale, expandedCamera.scale, "Opening details keeps the expanded grouped zoom");
  const selectedBrowseBox = publicScreenRect(element('.public-map-node[aria-label="Distant neighborhood"]'));
  assert(selectedBrowseBox.x >= 0 && selectedBrowseBox.y >= 0 && selectedBrowseBox.x + selectedBrowseBox.width <= canvasWidth
    && selectedBrowseBox.y + selectedBrowseBox.height <= canvasHeight, "The selected topic stays visible after grouped containers reflow beside its reader");
  assertPublicBrowseCards(browseGroups);
  await click(element('[aria-label="Close explorer"]'));
  await resizePublicGroup(1000);
  await settle(330);
  const savedBrowseLocation = JSON.parse(browser.sessionStorage.getItem(`margin-public-map:${account}`)!);
  assert.equal(savedBrowseLocation.presentation, "groups", "Expanded group browsing persists separately from authored topic canvases");
  assert.equal(savedBrowseLocation.neighborhoodId, null);
  assert.deepEqual(savedBrowseLocation.graph.positions, atlasGraph.positions, "Grouped browsing never rewrites authored topic positions");
  const savedBrowseCamera = camera();
  await act(async () => { root.render(null); });
  await render();
  await click(button("Public", ".knowledge-map-switcher button"));
  assert.deepEqual(camera(), savedBrowseCamera, "Reloading expanded grouped browsing preserves its exact camera");
  assertPublicBrowseCards(browseGroups);
  await click(element('.public-map-zoom [aria-label="Zoom out"]'));
  assertPublicBrowseCards(browseGroups);
  await zoomPublicTo(0.5);
  assertPublicBrowseCards(browseGroups);
  await zoomPublicTo(0.4);
  assertPublicBrowseCards(browseGroups);
  await zoomPublicTo(0.39);
  assert.equal(element('.public-map-stage').hidden, true, "Zooming back below the readable threshold hides cards while retaining all group containers");
  assertPackedPublicOverview(2);
  assert.equal(groupButton().getAttribute("aria-pressed"), "false", "Manual zoom out never creates group focus");
  await click(button("Center topic", ".public-map-zoom button"));
  assertPublicBrowseCards(browseGroups);
  const centeredBrowseBox = publicScreenRect(element('.public-map-node[aria-label="Distant neighborhood"]'));
  near(centeredBrowseBox.x + centeredBrowseBox.width / 2, canvasWidth / 2, "Center topic reveals its packed card at the canvas center");
  near(centeredBrowseBox.y + centeredBrowseBox.height / 2, canvasHeight / 2, "Center topic uses the grouped position after cards were hidden");
  await click(button("All groups", ".public-map-topbar button"));
  await zoomPublicTo(0.39);
  await resizePublicGroup(640);
  assertPackedPublicOverview(2, true);
  await resizePublicGroup(1000);
  assertPackedPublicOverview(2, true);
  assert.equal(apiCalls.length, beforeGroupReads, "Manual group browsing and resizing use already loaded topics");
  console.log("Public continuous grouped zoom reveals every neighborhood, preserves selection and resize cameras, and restores its presentation.");
  await click(groupButton());
  const persistedNeighborhoodCamera = camera();
  await settle(330);
  account = "public-map-account-b";
  await render();
  account = "public-map-atlas";
  await render();
  await click(button("Public", ".knowledge-map-switcher button"));
  assert.deepEqual(camera(), persistedNeighborhoodCamera, "Returning to an account restores its fitted neighborhood camera");
  assert.equal(element(".public-map-stage").hidden, false, "A persisted neighborhood below overview scale restores its visible member nodes");
  assert.equal(groupButton().getAttribute("aria-pressed"), "true");
  canvasWidth = 390; canvasHeight = 500;
  await act(async () => { root.render(null); });
  await render();
  await click(button("Public", ".knowledge-map-switcher button"));
  const narrowViewport = element(".public-map-viewport");
  await click(button("All groups", ".public-map-topbar button"));
  assertPackedPublicOverview(2, true);
  assert(camera().scale > 0.001, "A phone-sized atlas fits using overview footprints rather than an impossible full-size card");
  await click(groupButton());
  assert(camera().scale > 0.01 && camera().scale < 0.7, "A large neighborhood remains reachable on a narrow canvas");
  assert.equal(element(".public-map-stage").hidden, false);
  const narrowGroupCamera = camera();
  await key(narrowViewport, "ArrowLeft");
  await click(button("Fit group", ".public-map-zoom button"));
  assert.deepEqual(camera(), narrowGroupCamera, "Fit group refits only the active neighborhood on a narrow canvas");
  assert.equal(element('.public-map-stage').dataset.groupLayout, "spaced");
  const narrowBoxes = assertReadablePublicGroupCards(atlasTopics.map((topic) => topic.label));
  assert(narrowBoxes[0].y >= 0 && narrowBoxes[0].y + narrowBoxes[0].height <= canvasHeight, "A large phone group starts with readable first-row cards in view");
  const lastBox = narrowBoxes.at(-1)!;
  const panDistance = lastBox.y + lastBox.height / 2 - canvasHeight / 2;
  assert(panDistance > 0, "The phone fixture exercises a group that needs normal canvas panning");
  await act(async () => { narrowViewport.dispatchEvent(new browser.WheelEvent("wheel", { bubbles: true, cancelable: true, deltaY: panDistance })); });
  await flushFrames();
  const pannedLastBox = publicScreenRect(element(`.public-map-node[aria-label="${atlasTopics.at(-1)!.label}"]`));
  assert(pannedLastBox.y >= 0 && pannedLastBox.y + pannedLastBox.height <= canvasHeight, "Two-finger scrolling reaches the last named group card");
  assert.equal(groupButton().getAttribute("aria-pressed"), "true", "Panning a tall group retains group focus");
  await click(button("Fit group", ".public-map-zoom button"));
  assert.deepEqual(camera(), narrowGroupCamera, "Fit group returns to the readable first row after scrolling");
  await click(publicNode("Atlas topic 1"));
  assert.equal(camera().scale, narrowGroupCamera.scale, "Choosing a readable group member preserves zoom");
  assert.equal(element('.public-map-inspector h3').textContent, "Atlas topic 1");
  await click(element('[aria-label="Close explorer"]'));
  assertReadablePublicGroupCards(atlasTopics.map((topic) => topic.label));
  await click(publicNode("Atlas topic 1"));
  assert.equal(element('.public-map-inspector h3').textContent, "Atlas topic 1",
    "Selecting the same compact card reopens its closed reader");
  await click(element('[aria-label="Close explorer"]'));
  const zoomOutControl = element('.public-map-zoom [aria-label="Zoom out"]');
  assert.equal(zoomOutControl.disabled, false, "A fitted phone group can zoom out");
  const beforeZoomOut = camera().scale;
  await click(zoomOutControl);
  assert(camera().scale < beforeZoomOut, "Zoom out changes a small fitted camera");
  await click(element('.public-map-zoom [aria-label="Zoom out"]'));
  assert.equal(groupButton().getAttribute("aria-pressed"), "false", "Zooming beyond the fitted group releases group focus");
  assertPublicBrowseVisibility(26, "Manual zoom out returns to the grouped map");
  assert.equal(container.querySelector('.public-map-details-dock'), null);

  const tallRoot = atlasTopic("Q881001", "Tall public neighborhood");
  const tallNeighbors = Array.from({ length: 7 }, (_, index) => atlasTopic(`Q${881010 + index}`, `Tall public topic ${index + 1}`));
  let tallGraph = addPublicGraphRoot(emptyPublicGraph(), tallRoot);
  tallGraph = appendPublicGraphExpansion(tallGraph, { topic: tallRoot, topics: tallNeighbors, hasMore: false, nextOffset: 7,
    relations: tallNeighbors.map((topic) => ({ id: `${tallRoot.id}:P279:${topic.id}`, sourceId: tallRoot.id, targetId: topic.id, propertyId: "P279", label: "subclass of", sourceUrl: tallRoot.wikidataUrl })) });
  tallGraph.positions[tallRoot.id] = { x: 0, y: 0 };
  tallNeighbors.forEach((topic, index) => { tallGraph.positions[topic.id] = { x: index % 2 * 900, y: index === 6 ? 20374 : (index + 1) * 90 }; });
  account = "public-map-tall-dense";
  canvasWidth = 753; canvasHeight = 623;
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: GroupResizeObserver });
  function assertSelectedPublicCardVisible() {
    const box = publicScreenRect(element('.public-map-node[aria-label="Tall public topic 3"]'));
    assert(box.x >= 0 && box.y >= 0 && box.x + box.width <= canvasWidth && box.y + box.height <= canvasHeight,
      `The selected public card remains fully visible after the group reflows: ${JSON.stringify({ ...box, canvasWidth, canvasHeight })}`);
    return assertReadablePublicGroupCards([tallRoot, ...tallNeighbors].map((topic) => topic.label));
  }
  browser.sessionStorage.setItem(`margin-public-map:${account}`, JSON.stringify({ version: 1, graph: tallGraph, selectedId: null,
    viewport: { x: 50, y: 50, scale: 0.01 }, query: "", filters: { relation: "all", includeMetadata: false } }));
  await render();
  await click(button("Public", ".knowledge-map-switcher button"));
  const tallGroupButton = () => element('.public-knowledge-map [aria-label="Explore Tall public neighborhood, 8 topics"]');
  await click(tallGroupButton());
  const tallGroupCamera = camera(), tallGroupScale = tallGroupCamera.scale;
  assert.equal(element('.public-map-stage').dataset.groupLayout, "spaced", "Widely separated public nodes become a readable temporary group");
  const tallBoxes = assertReadablePublicGroupCards([tallRoot, ...tallNeighbors].map((topic) => topic.label));
  assert.equal(new Set(tallBoxes.map((box) => Math.round(box.x))).size, 3, "The public resize fixture starts with three card columns");
  await click(publicNode("Tall public topic 3"));
  assert.equal(element('.public-map-inspector h3').textContent, "Tall public topic 3");
  await resizePublicGroup(365);
  assert.equal(camera().scale, tallGroupScale, "Opening public details preserves zoom while the group changes from three columns to one");
  const narrowTallBoxes = assertSelectedPublicCardVisible();
  assert.equal(new Set(narrowTallBoxes.map((box) => Math.round(box.x))).size, 1, "Opening public details reflows the group into one readable column");
  await click(element('[aria-label="Close explorer"]'));
  await resizePublicGroup(753);
  assert.equal(camera().scale, tallGroupScale, "Closing public details preserves the group's zoom");
  assertSelectedPublicCardVisible();
  await click(button("Fit group", ".public-map-zoom button"));
  assert.deepEqual(camera(), tallGroupCamera, "Fit group restores the original public camera after its reader closes");
  for (let step = 0; step < 3; step++) {
    const before = camera().scale;
    const zoomOut = element('.public-map-zoom [aria-label="Zoom out"]');
    assert.equal(zoomOut.disabled, false, "A dense public fit remains free to zoom out after closing its reader");
    await click(zoomOut);
    if (tallGroupButton().getAttribute("aria-pressed") === "true") assert(camera().scale < before,
      "Zoom-out decreases the public scale while still inside the focused group");
  }
  assert.equal(tallGroupButton().getAttribute("aria-pressed"), "false", "Zooming out releases even a tall public neighborhood");
  assertPublicBrowseVisibility(8, "Leaving a tall focused neighborhood restores grouped browsing");
  assertPackedPublicOverview(1, true);
  assert.equal(selectedTopic(), undefined);
  await settle(330);
  assert.deepEqual(JSON.parse(browser.sessionStorage.getItem(`margin-public-map:${account}`)!).graph.positions, tallGraph.positions,
    "Temporary public group spacing never persists over authored graph positions");
  canvasWidth = 1000; canvasHeight = 700;
  console.log("Public atlas regions, group zoom-to-fit, stable topic selection, all-groups return, and navigation history passed.");

  let documentGraph = addPublicGraphRoot(tallGraph, atlasTopic("Q882099", "Unconnected topic"));
  documentGraph.positions.Q882099 = { x: 4000, y: 3000 };
  account = "public-map-documents-focus";
  browser.sessionStorage.setItem(`margin-public-map:${account}`, JSON.stringify({ version: 1, graph: documentGraph, selectedId: null,
    viewport: { x: 50, y: 50, scale: 0.1 }, query: "", filters: { relation: "all", includeMetadata: false }, presentation: "groups", groupOverviewVersion: 1 }));
  await render();
  await click(button("Public", ".knowledge-map-switcher button"));
  const documentViewport = element(".public-map-viewport");
  const viewOptions = element('.public-knowledge-map [aria-label="Map view options"]');
  await click(viewOptions);
  await click(button("Topics and connections", ".public-knowledge-map .graph-map-view-options button"));
  assert.equal(container.querySelector('.public-knowledge-map .graph-territories'), null, "Topics-and-connections mode removes group boxes");
  assert.equal(container.querySelectorAll('.public-map-node.is-document').length, 9, "Every loaded matching topic remains available in document mode");
  const beforeArrangementRequests = apiCalls.length;
  async function arrangePublic(label: string) {
    const summary = element('.public-map-arrange summary');
    const beforePointer = camera();
    await pointer(summary, "pointerdown", 82, 700, 650, "mouse");
    await pointer(summary, "pointerup", 82, 700, 650, "mouse");
    assert.deepEqual(camera(), beforePointer, "The Arrange control never initiates canvas panning");
    assert.equal(pointerCaptures.size, 0);
    await click(summary);
    await click(button(label, '.public-map-arrange button'));
  }
  function assertDocumentCardsDoNotOverlap() {
    const boxes = [...container.querySelectorAll('.public-map-node')].map(publicScreenRect);
    for (let a = 0; a < boxes.length; a++) for (let b = a + 1; b < boxes.length; b++) {
      const first = boxes[a], second = boxes[b];
      assert(first.x + first.width <= second.x + 0.001 || second.x + second.width <= first.x + 0.001 || first.y + first.height <= second.y + 0.001 || second.y + second.height <= first.y + 0.001, "Arranged public topics never overlap");
    }
  }
  for (const label of ["Auto layout", "Tree: left to right", "Tree: top down", "Most connections"]) {
    await arrangePublic(label);
    assert.equal(container.querySelector('.public-knowledge-map .graph-territories'), null);
    assert.equal(container.querySelectorAll('.public-map-node').length, 9);
    assertDocumentCardsDoNotOverlap();
    assertPublicCurveTouchesCards("Tall public neighborhood", "Tall public topic 1");
    assert.equal(button(label, '.public-map-arrange button').getAttribute('aria-pressed'), "true");
  }
  await click(publicNode("Tall public topic 3"));
  await click(element('[aria-label="Close explorer"]'));
  const preFocusCamera = camera();
  await click(button("Focus connections", ".public-map-zoom button"));
  assert.equal(container.querySelectorAll('.public-map-node').length, 2, "Explicit focus shows the chosen leaf plus its directly connected parent");
  assert.equal(container.querySelectorAll('.public-map-edges g').length, 1, "Focus preserves the actual loaded relationship");
  assert.equal(container.querySelector('.public-map-node[aria-label="Unconnected topic"]'), null, "Unrelated loaded topics stay outside focused scope");
  assert(element('.public-map-focusbar strong').textContent.includes("Tall public topic 3"));
  const focusedAnchor = publicScreenRect(element('.public-map-node[aria-label="Tall public topic 3"]'));
  near(focusedAnchor.x + focusedAnchor.width / 2, canvasWidth / 2, "Explicit focus centers the chosen topic instead of the highest-degree parent");
  assert(focusedAnchor.y >= 0 && focusedAnchor.y + focusedAnchor.height <= canvasHeight);
  assertDocumentCardsDoNotOverlap();
  const firstFocusCamera = camera();
  await key(documentViewport, "ArrowRight");
  await click(button("Fit connections", ".public-map-zoom button"));
  assert.deepEqual(camera(), firstFocusCamera, "Fit connections restores the whole local cluster");
  await click(element('[aria-label="Back in public map"]'));
  assert.equal(container.querySelector('.public-map-focusbar'), null);
  assert.deepEqual(camera(), preFocusCamera, "Back restores full-graph presentation and its camera");
  await click(element('[aria-label="Forward in public map"]'));
  assert.deepEqual(camera(), firstFocusCamera);
  assert.equal(container.querySelectorAll('.public-map-node').length, 2);
  await click(button("Show more connections", '.public-map-focusbar button'));
  assert.equal(container.querySelectorAll('.public-map-node').length, 8, "A second hop reveals siblings through their common parent");
  assert.equal(container.querySelectorAll('.public-map-edges g').length, 7);
  assert.equal(button("Show more connections", '.public-map-focusbar button').disabled, true, "An unrelated component does not offer a misleading extra-hop action");
  assert(element('.public-map-focusbar small').textContent.includes("2 hops"));
  await click(publicNode("Tall public topic 5"));
  assert(element('.public-map-focusbar strong').textContent.includes("Tall public topic 5"), "Clicking a topic pivots an already focused view");
  assert(element('.public-map-focusbar small').textContent.includes("2 hops"), "Pivoting retains the chosen hop depth");
  for (const label of ["Tree: left to right", "Tree: top down", "Around focused node"]) {
    await arrangePublic(label);
    assert.equal(container.querySelectorAll('.public-map-node').length, 8, "Arrange preserves the focused membership");
    assertDocumentCardsDoNotOverlap();
  }
  const focusedScale = camera().scale;
  await key(documentViewport, "-");
  assert(camera().scale < focusedScale);
  assert.equal(container.querySelectorAll('.public-map-node').length, 8, "Manual zoom never changes focused membership");
  assert(element('.public-map-focusbar'));
  await click(button("Fit connections", '.public-map-zoom button'));
  const beforeResizeFocus = camera();
  await resizePublicGroup(640);
  assert.notDeepEqual(camera(), beforeResizeFocus, "Resizing fits the complete focus layout in the new usable canvas");
  assert.equal(container.querySelectorAll('.public-map-node').length, 8);
  assertDocumentCardsDoNotOverlap();
  await resizePublicGroup(1000);
  await key(documentViewport, "ArrowUp");
  const persistedFocusCamera = camera();
  await settle(330);
  const savedFocus = JSON.parse(browser.sessionStorage.getItem(`margin-public-map:${account}`)!);
  assert.equal(savedFocus.graphFocusId, "Q881014");
  assert.equal(savedFocus.graphFocusDepth, 2);
  assert.equal(savedFocus.documentLayoutMode, "connections");
  assert.deepEqual(savedFocus.graph.positions, documentGraph.positions, "Document arrangements never modify saved topic coordinates");
  await act(async () => { root.render(null); });
  await render();
  await click(button("Public", ".knowledge-map-switcher button"));
  assert.deepEqual(camera(), persistedFocusCamera, "Remount preserves the focus camera including manual panning");
  assert.equal(container.querySelectorAll('.public-map-node').length, 8);
  assert(element('.public-map-focusbar strong').textContent.includes("Tall public topic 5"));
  await click(button("All nodes", '.public-map-focusbar button'));
  assert.equal(container.querySelector('.public-map-focusbar'), null);
  assert.equal(container.querySelectorAll('.public-map-node').length, 9);
  assert.equal(container.querySelector('.public-knowledge-map .graph-territories'), null, "Leaving focus retains topics-and-connections presentation");
  await click(element('.public-knowledge-map [aria-label="Map view options"]'));
  await click(button("Groups and topics", '.public-knowledge-map .graph-map-view-options button'));
  assert(container.querySelector('.public-knowledge-map .graph-territories'), "The same view-options menu restores grouped browsing");
  assert.equal(apiCalls.length, beforeArrangementRequests, "Arranging and focusing never fetch or invent connections");

  const knownRoot = atlasTopic("Q990001", "Systems thinking"), knownNeighbor = atlasTopic("Q990002", "Feedback");
  const expandableGraph = appendPublicGraphExpansion(addPublicGraphRoot(emptyPublicGraph(), knownRoot), { topic: knownRoot, topics: [knownNeighbor], hasMore: false, nextOffset: 1,
    relations: [{ id: "Q990001:P279:Q990002", sourceId: "Q990001", targetId: "Q990002", propertyId: "P279", label: "subclass of", sourceUrl: knownRoot.wikidataUrl }] });
  account = "public-map-focused-expansion";
  browser.sessionStorage.setItem(`margin-public-map:${account}`, JSON.stringify({ version: 1, graph: expandableGraph, selectedId: null,
    viewport: { x: 40, y: 60, scale: 0.9 }, query: "", filters: { relation: "all", includeMetadata: false }, presentation: "documents", documentLayoutMode: "auto", groupOverviewVersion: 1 }));
  await render();
  await click(button("Public", ".knowledge-map-switcher button"));
  await click(publicNode("Feedback"));
  await click(button("Focus connections", '.public-map-inspector-actions button'));
  assert.equal(container.querySelectorAll('.public-map-node').length, 2);
  await click(button("Expand connections", '.public-map-inspector-actions button'));
  await settle();
  assert.equal(container.querySelectorAll('.public-map-node').length, 3, "Async expansion adds the new direct neighbor to the focused scene");
  assert(element('.public-map-node[aria-label="Cybernetics"]'));
  assert.equal(element('.public-map-focusbar strong').textContent, "Around Feedback");
  assertDocumentCardsDoNotOverlap();
  const expandedAnchor = publicScreenRect(element('.public-map-node[aria-label="Feedback"]'));
  near(expandedAnchor.x + expandedAnchor.width / 2, canvasWidth / 2, "Async expansion refits the cluster around its original focus anchor");
  await setRelationship("parts");
  assert.equal(container.querySelectorAll('.public-map-node').length, 1, "Focused membership respects the relationship filter");
  assert.equal(container.querySelectorAll('.public-map-edges g').length, 0);
  await setRelationship("all");
  assert.equal(container.querySelectorAll('.public-map-node').length, 3, "Restoring relationship filters restores loaded focused neighbors");
  await click(element('[aria-label="Back in public map"]'));
  assert.equal(container.querySelectorAll('.public-map-node').length, 1, "Back restores a filtered focus scope");
  await click(element('[aria-label="Forward in public map"]'));
  assert.equal(container.querySelectorAll('.public-map-node').length, 3);
  console.log("Public document layouts, focused connections, hop depth, pivots, resize, history, and persistence passed.");
} finally {
  await act(async () => { root.unmount(); });
  Object.defineProperty(globalThis, "ResizeObserver", { configurable: true, value: originalResizeObserver });
  await browser.happyDOM.close();
}
