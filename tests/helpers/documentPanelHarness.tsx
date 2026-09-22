import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { Conversation, SelectionDraft } from "../../client/src/types";

const browser = new Window({ url: "http://document-panel.test" });
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
const { ConversationGroupSelect } = await import("../../client/src/components/ConversationGroupControls");
const { createMainConversation } = await import("../../client/src/initialState");
const { getEditableDocument, insertDocumentGeneration } = await import("../../client/src/lib/editableDocument");
const { buildEditableDocumentOutline } = await import("../../client/src/lib/chatOutline");
const date = "2026-09-20T00:00:00.000Z";
const initial = createMainConversation({ id: "document-panel", createdAt: date });
initial.messages = [
  { id: "question", role: "user", content: "Suggest a next step.", createdAt: date },
  { id: "answer", role: "assistant", content: "Keep one useful idea.", createdAt: date },
];
initial.document = getEditableDocument(initial);
initial.document.blocks.push({ id: "empty", kind: "markdown", content: "", createdAt: date, updatedAt: date });
let latest: Conversation = initial;
let replaceConversation: (value: Conversation) => void;
const submissions: any[] = [];
const acceptances: string[] = [];
const undo: string[] = [];
const opens: string[] = [];
const checks: string[] = [];
let selectedDraft: SelectionDraft | null = null;
let selectionClearCount = 0;
let documentChanges = 0;
function Host() {
  const [conversation, setConversation] = useState(initial);
  latest = conversation;
  replaceConversation = setConversation;
  return createElement(DocumentPanel, {
    conversation, isActive: true, isSubmitting: false, aiControls: null,
    groupControl: createElement(ConversationGroupSelect, { conversationId: conversation.id, groups: {}, onAssign() {} }), recentModelSelections: [], anchors: [], theme: "light",
    onChange: (document) => { documentChanges++; setConversation((current) => ({ ...current, document })); }, onRename: () => {},
    onSubmit: (request) => submissions.push(request), onStop: () => {},
    onSelection: (selection) => { selectedDraft = selection; },
    onClearSelection: () => { selectionClearCount++; selectedDraft = null; },
    onOpenBranch: (id) => opens.push(id), onOpenNote: () => {}, onModelChange: () => {}, onUpload: () => {}, onRemoveAttachment: () => {},
    onAcceptVersion: (id) => acceptances.push(id), onUndoInsertion: (id) => undo.push(id), registerPanelRef: () => {}, registerAnchorRef: () => {}, registerBranchOriginRef: () => {},
  });
}
const container = browser.document.createElement("div");
browser.document.body.append(container);
const selectedPassagePrompt = browser.document.createElement("textarea");
selectedPassagePrompt.setAttribute("aria-label", "Selected passage prompt");
browser.document.body.append(selectedPassagePrompt);
const root = createRoot(container as unknown as Element);
function element(selector: string): any { const node = container.querySelector(selector); assert(node, `Missing ${selector}`); return node; }
function button(label: string): any { const node = [...container.querySelectorAll("button")].find((candidate) => candidate.textContent.trim() === label); assert(node, `Missing button ${label}`); return node; }
function editor(id: string): any { return element(`[data-document-block-id="${id}"] .tiptap`).editor; }
async function click(node: any) { await act(async () => node.click()); }
async function fill(label: string, value: string) {
  await act(async () => {
    const input = element(`textarea[aria-label="${label}"]`);
    Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
}
async function space(id: string) {
  await act(async () => { const value = editor(id); value.commands.focus(); value.commands.setTextSelection(value.state.doc.content.size - 1); });
  await settle();
  const clearsBeforeKey = selectionClearCount;
  await act(async () => { editor(id).view.dom.dispatchEvent(new browser.KeyboardEvent("keydown", { key: " ", bubbles: true, cancelable: true })); });
  return clearsBeforeKey;
}
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 10)); }); }
try {
  await act(async () => root.render(createElement(Host)));
  await settle();
  assert.equal(container.querySelectorAll(".document-prompt-icon").length, 1);
  assert.equal(container.querySelector(".document-prompt-history"), null, "Historical prompts start compact.");
  await act(async () => { const value = editor("message:answer"); value.commands.setTextSelection(value.state.doc.content.size - 1); value.commands.insertContent(" My manual refinement."); });
  const manual = latest.document!.blocks.find((block) => block.id === "message:answer")!.content;
  assert(manual.includes("My manual refinement."));
  assert.equal(latest.messages[1].content, "Keep one useful idea.", "Direct editing must leave generation history intact.");
  checks.push("current text is editable while historical output and compact prompt remain intact");

  await act(async () => { editor("message:answer").commands.focus(); });
  await settle();
  await act(async () => { editor("message:answer").commands.setTextSelection({ from: 1, to: 5 }); });
  assert.equal(selectedDraft?.quote, "Keep");
  assert.equal(selectedDraft?.sourceBlockId, "message:answer");
  await act(async () => { editor("message:answer").commands.setTextSelection(5); });
  assert.equal(selectedDraft, null, "Collapsing the caret clears the old selected-passage draft.");
  await act(async () => { editor("message:answer").commands.setTextSelection({ from: 1, to: 5 }); });
  const selectedBeforeFocus = selectedDraft;
  await act(async () => { selectedPassagePrompt.focus(); });
  assert(selectedDraft === selectedBeforeFocus && selectedDraft?.quote === "Keep", "Moving focus into a selected-passage prompt preserves its saved draft.");
  checks.push("collapsed caret clears selection while prompt focus preserves the selected draft");

  const clearsBeforeInvocation = await space("empty");
  assert(selectionClearCount > clearsBeforeInvocation, "A new AI invocation explicitly clears the older selected-passage popup.");
  assert.equal(selectedDraft, null);
  assert(browser.document.activeElement === element('textarea[aria-label="AI prompt"]'), "AI textarea receives focus");
  await fill("AI prompt", "Add a practical action.");
  await click(button("Generate ↑"));
  assert.equal(submissions.at(-1).destination, "inline");
  assert.equal(submissions.at(-1).blockId, "empty");
  assert.equal(submissions.at(-1).prompt, "Add a practical action.");
  assert.equal(container.querySelector(".document-ai-composer"), null);
  checks.push("Space opens focused inline AI and submits the insertion location");

  await space("empty");
  await fill("AI prompt", "Explore an alternative.");
  await click(button("Side document ↗"));
  await click(button("Generate ↑"));
  assert.equal(submissions.at(-1).destination, "side");
  assert.equal(latest.document!.blocks.find((block) => block.id === "message:answer")!.content, manual);
  checks.push("side-document destination submits without replacing current authored text");

  await click(element(".document-prompt-icon"));
  await fill("Saved AI prompt", "Try a shorter next step.");
  await click(button("↻ Try another version"));
  const original = latest.document!.generations[0];
  assert.equal(submissions.at(-1).rerunGenerationId, original.id);
  assert.equal(submissions.at(-1).prompt, "Try a shorter next step.");
  assert.equal(latest.document!.prompts[0].content, "Suggest a next step.");
  checks.push("rerun submits edited instructions without overwriting its saved prompt");

  // Match Workspace: a rerun stores a new prompt while its generation points
  // back to the original generation. The old text stays until explicit accept.
  const alternate: Conversation = { ...latest, messages: [...latest.messages, { id: "candidate-answer", role: "assistant", content: "Write one sentence.\n\nThen try it.", createdAt: date }], document: {
    ...latest.document!, prompts: [...latest.document!.prompts, { ...latest.document!.prompts[0], id: "candidate-prompt", content: "Try a shorter next step.", sourceMessageId: undefined }],
    generations: [...latest.document!.generations, { ...original, id: "candidate", promptId: "candidate-prompt", messageId: "candidate-answer", alternativeOf: original.id, acceptedAt: undefined, blockIds: [], insertion: { blockId: "message:answer", offset: manual.length } }],
  } };
  await act(async () => replaceConversation({ ...alternate, document: { ...alternate.document!, generations: alternate.document!.generations.map((generation) => generation.id === "candidate" ? { ...generation, status: "failed" } : generation) } }));
  assert(element(".document-alternative").textContent.includes("Write one sentence."), "A failed partial response remains available for inspection.");
  assert.equal(button("Use this version").disabled, true, "Partial failed alternatives cannot be accepted.");
  await click(button("Use this version"));
  assert.deepEqual(acceptances, [], "Clicking a disabled failed alternative never requests acceptance.");
  assert.equal(editor("message:answer").getMarkdown(), manual);
  checks.push("failed partial alternatives stay inspectable but cannot replace the document");
  await act(async () => replaceConversation(alternate));
  assert.equal(container.querySelectorAll(".document-prompt-icon").length, 1, "The candidate shares the original version control.");
  assert(element(".document-alternative").textContent.includes("Write one sentence."));
  assert.equal(editor("message:answer").getMarkdown(), manual);
  await click(button("Use this version"));
  assert.deepEqual(acceptances, ["candidate"]);
  assert.equal(editor("message:answer").getMarkdown(), manual, "The control delegates acceptance; rendering an alternative never replaces text.");
  await act(async () => replaceConversation(insertDocumentGeneration(latest, "candidate")));
  assert(latest.document!.blocks.some((block) => block.content.includes("Write one sentence.")));
  assert.equal(latest.document!.blocks.find((block) => block.id === "message:answer")!.content, manual);
  const acceptedOutline = buildEditableDocumentOutline(latest);
  const renderedPromptIds = [...container.querySelectorAll(".document-prompt-marker")].map((node) => node.getAttribute("data-chat-outline-id"));
  assert.deepEqual(acceptedOutline.filter((item) => item.kind === "prompt").map((item) => item.id), renderedPromptIds, "Accepted alternatives expose only prompt navigation targets that actually render.");
  const candidateBlocks = latest.document!.blocks.filter((block) => block.generationId === "candidate");
  assert(candidateBlocks.length > 1);
  assert.equal(acceptedOutline.filter((item) => item.kind === "response" && candidateBlocks.some((block) => item.id === `message-document:${block.id}`)).length, 1, "All paragraphs of the accepted version share one response entry.");
  await click(button("Undo insertion"));
  assert.deepEqual(undo, ["candidate"]);
  checks.push("alternative preview, explicit acceptance, and undo preserve existing manual edits");

  await act(async () => replaceConversation({ ...latest, parentId: "source", branchAnchor: { id: "anchor", sourceConversationId: "source", sourceMessageId: "source-message", sourceBlockId: "source-block", startOffset: 0, endOffset: 13, quote: "A source idea", prompt: "Explore it", createdAt: date } }));
  await click(button("← Source document"));
  assert.deepEqual(opens, ["source"]);
  assert.equal(element(".document-origin span").textContent, "A source idea");
  assert(editor("message:answer").isEditable);
  checks.push("side documents retain the same editor with source navigation");

  const emptyConversation = createMainConversation({ id: 'new-empty-document', createdAt: date });
  await act(async () => replaceConversation(emptyConversation));
  await settle();
  const emptyBlockId = getEditableDocument(latest).blocks[0].id;
  const changesBeforeFocus = documentChanges;
  await act(async () => editor(emptyBlockId).commands.focus());
  await settle();
  assert.equal(documentChanges, changesBeforeFocus, "A projected empty document remains unsaved when merely focused");
  assert.equal(latest.document, undefined);
  assert.equal(container.querySelector('.rich-document-hint, .rich-document-add'), null);
  assert.equal(container.querySelector('.document-header-details > span'), null, "The header omits the redundant Document label");
  assert(element('.document-header-details button[aria-label="Group for conversation new-empty-document: Ungrouped"]'),
    "The compact group picker retains its accessible label");
  await act(async () => editor(emptyBlockId).commands.insertContent('A new idea written directly into the empty document.'));
  assert.equal(latest.document!.blocks[0].content, 'A new idea written directly into the empty document.');
  assert.equal(latest.messages.length, 0);
  checks.push("new documents start typing directly without blank-focus writes or redundant header labels");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
