import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { BrowserCaptureRequest } from "../../client/src/lib/browserWorkspace";
const browser = new Window({ url: "http://browser-workspace.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, StrictMode } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useBrowserWorkspaceCapture } = await import("../../client/src/lib/browserWorkspace");
const { openCaptureAsNote, createCaptureAIRequest } = await import("../../client/src/lib/captures");
const { createEmptyState } = await import("../../client/src/initialState");
let workspace = createEmptyState();
const imported: string[] = [], acknowledged: string[] = [], prompts: string[] = [], checks: string[] = [];
const request: BrowserCaptureRequest = { id: "request-1", capture: {
  schemaVersion: 1, clientCaptureId: "browser-capture-1", id: "capture-1", kind: "article", title: "Page source",
  sourceUrl: "https://example.com/source", content: "Source context", comment: "A comment is not an AI prompt",
  capturedAt: "2026-09-27T12:00:00Z", createdAt: "2026-09-27T12:00:00Z",
} };
function Probe({ ready, request: pending }: { ready: boolean; request?: BrowserCaptureRequest | null }) {
  useBrowserWorkspaceCapture(ready, pending, (item) => {
    workspace = openCaptureAsNote(workspace, item.capture);
    imported.push(item.id);
    if (item.prompt?.trim()) {
      const ai = createCaptureAIRequest(workspace.conversations[workspace.activeConversationId], item.prompt);
      if (ai) prompts.push(ai.prompt);
    }
  }, (id) => acknowledged.push(id));
  return null;
}
const container = browser.document.createElement("div"); browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
async function render(ready: boolean, pending?: BrowserCaptureRequest | null) {
  await act(async () => root.render(createElement(StrictMode, null, createElement(Probe, { ready, request: pending }))));
}
try {
  await render(false, request);
  assert.deepEqual(imported, []); assert.deepEqual(acknowledged, []);
  const hydratedId = workspace.activeConversationId;
  workspace.conversations[hydratedId].title = "Hydrated existing document";
  await render(true, request);
  assert.deepEqual(imported, [request.id]); assert.deepEqual(acknowledged, [request.id]);
  assert.equal(workspace.conversations[hydratedId].title, "Hydrated existing document");
  assert.equal(workspace.conversations[workspace.activeConversationId].title, "Page source");
  checks.push("waits for vault hydration and merges the source with existing documents");
  assert.deepEqual(prompts, []);
  checks.push("saving a source with a comment does not start AI");
  await render(true, { ...request }); await render(false, request); await render(true, request);
  assert.deepEqual(imported, [request.id]); assert.deepEqual(acknowledged, [request.id]);
  checks.push("rerenders, ready changes and StrictMode do not import or acknowledge twice");
  const document = workspace.conversations[workspace.activeConversationId];
  document.notes![0].content = "My later edit";
  await render(true, { ...request, id: "request-2", prompt: "  Explain the source  " });
  assert.deepEqual(prompts, ["Explain the source"]);
  assert.equal(workspace.conversations[workspace.activeConversationId].notes![0].content, "My later edit");
  await render(true, { ...request, id: "request-2", prompt: "  Explain the source  " });
  assert.deepEqual(prompts, ["Explain the source"]);
  checks.push("a fresh explicit question starts one AI request and preserves edits to an existing source");
  await render(true, null); assert.equal(imported.length, 2);
  console.log(JSON.stringify({ checks }));
} finally { await act(async () => root.unmount()); await browser.happyDOM.close(); }
