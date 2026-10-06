import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { BrowserThreadRequest } from "../../client/src/lib/browserWorkspace";
const browser = new Window({ url: "http://browser-workspace.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, StrictMode } = await import("react");
const { createRoot } = await import("react-dom/client");
const { openThreadAsChat, useBrowserThreadImports } = await import("../../client/src/lib/browserWorkspace");
const { createEmptyState } = await import("../../client/src/initialState");
let workspace = createEmptyState();
const imported: string[] = [], acknowledged: string[] = [], checks: string[] = [];
const make = (id: string, focus = false, thread = "thread-0001"): BrowserThreadRequest => ({ id, focus, thread: {
  id: thread, createdAt: "2026-10-06T10:00:00Z", title: "Why?", userContent: "> quote\n\nWhy?", answer: "Because.",
} });
function Probe({ ready, requests }: { ready: boolean; requests: BrowserThreadRequest[] }) {
  useBrowserThreadImports(ready, requests, (request) => {
    workspace = openThreadAsChat(workspace, request.thread, request.focus);
    imported.push(request.id);
  }, (request) => acknowledged.push(request.id));
  return null;
}
const container = browser.document.createElement("div"); browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
async function render(ready: boolean, requests: BrowserThreadRequest[]) {
  await act(async () => root.render(createElement(StrictMode, null, createElement(Probe, { ready, requests }))));
}
try {
  const first = make("thread-0001:import");
  await render(false, [first]);
  assert.deepEqual(imported, []); assert.deepEqual(acknowledged, []);
  checks.push("nothing is imported before the vault has hydrated");
  const before = workspace.activeConversationId;
  await render(true, [first]);
  assert.deepEqual(imported, ["thread-0001:import"]); assert.deepEqual(acknowledged, ["thread-0001:import"]);
  assert.ok(workspace.conversations["web-thread-thread-0001"]);
  assert.equal(workspace.activeConversationId, before);
  checks.push("a quiet import adds the chat without changing the open conversation");
  await render(true, [{ ...first }]); await render(false, [first]); await render(true, [first]);
  assert.deepEqual(imported, ["thread-0001:import"]); assert.deepEqual(acknowledged, ["thread-0001:import"]);
  checks.push("rerenders, readiness changes and StrictMode never import or acknowledge twice");
  const second = make("thread-0002:import", false, "thread-0002");
  const open = make("thread-0001:open-1", true);
  await render(true, [first, second, open]);
  assert.deepEqual(imported, ["thread-0001:import", "thread-0002:import", "thread-0001:open-1"]);
  assert.equal(workspace.activeConversationId, "web-thread-thread-0001");
  assert.equal(Object.keys(workspace.conversations).filter((id) => id.startsWith("web-thread-")).length, 2);
  checks.push("several requests are delivered in order and an open request focuses the existing chat");
  await render(true, []);
  assert.equal(imported.length, 3);
  console.log(JSON.stringify({ checks }));
} finally { await act(async () => root.unmount()); await browser.happyDOM.close(); }
