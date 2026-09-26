import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { Conversation } from "../../client/src/types";

const browser = new Window({ url: "http://graph-analysis.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: GraphAnalysisViews } = await import("../../client/src/components/GraphAnalysisViews");
const date = "2026-09-23T09:00:00.000Z";
const conversations: Record<string, Conversation> = Object.fromEntries(Array.from({ length: 48 }, (_, index) => {
  const id = `Document ${String(index + 1).padStart(2, "0")}`;
  return [id, {
    id, title: id, parentId: null, branchAnchor: null, childIds: [], messages: [],
    createdAt: index === 47 ? "2026-10-01T00:00:00Z" : date,
    updatedAt: index === 0 ? "2026-10-01T00:00:00Z" : date,
    linkedConversationIds: index === 0 ? ["Document 48"] : [],
    serviceId: "backend-services", modelId: "smart-routing",
  } satisfies Conversation];
}));
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const opened: string[] = [];
const checks: string[] = [];
async function render(mode: "matrix" | "timeline" | "flow", relationKinds?: ("branch" | "link")[]) {
  await act(async () => root.render(createElement(GraphAnalysisViews, {
    mode, conversations, groups: {}, selectedConversationId: "Document 48", relationKinds,
    onOpenConversation: (id: string) => opened.push(id),
  })));
}
async function click(selector: string) {
  const target = container.querySelector(selector) as any;
  assert(target, `Missing control ${selector}`);
  await act(async () => target.click());
}
try {
  await render("matrix");
  await click('[aria-label="Next columns"]');
  await click('[aria-label="Next columns"]');
  assert(container.querySelector("tbody th")!.textContent!.includes("Document 01"));
  await click('[aria-label="Document 01 to Document 48: authored link"]');
  const inspector = container.querySelector('[aria-label="Selected matrix relationship"]')!;
  assert(inspector.textContent!.includes("Document 01"));
  assert(inspector.textContent!.includes("Document 48"));
  await act(async () => (inspector.querySelectorAll("button")[1] as any).click());
  assert.deepEqual(opened, ["Document 48"]);
  checks.push("independent matrix axis pagination reaches a distant relationship and opens its actual target");

  await render("matrix", ["branch"]);
  assert(container.textContent!.includes("no longer in the current view"));
  assert(!container.querySelector('[aria-label="Document 01 to Document 48: authored link"]'));
  checks.push("changing relationship filters removes stale cell evidence");

  await render("timeline");
  assert.equal(container.querySelector(".graph-analysis-timeline .graph-analysis-document")!.textContent, "Document 01");
  const select = container.querySelector("select")!;
  await act(async () => {
    select.value = "created";
    select.dispatchEvent(new browser.Event("change", { bubbles: true }));
  });
  assert.equal(container.querySelector(".graph-analysis-timeline .graph-analysis-document")!.textContent, "Document 48");
  await click('[aria-label="Next documents"]');
  assert(container.textContent!.includes("41–48 of 48"));
  checks.push("timeline uses created versus edited timestamps and makes every document reachable");

  await render("flow");
  const flowInspector = container.querySelector('[aria-label="Selected flow sources"]')!;
  assert(flowInspector.textContent!.includes("Document 48"));
  assert(flowInspector.textContent!.includes("1 authored links"));
  const ribbon = container.querySelector("path")!;
  await act(async () => ribbon.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", bubbles: true })));
  assert.equal(ribbon.getAttribute("aria-pressed"), "true");
  checks.push("flow exposes the exact underlying documents and keyboard-operable ribbons");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  browser.happyDOM.abort();
}
