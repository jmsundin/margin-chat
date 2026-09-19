import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { Conversation, MessageAnchorLink, SelectionDraft } from "../../client/src/types";

const browser = new Window({ url: "http://chat-panel.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Text", "NodeFilter", "Document", "DocumentFragment", "MutationObserver", "ResizeObserver", "Event", "MouseEvent", "KeyboardEvent", "WheelEvent", "Range", "DOMRect", "getComputedStyle"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value: name === "getComputedStyle" ? value.bind(browser) : value });
}
browser.requestAnimationFrame = () => 1;
browser.cancelAnimationFrame = () => undefined;
Object.defineProperty(globalThis, "requestAnimationFrame", { configurable: true, value: browser.requestAnimationFrame });
Object.defineProperty(globalThis, "cancelAnimationFrame", { configurable: true, value: browser.cancelAnimationFrame });
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, useState } = await import("../../client/node_modules/react/index.js");
const { createRoot } = await import("../../client/node_modules/react-dom/client.js");
const { default: ChatPanel } = await import("../../client/src/components/ChatPanel");
const { ConversationGroupSelect } = await import("../../client/src/components/ConversationGroupControls");

const conversation: Conversation = {
  id: "chat", title: "Review", parentId: null, childIds: [], branchAnchor: null,
  serviceId: "openai-api", modelId: "gpt-5", createdAt: "2026-09-19T00:00:00Z", updatedAt: "2026-09-19T00:00:00Z",
  messages: [{ id: "answer", role: "assistant", content: "A **focused** response.", createdAt: "2026-09-19T00:00:00Z" }],
  documents: [{ id: "document", filename: "Research.pdf", mimeType: "application/pdf", size: 42, status: "ready" } as any],
  notes: [{ id: "margin-note", kind: "comment", content: "Remember this detail", sourceMessageId: "answer", startOffset: 2, endOffset: 9, quote: "focused", createdAt: "2026-09-19T00:00:00Z", updatedAt: "2026-09-19T00:00:00Z" }],
};
let setSubmitting!: (submitting: boolean) => void;
let setShowMarginNotes!: (show: boolean) => void;
let setConversation!: (conversation: Conversation) => void;
let setTyping!: (typing: Record<string, boolean>) => void;
const anchorRefs = new Map<string, HTMLSpanElement | null>();
const messageLinks: MessageAnchorLink[] = ["first-branch", "second-branch"].map((id) => ({
  branchConversationId: id, title: id,
  anchor: { id: `${id}-anchor`, quote: "A focused response.", prompt: "Explore this", startOffset: 0, endOffset: 0, sourceConversationId: "chat", sourceMessageId: "answer", createdAt: "2026-09-19T00:00:00Z" },
}));
let currentDraft = "";
const sent: string[] = [];
const resubmitted: Array<[string, string]> = [];
const branches: SelectionDraft[] = [];
const removed: string[] = [];
const deleted: string[] = [];
let stopped = 0;
let confirmation = false;
let confirmationText = "";
browser.confirm = (message?: string) => { confirmationText = message ?? ""; return confirmation; };

function Host() {
  const [draft, updateDraft] = useState("");
  const [isSubmitting, updateSubmitting] = useState(true);
  const [showMarginNotes, updateShowMarginNotes] = useState<boolean | undefined>();
  const [currentConversation, updateConversation] = useState(conversation);
  const [typingMessageIds, updateTyping] = useState<Record<string, boolean>>({});
  currentDraft = draft;
  setSubmitting = updateSubmitting;
  setShowMarginNotes = updateShowMarginNotes;
  setConversation = updateConversation;
  setTyping = updateTyping;
  return createElement(ChatPanel, {
    conversation: currentConversation, draft, isSubmitting, isActive: true, theme: "light", anchorsByMessageId: { answer: messageLinks },
    aiControls: createElement("div", { "data-testid": "ai-context-controls" }, "Private context settings"),
    groupControl: createElement(ConversationGroupSelect, { conversationId: currentConversation.id, groups: {}, onAssign() {} }),
    showMarginNotes, showBranchMargin: false,
    recentModelSelections: [], typingProgressByMessageId: {}, typingMessageIds, selectionPreview: null,
    onActivate() {}, onAddSideChat() {}, onDraftChange: updateDraft, onCreateNote() { return "note"; },
    onDeleteNote() {}, onDeleteDocument(id: string) { removed.push(id); },
    onDeleteDocumentEverywhere(id: string) { deleted.push(id); }, onModelChange() {}, onOpenBranch() {},
    onStopStreaming() { stopped++; }, onStopTypewriter() {}, onUpdateNote() {}, onUseNote() {},
    onSubmit(_id: string, value: string) { sent.push(value); }, onTypewriterProgress() {}, onTypewriterComplete() {},
    onResubmitPrompt(id: string, messageId: string) { resubmitted.push([id, messageId]); },
    onBranchFromMessage(draft: SelectionDraft) { branches.push(draft); },
    registerPanelRef() {}, registerComposerSurfaceRef() {}, registerAnchorRef(id: string, element: HTMLSpanElement | null) { anchorRefs.set(id, element); },
  });
}

const paneActivations: string[] = [];
const paneSubmissions: Array<[string, string]> = [];
const paneModels: Array<[string, string, string]> = [];
function TwoPaneHost() {
  const [activePane, setActivePane] = useState("side");
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  return createElement("div", null, ...["main", "side"].map((id) => createElement("div", { key: id, "data-pane": id }, createElement(ChatPanel, {
    conversation: { ...conversation, id, parentId: id === "side" ? "main" : null, notes: [], documents: [] },
    draft: drafts[id] ?? "", isSubmitting: false, isActive: id === activePane, theme: "light", anchorsByMessageId: {},
    recentModelSelections: [], typingProgressByMessageId: {}, typingMessageIds: {}, selectionPreview: null,
    onActivate() { paneActivations.push(id); setActivePane(id); }, onDraftChange(value: string) { setDrafts((current) => ({ ...current, [id]: value })); },
    onCreateNote() { return "note"; }, onDeleteNote() {}, onModelChange(conversationId: string, service: string, model: string) { paneModels.push([conversationId, service, model]); },
    onOpenBranch() {}, onStopStreaming() {}, onStopTypewriter() {}, onUpdateNote() {}, onUseNote() {},
    onSubmit(conversationId: string, value: string) { paneSubmissions.push([conversationId, value]); },
    onTypewriterProgress() {}, onTypewriterComplete() {}, registerPanelRef() {}, registerComposerSurfaceRef() {}, registerAnchorRef() {},
  }))));
}

const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const checks: string[] = [];
function button(label: string) {
  const result = [...container.querySelectorAll("button")].find((element) => element.getAttribute("aria-label") === label || element.textContent?.trim() === label);
  assert(result, `Missing button ${label}`);
  return result;
}

try {
  await act(async () => { root.render(createElement(Host)); });
  const textarea = container.querySelector("textarea")!;
  assert.equal(textarea.disabled, false, "Streaming must not disable drafting.");
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value")!.set!;
    setter.call(textarea, "Follow up after this answer");
    textarea.dispatchEvent(new browser.Event("input", { bubbles: true }));
    textarea.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  assert.equal(currentDraft, "Follow up after this answer");
  assert.deepEqual(sent, []);
  assert.equal(stopped, 0, "Enter while drafting must not stop the current response.");
  await act(async () => { button("Stop assistant output").click(); });
  assert.equal(stopped, 1);
  await act(async () => { setSubmitting(false); });
  assert.equal(textarea.value, "Follow up after this answer");
  assert(container.querySelector(".composer-notes-button")!.nextElementSibling?.classList.contains("composer-group-control"));
  assert.equal(container.querySelector('[data-testid="ai-context-controls"]'), null);
  await act(async () => { container.querySelector<HTMLButtonElement>(".composer-service-pill")!.click(); });
  assert(browser.document.querySelector('[role="dialog"] [data-testid="ai-context-controls"]'));
  await act(async () => { browser.document.querySelector<HTMLButtonElement>('[aria-label="Close model picker"]')!.click(); });
  await act(async () => { textarea.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  assert.deepEqual(sent, ["Follow up after this answer"]);
  checks.push("draft survives response; Enter waits; Stop remains explicit");

  await act(async () => { button("Branch").click(); });
  await act(async () => { button("Use entire response").click(); });
  assert.equal(branches.length, 1);
  assert.equal(branches[0].quote, "A focused response.");
  assert.equal(branches[0].messageId, "answer");
  assert.equal(branches[0].startOffset, 0);
  assert.equal(branches[0].endOffset, 0);
  checks.push("whole response branches use rendered text and message-level anchors");

  await act(async () => { button("Branch").click(); });
  await act(async () => { button("Select a passage").click(); });
  assert(container.querySelector(".message-passage-hint"));
  assert.equal(branches.length, 1, "Selecting a passage waits for actual text selection.");
  checks.push("passage choice offers instructions without making an empty branch");

  await act(async () => { button("Remove Research.pdf from this chat").click(); });
  assert.deepEqual(removed, ["document"]);
  assert.deepEqual(deleted, []);
  await act(async () => { button("More actions for Research.pdf").click(); });
  await act(async () => { setSubmitting(true); });
  assert.equal(button("Delete from every chat…").disabled, true);
  await act(async () => { button("Delete from every chat…").click(); });
  assert.equal(confirmationText, "", "An open document menu must not permit deletion once a response starts.");
  await act(async () => { setSubmitting(false); });
  await act(async () => { button("Delete from every chat…").click(); });
  assert.deepEqual(deleted, [], "Dismissing confirmation must not delete the global document.");
  assert(confirmationText.includes("Research.pdf") && confirmationText.includes("every chat"));
  confirmation = true;
  await act(async () => { button("Delete from every chat…").click(); });
  assert.deepEqual(deleted, ["document"]);
  checks.push("remove-current and confirmed global delete are separate actions");

  const panelBody = container.querySelector(".panel-body")!;
  Object.defineProperty(panelBody, "clientHeight", { configurable: true, value: 300 });
  Object.defineProperty(panelBody, "scrollHeight", { configurable: true, value: 1500 });
  panelBody.scrollTop = 200;
  await act(async () => { panelBody.dispatchEvent(new browser.Event("scroll")); });
  assert(container.querySelector(".chat-jump-to-latest"));
  await act(async () => { container.querySelector<HTMLButtonElement>(".chat-jump-to-latest")!.click(); });
  assert.equal(panelBody.scrollTop, 1500);
  assert.equal(container.querySelector(".chat-jump-to-latest"), null);
  checks.push("latest response action appears away from bottom and restores position");

  assert(container.querySelector(".chat-panel.has-margin-rail"));
  assert(container.querySelector(".margin-note-card"));
  await act(async () => { setShowMarginNotes(false); });
  assert.equal(container.querySelector(".chat-panel.has-margin-rail"), null);
  assert.equal(container.querySelector(".message-with-margin.has-notes"), null);
  assert.equal(container.querySelector(".margin-note-card"), null);
  assert.equal(container.querySelector(".is-note-anchor")?.textContent, "focused");
  checks.push("external notes remove duplicated rail and preserve text highlights");

  assert(anchorRefs.get("first-branch"));
  assert.equal(anchorRefs.get("first-branch"), anchorRefs.get("second-branch"));
  assert(anchorRefs.get("first-branch")!.classList.contains("message-bubble"));
  checks.push("whole-response branches register distinct keys at their source message");

  const sourceQuote = "A long source sentence with relevant context. ".repeat(14);
  const prompt = "How should we apply this?";
  await act(async () => { setConversation({
    ...conversation,
    parentId: "source",
    branchAnchor: { id: "origin", sourceConversationId: "source", sourceMessageId: "source-message", startOffset: 0, endOffset: 0, quote: sourceQuote, prompt, createdAt: "2026-09-19T00:00:00Z" },
    messages: [{ id: "question", role: "user", content: prompt, createdAt: "2026-09-19T00:00:00Z" }, ...conversation.messages],
  }); });
  assert(container.querySelector(".branch-context-card blockquote")!.textContent!.length < 270);
  assert.equal(container.querySelector(".branch-context-prompt"), null);
  await act(async () => { button("Show full source quote").click(); });
  assert(container.querySelector(".branch-context-card blockquote")!.textContent!.includes(sourceQuote));
  await act(async () => { button("Show less").click(); });
  assert(container.querySelector(".branch-context-card blockquote")!.textContent!.length < 270);
  checks.push("branch origin quotes expand while repeated opening prompts stay omitted");

  const resend = button("Resend prompt");
  assert.equal(resend.closest(".message-row")?.getAttribute("data-message-row-id"), "question");
  assert.equal(resend.parentElement?.previousElementSibling?.classList.contains("message-with-margin"), true);
  assert.equal(resend.title, "Resend prompt");
  await act(async () => { resend.click(); });
  assert.deepEqual(resubmitted, [["chat", "question"]]);
  await act(async () => { setSubmitting(true); });
  assert.equal(resend.disabled, true);
  await act(async () => { resend.click(); });
  assert.equal(resubmitted.length, 1);
  await act(async () => { setSubmitting(false); setTyping({ answer: true }); });
  assert.equal(resend.disabled, true);
  await act(async () => { setTyping({}); });
  checks.push("resend sits beneath the user prompt and targets that prompt only when output is idle");

  await act(async () => { setConversation({ ...conversation, notes: [...conversation.notes!, {
    id: "saved-side-note", kind: "side-chat", content: "Keep this side note", sourceMessageId: null,
    createdAt: "2026-09-19T00:00:00Z", updatedAt: "2026-09-19T00:00:00Z",
  }] }); });
  await act(async () => { button("Open side notes").click(); });
  await act(async () => { button("Keep this side note").click(); });
  const minimize = container.querySelector<HTMLButtonElement>(".side-note-minimize-button")!;
  assert.equal(minimize.textContent, "Minimize");
  await act(async () => { minimize.click(); });
  assert.equal(container.querySelector(".side-note-panel"), null);
  await act(async () => { button("Open side notes").click(); });
  assert.equal(container.querySelector(".side-note-tab.is-active")?.textContent, "Keep this side note");
  assert(container.querySelector(".side-note-editor-shell")?.textContent?.includes("Keep this side note"));
  checks.push("labeled minimize control closes side notes and reopening retains the selected note");

  await act(async () => { root.render(createElement(TwoPaneHost)); });
  const main = container.querySelector('[data-pane="main"]')!;
  const side = container.querySelector('[data-pane="side"]')!;
  const mainTextarea = main.querySelector("textarea")!;
  assert.equal(mainTextarea.disabled, false);
  await act(async () => {
    mainTextarea.click(); mainTextarea.focus();
    Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value")!.set!.call(mainTextarea, "Continue the main thought");
    mainTextarea.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  let attachmentClicks = 0;
  main.querySelector('input[type="file"]')!.addEventListener("click", () => attachmentClicks++);
  await act(async () => { main.querySelector<HTMLButtonElement>('[aria-label="Attach documents"]')!.click(); });
  assert.equal(attachmentClicks, 1);
  await act(async () => { main.querySelector<HTMLButtonElement>(".composer-service-pill")!.click(); });
  assert(browser.document.querySelector('[role="dialog"]'));
  await act(async () => { browser.document.querySelector<HTMLButtonElement>(".picker-model-row")!.click(); });
  assert.equal(paneModels[0][0], "main");
  await act(async () => { mainTextarea.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })); });
  assert.deepEqual(paneSubmissions, [["main", "Continue the main thought"]]);
  assert.deepEqual(paneActivations, []);
  assert(side.querySelector(".chat-panel.is-active"));
  assert.equal(side.querySelector("textarea")!.value, "");
  checks.push("main composer editing, attachments, model changes and sending keep the side pane active");

  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => { root.unmount(); });
  assert.equal(anchorRefs.get("first-branch"), null);
  assert.equal(anchorRefs.get("second-branch"), null);
  await browser.happyDOM.close();
}
