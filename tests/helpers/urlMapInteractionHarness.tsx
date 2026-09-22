import assert from "node:assert/strict";
import { Window } from "happy-dom";
import { extractPage } from "../../server/urlMap/page.mjs";
import { validateGeneratedUrlMap } from "../../server/urlMap/index.mjs";
import { urlMapHtml, urlMapModelReply } from "./urlMapFixture";

const browser = new Window({ url: "http://url-map-interactions.test/" });
for (const name of ["window", "document", "navigator", "localStorage", "sessionStorage", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "ResizeObserver", "DOMRect"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperties(browser.HTMLElement.prototype, {
  clientWidth: { configurable: true, get: () => 1000 },
  clientHeight: { configurable: true, get: () => 400 },
});
browser.HTMLElement.prototype.getBoundingClientRect = function () {
  const top = this.classList.contains("url-map-linked-pages") ? 720 - (this.closest(".url-map-inspector")?.scrollTop ?? 0) : 0;
  return new browser.DOMRect(0, top, 1000, 400);
};
browser.HTMLElement.prototype.setPointerCapture = () => {};
const graph = validateGeneratedUrlMap(urlMapModelReply, extractPage(urlMapHtml, "https://example.org/trees"));
browser.sessionStorage.setItem("margin-url-maps:url-map-interactions", JSON.stringify([graph, {
  ...graph, source: { ...graph.source, retrievedAt: "2026-09-20T00:00:00.000Z" },
}]));

const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: UrlMapPanel } = await import("../../client/src/components/UrlMapPanel");
const { createEmptyState } = await import("../../client/src/initialState");
const { saveUrlMapNode } = await import("../../client/src/lib/urlMap");
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
let savedCount = 0;
let shownId = "";
function Panel() {
  const [state, setState] = useState(createEmptyState);
  return createElement(UrlMapPanel, {
    workspaceKey: "url-map-interactions", conversations: state.conversations,
    onSave(mapped, nodeId) { savedCount++; setState((current) => saveUrlMapNode(current, mapped, nodeId)); },
    onShowInMyMap(id) { shownId = id; }, onExplorePublic() {},
  });
}
function visible(selector: string) {
  const found = [...container.querySelectorAll(selector)].find((element) => !element.closest("[hidden]"));
  assert(found, `Missing visible ${selector}`);
  return found as any;
}
async function click(element: any) { await act(async () => { element.click(); }); }
async function key(element: any, value: string, shiftKey = false) { await act(async () => { element.dispatchEvent(new browser.KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true })); }); }
async function touch(element: any, type: string, pointerId: number, clientX: number, clientY = 100) {
  await act(async () => { element.dispatchEvent(new browser.PointerEvent(type, { pointerType: "touch", pointerId, clientX, clientY, bubbles: true, cancelable: true })); });
}

try {
  await act(async () => { root.render(createElement(Panel)); });
  const inspector = visible(".url-map-inspector");
  const linksAction = visible(`[aria-label="Explore links for ${graph.nodes[0].label}"]`);
  await click(linksAction);
  assert(inspector.scrollTop > 0, "Explore links must reveal the linked pages below the inspector fold");
  inspector.scrollTop = 0;
  await click(linksAction);
  assert(inspector.scrollTop > 0, "Explore links must reveal an already-open links section after scrolling away");
  await click(visible(".url-map-links-toggle"));
  assert.equal(inspector.scrollTop, 0, "Closing links returns to the topic details");

  const markers = [...container.querySelectorAll(".url-map-edges marker")];
  assert.equal(markers.length, 2);
  assert.equal(new Set(markers.map((marker) => marker.id)).size, 2, "Mapping the same source again must not duplicate SVG marker IDs across history");
  for (const marker of markers) {
    const edge = marker.closest("svg")!.querySelector(".url-map-edge-line")!;
    assert.equal(edge.getAttribute("marker-end"), `url(#${marker.id})`);
  }

  const relationship = visible(".url-map-edges g");
  await act(async () => { relationship.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  assert(visible(".url-map-inspector h3").textContent.includes("→"), "Keyboard users can inspect a relationship");
  await click(visible(".url-map-topic-select"));
  await click(visible(".url-map-detail-actions .url-map-primary"));
  assert.equal(savedCount, 1);
  assert.equal(visible(".url-map-detail-actions .url-map-primary").textContent, "Show in my map");
  await click(visible(".url-map-detail-actions .url-map-primary"));
  assert.equal(savedCount, 1, "Showing an existing topic does not save it twice");
  assert(shownId.startsWith("url-topic-"));

  await click(visible(".url-map-history button"));
  assert.equal(visible(".url-map-history span").textContent, "Page 1 of 2");
  assert.equal(container.querySelectorAll(".url-map-result-container:not([hidden])").length, 1);
  const viewport = visible(".url-map-viewport");
  viewport.scrollLeft = 200; viewport.scrollTop = 100;
  await key(viewport, "+");
  assert.equal(visible('[aria-label="Map zoom"] span').textContent, "115%");
  assert(Math.abs(viewport.scrollLeft - 305) < 0.001, "Zoom anchors the same world point at the viewport center");
  assert(Math.abs(viewport.scrollTop - 145) < 0.001);
  await key(viewport, "ArrowRight");
  assert(Math.abs(viewport.scrollLeft - 365) < 0.001);
  await key(viewport, "ArrowDown", true);
  assert(Math.abs(viewport.scrollTop - 265) < 0.001, "Shift-arrow provides a larger pan step");
  const button = visible(".url-map-topic-select"), beforeChildKey = viewport.scrollLeft;
  await key(button, "ArrowRight");
  assert.equal(viewport.scrollLeft, beforeChildKey, "Map shortcuts do not hijack keys on topic controls");

  const resize = visible('[aria-label="Resize topic details"]');
  await key(resize, "ArrowLeft");
  assert.equal(resize.getAttribute("aria-valuenow"), "344");
  await key(resize, "Home");
  assert.equal(resize.getAttribute("aria-valuenow"), "260");
  await key(visible(".url-map-inspector"), "Escape");
  assert(visible(".url-map-result").classList.contains("details-collapsed"));
  assert.equal(browser.document.activeElement, viewport);
  await click(button);
  assert(visible(".url-map-result").classList.contains("has-details"), "Selecting an overview topic restores its actions and evidence");
  await click(visible(".url-map-sheet-toggle"));
  assert(visible(".url-map-result").classList.contains("details-collapsed"), "Bottom-sheet collapse leaves the map mounted");
  assert.equal(visible(".url-map-viewport"), viewport);

  await key(viewport, "Home");
  assert.equal(viewport.scrollLeft, 0); assert.equal(viewport.scrollTop, 0);
  assert(visible(".url-map-world").classList.contains("is-overview"), "Fit uses simplified cards when summaries would be too small");
  const initialZoom = Number.parseFloat(visible('[aria-label="Map zoom"] span').textContent) / 100;
  viewport.scrollLeft = 200; viewport.scrollTop = 100;
  await touch(viewport, "pointerdown", 1, 100);
  await touch(viewport, "pointerdown", 2, 200);
  await touch(viewport, "pointermove", 2, 300);
  const pinchZoom = Number.parseFloat(visible('[aria-label="Map zoom"] span').textContent) / 100;
  assert(pinchZoom > initialZoom, "Two actual touch pointers zoom the map");
  assert(Math.abs(viewport.scrollLeft - 500) < 0.001, "Pinch preserves the content under the moving two-finger midpoint");
  await touch(viewport, "pointerup", 2, 300);
  const beforePan = viewport.scrollLeft;
  await touch(viewport, "pointermove", 1, 140);
  assert.equal(viewport.scrollLeft, beforePan - 40, "Lifting one finger continues smoothly as a pan");
  await touch(viewport, "pointercancel", 1, 140);
  await click(visible(".url-map-topic-select"));
  assert(visible(".url-map-result").classList.contains("details-collapsed"), "Dragging does not accidentally select a topic when the gesture ends");
  console.log("URL map linked-page reveal, saved topics, keyboard relationships, and history passed.");
} finally {
  await act(async () => { root.unmount(); });
  await browser.happyDOM.close();
}
