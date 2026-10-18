import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { Conversation } from "../../client/src/types";

const browser = new Window({ url: "http://agent-follow-up.test" });
browser.localStorage.setItem("margin-chat:document-editor", "classic");
Object.defineProperty(globalThis, "localStorage", { configurable: true, value: browser.localStorage });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Text", "Document", "DocumentFragment", "MutationObserver", "ResizeObserver", "Event", "MouseEvent", "KeyboardEvent", "Range", "DOMRect", "DOMParser", "getComputedStyle", "HTMLInputElement", "HTMLTextAreaElement", "ShadowRoot"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value: name === "getComputedStyle" ? value.bind(browser) : value });
}
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: (callback: FrameRequestCallback) => setTimeout(() => callback(0), 0) });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: clearTimeout });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: DocumentPanel } = await import("../../client/src/components/DocumentPanel");
await import("../../client/src/components/RichDocumentEditor");
const { createMainConversation } = await import("../../client/src/initialState");
const { getEditableDocument } = await import("../../client/src/lib/editableDocument");

const date = "2026-10-18T00:00:00.000Z";
const question = "Which plan do you mean?";
const initial = createMainConversation({ id: "plan-doc", createdAt: date });
initial.messages = [
  { id: "ask", role: "user", content: "Summarize the plan.", createdAt: date },
  { id: "reply", role: "assistant", content: question, createdAt: date, execution: {
    schemaVersion: 1, model: "muse-wonder-1.0", provider: "meta-api", mode: "balanced", task: "general", reason: "", profileVersion: "", sources: [], truncated: false, fallbacks: [], warnings: [],
    agent: { steps: [], stopReason: "question", question: { text: question, options: ["The 2025 plan", "The pricing plan"] }, proposals: [
      { id: "proposal-1", kind: "edit", documentId: "plan-doc", documentTitle: "Plans", find: "Summarize", replace: "Outline", summary: "Use a clearer verb" },
      { id: "proposal-2", kind: "create", parentId: "plan-doc", parentTitle: "Plans", title: "Pricing plan", content: "Tiers and prices.", summary: "Keep pricing in its own document" },
    ] },
  } },
];
initial.document = getEditableDocument(initial);
const request = initial.document.prompts[0].content;
const submissions: any[] = [];
const actions: string[] = [];
const checks: string[] = [];
let setAsking: (value: boolean) => void;
function Host() {
  const [asking, setAskingState] = useState(true);
  setAsking = setAskingState;
  const conversation: Conversation = asking ? initial : { ...initial, document: { ...initial.document!, generations: [...initial.document!.generations,
    { ...initial.document!.generations[0], id: "later", promptId: "later-prompt", messageId: "later-reply", blockIds: [] }] } };
  return createElement(DocumentPanel, {
    conversation, isActive: true, isSubmitting: false, aiControls: null, recentModelSelections: [], anchors: [], theme: "light",
    onChange: () => {}, onRename: () => {}, onSubmit: (value) => submissions.push(value), onStop: () => {}, onSelection: () => {},
    onOpenBranch: () => {}, onOpenNote: () => {}, onModelChange: () => {}, onUpload: () => {}, onRemoveAttachment: () => {},
    onAcceptVersion: () => {}, onUndoInsertion: () => {}, registerPanelRef: () => {}, registerAnchorRef: () => {}, registerBranchOriginRef: () => {},
    documentTitle: (id) => id === "plan-doc" ? "Plans" : undefined,
    onAgentProposal: (messageId, proposalId, action) => {
      actions.push(`${messageId}:${proposalId}:${action}`);
      return proposalId === "proposal-2" && action === "approve" ? "Open “Plans” first, then try again." : null;
    },
  });
}
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
function buttons(label: string): any[] { return [...container.querySelectorAll("button")].filter((candidate) => candidate.textContent.trim() === label); }
async function click(node: any) { await act(async () => node.click()); }
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }); }
try {
  await act(async () => root.render(createElement(Host)));
  await settle();
  const followUp = container.querySelector(".agent-follow-up");
  assert(followUp, "The follow-up shows under the agent's reply.");
  assert(followUp.closest("[data-after-block-id], .rich-document-block") ?? followUp.parentElement, "It sits with the reply's block.");
  assert.equal(buttons("The 2025 plan").length, 1);
  await click(buttons("The 2025 plan")[0]);
  const replyBlock = initial.document.blocks.find((block) => block.generationId === initial.document!.generations[0].id || block.sourceMessageId === "reply")!;
  assert.deepEqual(submissions[0], { blockId: replyBlock.id, from: 0, to: replyBlock.content.length, quote: replyBlock.content, prompt: "The 2025 plan",
    destination: "inline", replaceSelection: true, sourceContent: replyBlock.content, agentAnswer: { question, request } });
  checks.push("a suggested answer replaces the question and tells the agent what it asked about which request");

  const input = container.querySelector('input[aria-label="Your answer"]') as any;
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, "Both, briefly");
    input.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  await click(buttons("Answer")[0]);
  assert.equal(submissions[1].prompt, "Both, briefly");
  checks.push("a typed answer is sent the same way");

  assert(container.textContent.includes("2 proposed changes"));
  assert(container.textContent.includes("Use a clearer verb"));
  assert(container.textContent.includes("Edit this document"));
  assert(container.textContent.includes("New document “Pricing plan”"));
  await click(buttons("Approve")[0]);
  assert.deepEqual(actions, ["reply:proposal-1:approve"]);
  await click(buttons("Approve")[1]);
  assert(container.querySelector('[role="alert"]')?.textContent.includes("Open “Plans” first"), "A failed approval says why.");
  await click(buttons("Dismiss")[1]);
  assert.deepEqual(actions.slice(-1), ["reply:proposal-2:dismiss"]);
  assert.equal(container.querySelector('[role="alert"]'), null, "The error clears once the proposal is handled.");
  checks.push("each proposal can be approved or dismissed, and a failure is explained");

  await act(async () => setAsking(false));
  await settle();
  assert.equal(container.querySelector('input[aria-label="Your answer"]'), null, "A question already followed by another reply isn't offered again.");
  assert(container.querySelector(".agent-proposals"), "Its proposals still show.");
  checks.push("a question is only answerable while it is the latest reply");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
