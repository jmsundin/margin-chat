import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { Capture } from "@margin-chat/capture-contracts";

const browser = new Window({ url: "http://capture-handoff.test/?capture=saved-capture-1234&intent=ask" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "HTMLTextAreaElement"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: CaptureInbox } = await import("../../client/src/components/CaptureInbox");
const capture: Capture = {
  schemaVersion: 1, clientCaptureId: "extension-capture-1234", id: "saved-capture-1234", kind: "article",
  title: "An internet source", sourceUrl: "https://example.com/source", content: "The saved page content.",
  comment: "What are its implications?", capturedAt: "2026-09-27T12:00:00.000Z", createdAt: "2026-09-27T12:00:01.000Z",
};
const asked: Array<{ capture: Capture; prompt: string }> = [];
const opened: Capture[] = [];
const requests: string[] = [];
let denied = false;
globalThis.fetch = (async (input, init) => {
  assert.equal(init?.credentials, "same-origin");
  assert.equal(new Headers(init?.headers).has("Authorization"), false);
  const path = String(input);
  requests.push(path);
  if (path.endsWith(capture.id)) return denied
    ? Response.json({ error: "Capture not found." }, { status: 404 }) : Response.json({ capture });
  return Response.json({ captures: [{ ...capture, excerpt: "The saved page content." }], nextCursor: null });
}) as typeof fetch;
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const checks: string[] = [];
const common = {
  onClose() {},
  onOpenNote(value: Capture) { opened.push(value); },
  onAskAI(value: Capture, prompt: string) { asked.push({ capture: value, prompt }); },
};
function button(label: string) {
  const found = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === label);
  assert.ok(found, `Missing ${label} button`);
  return found;
}
async function render(key: string, intent?: "ask" | "note") {
  await act(async () => {
    root.render(createElement(CaptureInbox, { key, ...common, initialCaptureId: capture.id, initialIntent: intent }));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
}

try {
  await render("ask", "ask");
  assert.ok(requests.includes(`/api/v1/captures/${capture.id}`));
  assert.equal(container.querySelector<HTMLTextAreaElement>("textarea")?.value, capture.comment);
  assert.equal(asked.length, 0);
  assert.equal(opened.length, 0);
  assert.match(container.textContent ?? "", /The saved page content/);
  checks.push("handoff loads the owner-scoped capture and prefills its question without sending AI");

  const field = container.querySelector("textarea")!;
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value")!.set!.call(field, "Explain the source in one paragraph");
    field.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  await act(async () => container.querySelector("form")!.dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true })));
  assert.equal(asked.length, 1);
  assert.equal(asked[0].capture.id, capture.id);
  assert.equal(asked[0].prompt, "Explain the source in one paragraph");
  checks.push("an explicit submission sends the reviewed question and the selected saved capture");

  await render("note", "note");
  assert.equal(container.querySelector("textarea"), null);
  await act(async () => button("Ask AI").click());
  assert.equal(container.querySelector<HTMLTextAreaElement>("textarea")?.value, "");
  assert.equal(button("Ask AI in workspace").disabled, true);
  await act(async () => button("Open as note").click());
  assert.equal(opened.length, 1);
  assert.equal(asked.length, 1);
  checks.push("ordinary captures keep comments as notes and require a separate question for AI");

  denied = true;
  await render("denied", "ask");
  assert.match(container.querySelector('[role="alert"]')?.textContent ?? "", /Capture not found/);
  assert.equal(container.querySelector("textarea"), null);
  assert.equal(asked.length, 1);
  checks.push("an inaccessible capture cannot expose source content or trigger an AI request");
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
console.log(JSON.stringify({ checks }));
