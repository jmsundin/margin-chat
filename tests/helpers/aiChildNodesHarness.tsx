import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { AIChildNodeProposal } from "../../client/src/lib/aiChildNodes";

const browser = new Window({ url: "http://ai-child-nodes.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Text", "Document", "DocumentFragment", "MutationObserver", "ResizeObserver", "Event", "MouseEvent", "KeyboardEvent", "Range", "DOMRect", "DOMParser", "getComputedStyle", "HTMLInputElement", "HTMLTextAreaElement", "ShadowRoot"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value: name === "getComputedStyle" ? value.bind(browser) : value });
}
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: clearTimeout });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: DocumentPanel } = await import("../../client/src/components/DocumentPanel");
await import("../../client/src/components/RichDocumentEditor");
const { createMainConversation } = await import("../../client/src/initialState");
const { getEditableDocument } = await import("../../client/src/lib/editableDocument");
const date = "2026-10-09T00:00:00.000Z";
const conversation = createMainConversation({ id: "parent", createdAt: date });
conversation.messages = [
  { id: "question", role: "user", content: "Compare queues.", createdAt: date },
  { id: "answer", role: "assistant", content: "## Kafka\n\nA durable log.\n\n## SQS\n\nA managed queue.\n\n## Redis\n\nFast streams.\n", createdAt: date },
];
conversation.document = getEditableDocument(conversation);
const created: AIChildNodeProposal[][] = [];
const checks: string[] = [];
const noop = () => {};
let anchors: any[] = [];
function render(withHandler: boolean) {
  return createElement(DocumentPanel, {
    conversation, isActive: true, isSubmitting: false, aiControls: null, recentModelSelections: [], anchors, theme: "light",
    onChange: noop, onRename: noop, onSubmit: noop, onStop: noop, onSelection: noop, onOpenBranch: noop, onOpenNote: noop,
    onModelChange: noop, onUpload: noop, onRemoveAttachment: noop, onAcceptVersion: noop, onUndoInsertion: noop,
    registerPanelRef: noop, registerAnchorRef: noop, registerBranchOriginRef: noop,
    ...(withHandler ? { onCreateChildNodes: (proposals: AIChildNodeProposal[]) => created.push(proposals) } : {}),
  });
}
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const element = (selector: string): any => { const node = container.querySelector(selector); assert(node, `Missing ${selector}`); return node; };
const button = (label: string): any => { const node = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent.trim() === label); assert(node, `Missing button ${label}`); return node; };
const click = (node: any) => act(async () => node.click());
try {
  await act(async () => root.render(render(false)));
  assert.equal(container.querySelector(".document-child-nodes-icon"), null, "Without a handler the action is hidden.");
  await act(async () => root.render(render(true)));
  await click(element(".document-child-nodes-icon"));
  const rows = [...container.querySelectorAll(".document-child-nodes li")];
  assert.deepEqual(rows.map((row: any) => row.querySelector('input[type="text"]').value), ["Kafka", "SQS", "Redis"]);
  assert(rows.every((row: any) => row.querySelector('input[type="checkbox"]').checked), "Every proposal starts picked.");
  checks.push("the AI response offers its sections as picked child-node proposals");
  await click(rows[1].querySelector('input[type="checkbox"]'));
  await act(async () => {
    const input = rows[2].querySelector('input[type="text"]') as any;
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, "Redis streams");
    input.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  await click(button("Create 2 child nodes"));
  assert.deepEqual(created.at(-1)!.map((item) => item.title), ["Kafka", "Redis streams"]);
  assert.match(element(".document-child-nodes-done").textContent, /Created 2 child nodes/);
  checks.push("unpicked proposals are skipped and edited titles are used");
  await click(element(".document-prompt-icon"));
  assert.equal(container.querySelector(".document-child-nodes"), null, "Opening prompt history closes the preview.");
  await click(button("Make child nodes…"));
  assert(element(".document-child-nodes"), "Prompt history also offers the action.");
  checks.push("prompt history offers the same action");
  const kafka = created[0][0];
  anchors = [{ branchConversationId: "kafka", title: "Kafka", anchor: { id: "a", sourceConversationId: conversation.id, sourceMessageId: "answer", sourceBlockId: kafka.blockId, startOffset: kafka.from, endOffset: kafka.to, quote: "Kafka", prompt: "", createdAt: date } }];
  await act(async () => root.render(render(true)));
  await click(element(".document-child-nodes-icon"));
  await click(element(".document-child-nodes-icon"));
  const again = [...container.querySelectorAll(".document-child-nodes li")] as any[];
  assert.equal(again[0].querySelector('input[type="checkbox"]').disabled, true);
  assert.equal(again[0].querySelector('input[type="checkbox"]').checked, false);
  assert.match(again[0].textContent, /Already a child node/);
  assert(button("Create 2 child nodes"), "Only passages without a child are picked again.");
  checks.push("passages that already have a child are not offered again");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
process.exit(0);
