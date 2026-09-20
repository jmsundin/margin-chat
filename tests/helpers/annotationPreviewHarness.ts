import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { Conversation, MessageAnchorLink } from "../../client/src/types";

const browser = new Window({ url: "http://annotation-preview.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "HTMLTextAreaElement", "Element", "Node", "Text", "NodeFilter", "Document", "DocumentFragment", "MutationObserver", "ResizeObserver", "Event", "MouseEvent", "KeyboardEvent", "Range", "DOMRect", "getComputedStyle"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value: name === "getComputedStyle" ? value.bind(browser) : value });
}
browser.requestAnimationFrame = () => 1;
browser.cancelAnimationFrame = () => undefined;
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: ChatPanel } = await import("../../client/src/components/ChatPanel");
const timestamp = "2026-09-19T00:00:00Z";
const conversation: Conversation = {
  id: "chat", title: "Annotations", parentId: null, childIds: [], branchAnchor: null, serviceId: "openai-api", modelId: "gpt-5",
  createdAt: timestamp, updatedAt: timestamp,
  messages: [
    { id: "question", role: "user", content: "Alpha beta gamma", createdAt: timestamp },
    { id: "answer", role: "assistant", content: "Alpha **beta** gamma", createdAt: timestamp },
  ],
  notes: [{ id: "note", kind: "comment", content: "A **private** thought", sourceMessageId: "answer", startOffset: 6, endOffset: 10, quote: "beta", createdAt: timestamp, updatedAt: timestamp }],
};
const link: MessageAnchorLink = {
  branchConversationId: "branch", title: "Investigate this", preview: { kind: "chat", prompt: "What does this mean?", content: "A useful explanation.", messageCount: 2 },
  anchor: { id: "anchor", sourceConversationId: "chat", sourceMessageId: "answer", startOffset: 2, endOffset: 10, quote: "pha beta", prompt: "", createdAt: timestamp },
};
const opened: string[] = [];
const openedNotes: string[] = [];
const props = {
  conversation, draft: "", isSubmitting: false, isActive: true, theme: "light" as const,
  anchorsByMessageId: { answer: [link], question: [link] }, recentModelSelections: [], typingProgressByMessageId: {}, typingMessageIds: {}, selectionPreview: null,
  onActivate() {}, onDraftChange() {}, onCreateNote() { return "new-note"; }, onDeleteNote() {}, onModelChange() {},
  onOpenBranch(id: string) { opened.push(id); }, onOpenNote(id: string) { openedNotes.push(id); },
  onStopStreaming() {}, onStopTypewriter() {}, onUpdateNote() {}, onUseNote() {}, onSubmit() {}, onTypewriterProgress() {}, onTypewriterComplete() {},
  registerPanelRef() {}, registerComposerSurfaceRef() {}, registerAnchorRef() {}, showMarginNotes: false, showBranchMargin: false,
};
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const dialog = () => browser.document.querySelector('[aria-label="Linked chat and note preview"]');
const assistantMark = () => container.querySelector('[data-message-id="answer"] [data-annotation-notes]')!;
const pause = () => new Promise((resolve) => setTimeout(resolve, 350));
const checks: string[] = [];

try {
  await act(async () => root.render(createElement(ChatPanel, props)));
  await act(async () => assistantMark().dispatchEvent(new browser.PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })));
  assert.equal(dialog(), null);
  await act(pause);
  assert(dialog()?.textContent?.includes("A useful explanation."));
  assert(dialog()?.textContent?.includes("A private thought"));
  checks.push("delayed hover includes both overlapping chat and note");

  await act(async () => {
    assistantMark().dispatchEvent(new browser.PointerEvent("pointerout", { bubbles: true, relatedTarget: dialog() }));
    dialog()!.dispatchEvent(new browser.PointerEvent("pointerover", { bubbles: true }));
  });
  await act(pause);
  assert(dialog());
  checks.push("moving into the preview keeps it readable");

  const updated = { ...props, conversation: { ...conversation, notes: [{ ...conversation.notes![0], content: "Updated note" }] }, anchorsByMessageId: { answer: [{ ...link, preview: { ...link.preview!, content: "Updated reply" } }], question: [link] } };
  await act(async () => root.render(createElement(ChatPanel, updated)));
  assert(dialog()?.textContent?.includes("Updated note"));
  assert(dialog()?.textContent?.includes("Updated reply"));
  checks.push("open preview follows current note and reply content");

  await act(async () => browser.document.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true })));
  assert.equal(dialog(), null);
  await act(async () => (assistantMark() as HTMLElement).focus());
  assert(dialog());
  assert(assistantMark().getAttribute("aria-describedby"));
  await act(async () => assistantMark().dispatchEvent(new browser.KeyboardEvent("keydown", { key: "ArrowDown", bubbles: true, cancelable: true })));
  assert(dialog()!.contains(browser.document.activeElement));
  await act(async () => browser.document.activeElement!.dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Escape", bubbles: true, cancelable: true })));
  assert.equal(dialog(), null);
  assert.equal(browser.document.activeElement, assistantMark());
  assert.equal(assistantMark().getAttribute("aria-describedby"), null);
  checks.push("keyboard preview, popup navigation and Escape restore focus");

  await act(async () => {
    assistantMark().dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true }));
  });
  assert.deepEqual(opened, ["branch"]);
  checks.push("existing branch keyboard navigation still works once");

  const userMark = container.querySelector('[data-message-id="question"] [data-annotation-branches]')!;
  await act(async () => (userMark as HTMLElement).focus());
  assert(dialog()?.textContent?.includes("A useful explanation."));
  await act(async () => container.querySelector(".panel-body")!.dispatchEvent(new browser.Event("scroll")));
  assert.equal(dialog(), null);
  checks.push("plain user highlights preview and scrolling dismisses");

  const range = browser.document.createRange();
  range.selectNodeContents(userMark);
  browser.getSelection().addRange(range);
  await act(async () => userMark.dispatchEvent(new browser.PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })));
  await act(pause);
  assert.equal(dialog(), null);
  await act(async () => userMark.dispatchEvent(new browser.MouseEvent("click", { bubbles: true })));
  assert.deepEqual(opened, ["branch"]);
  browser.getSelection().removeAllRanges();
  checks.push("text selection never opens a preview or navigates");

  await act(async () => root.render(createElement(ChatPanel, { ...props, anchorsByMessageId: {} })));
  await act(async () => (assistantMark() as HTMLElement).focus());
  assert(dialog()?.textContent?.includes("A private thought"));
  await act(async () => assistantMark().dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", bubbles: true, cancelable: true })));
  assert.deepEqual(openedNotes, ["note"]);
  assert.equal(dialog(), null);
  checks.push("note-only highlights preview and open using keyboard");

  await act(async () => assistantMark().dispatchEvent(new browser.PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })));
  await act(pause);
  assert(dialog());
  await act(async () => root.render(createElement(ChatPanel, { ...props, anchorsByMessageId: {}, conversation: { ...conversation, notes: [] } })));
  assert.equal(dialog(), null);
  checks.push("removed annotations dismiss stale preview");

  await act(async () => root.render(createElement(ChatPanel, props)));
  await act(async () => assistantMark().dispatchEvent(new browser.PointerEvent("pointerover", { bubbles: true, pointerType: "mouse" })));
  await act(async () => root.unmount());
  await act(pause);
  assert.equal(dialog(), null);
  checks.push("unmount cancels delayed previews");
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
