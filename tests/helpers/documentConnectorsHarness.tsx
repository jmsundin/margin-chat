import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { ConnectorNavigationTarget } from "../../client/src/types";
import { buildDocumentConnector, type DocumentConnectorEndpoint } from "../../client/src/lib/documentConnectors";

const browser = new Window({ url: "http://document-connectors.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: ConnectorOverlay } = await import("../../client/src/components/ConnectorOverlay");
const panel = { left: 8, right: 360, top: 60, bottom: 780 };
const source: DocumentConnectorEndpoint = { panel, viewport: panel, anchor: { left: 30, right: 250, top: 180, bottom: 206 }, title: "Reference", target: { conversationId: "source" } };
const target: DocumentConnectorEndpoint = { panel: null, viewport: null, anchor: null, title: "Linked document", target: { conversationId: "target", blockId: "specific-block" } };
const continuation = buildDocumentConnector({ id: "first", active: true, source, target })!;
const opened: ConnectorNavigationTarget[] = [];
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const occlusionRects = [{ id: "pinned", x: 8, y: 60, width: 352, height: 720 }];

try {
  await act(async () => root.render(createElement(ConnectorOverlay, { connections: [continuation], occlusionRects, onNavigate: (value) => opened.push(value) })));
  assert.equal(container.querySelectorAll(".connector-path").length, 0);
  const button = container.querySelector<HTMLButtonElement>(".connector-continuation")!;
  assert(button.getAttribute("aria-label")?.includes("Linked document"));
  assert.equal(button.closest("svg"), null, "Pinned labels must remain outside the curve's mask");
  assert.equal(container.querySelector("mask rect[fill='black']")?.getAttribute("width"), "352");
  await act(async () => button.click());
  assert.deepEqual(opened, [{ conversationId: "target", blockId: "specific-block" }]);

  const second = buildDocumentConnector({ id: "second", active: true, source, target: { ...target, title: "Other document", target: { conversationId: "other", anchorId: "source-passage" } } })!;
  await act(async () => root.render(createElement(ConnectorOverlay, { connections: [continuation, second], occlusionRects, onNavigate: (value) => opened.push(value) })));
  const details = container.querySelector<HTMLDetailsElement>("details")!;
  assert(details);
  assert.equal(container.querySelectorAll("summary").length, 1, "Colliding labels should share one control");
  details.setAttribute("open", "");
  const linkedButtons = details.querySelectorAll<HTMLButtonElement>("button");
  assert.equal(linkedButtons.length, 2);
  await act(async () => linkedButtons[1].click());
  assert.deepEqual(opened.at(-1), { conversationId: "other", anchorId: "source-passage" });
  assert.equal(details.hasAttribute("open"), false);
  details.setAttribute("open", "");
  await act(async () => details.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(details.hasAttribute("open"), false);
  assert.equal(browser.document.activeElement, details.querySelector("summary"));
  console.log("document connector interactions passed");
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
