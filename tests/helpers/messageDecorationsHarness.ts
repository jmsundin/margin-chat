import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { ConversationNote, MessageAnchorLink } from "../../client/src/types";

const browser = new Window({ url: "http://message-decorations.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Text", "NodeFilter", "Document", "DocumentFragment", "MutationObserver", "Event", "MouseEvent", "KeyboardEvent"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: MarkdownMessage } = await import("../../client/src/components/MarkdownMessage");

const anchor: MessageAnchorLink = {
  branchConversationId: "branch",
  title: "Original branch",
  anchor: {
    id: "anchor", startOffset: 2, endOffset: 14, sourceConversationId: "conversation", sourceMessageId: "message",
    quote: "pha beta gam", prompt: "", createdAt: "2026-09-18T00:00:00Z",
  },
};
const note: ConversationNote = {
  id: "note", kind: "comment", startOffset: 6, endOffset: 10, sourceMessageId: "message", quote: "beta", content: "A note",
  createdAt: "2026-09-18T00:00:00Z", updatedAt: "2026-09-18T00:00:00Z",
};
const anchorRefs = new Map<string, HTMLSpanElement | null>();
const noteRefs = new Map<string, HTMLSpanElement | null>();
const opened: string[] = [];
const props = {
  anchors: [anchor], notes: [note], content: "Alpha **beta** gamma", conversationId: "conversation", messageId: "message",
  enableMermaidRendering: false, pendingSelection: null, theme: "light" as const,
  onOpenBranch(id: string) { opened.push(id); },
  registerAnchorRef(id: string, element: HTMLSpanElement | null) { anchorRefs.set(id, element); },
  registerNoteAnchorRef(id: string, element: HTMLSpanElement | null) { noteRefs.set(id, element); },
};
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const checks: string[] = [];

try {
  await act(async () => { root.render(createElement(MarkdownMessage, props)); });
  assert.equal([...container.querySelectorAll("[data-branch-conversation-id]")].map((mark) => mark.textContent).join(""), "pha beta gam");
  assert.equal(container.querySelector("strong .is-note-anchor")?.textContent, "beta");
  assert.equal(anchorRefs.get("branch")?.textContent, "pha ");
  assert.equal(noteRefs.get("note")?.textContent, "beta");
  checks.push("cross-node overlapping decorations");

  const renamedProps = { ...props, anchors: [{ ...anchor, title: "Renamed branch" }] };
  await act(async () => { root.render(createElement(MarkdownMessage, renamedProps)); });
  const marks = [...container.querySelectorAll("[data-branch-conversation-id]")];
  assert(marks.length > 1);
  assert(marks.every((mark) => mark.getAttribute("aria-label") === "Open branch Renamed branch"));
  assert(!container.innerHTML.includes("Open branch Original branch"));
  checks.push("title-only invalidation");

  await act(async () => {
    marks[0].dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
  });
  assert.deepEqual(opened, ["branch"]);
  checks.push("keyboard branch activation");

  await act(async () => { root.render(createElement(MarkdownMessage, { ...props, anchors: [], notes: [] })); });
  assert.equal(container.querySelectorAll("mark").length, 0);
  assert.equal(container.querySelector("strong")?.textContent, "beta");
  assert.equal(container.textContent, "Alpha beta gamma\n");
  assert.equal(anchorRefs.get("branch"), null);
  assert.equal(noteRefs.get("note"), null);
  checks.push("decoration removal preserves Markdown and clears refs");

  await act(async () => { root.render(createElement(MarkdownMessage, props)); });
  assert(anchorRefs.get("branch"));
  await act(async () => { root.unmount(); });
  assert.equal(anchorRefs.get("branch"), null);
  assert.equal(noteRefs.get("note"), null);
  checks.push("unmount cleanup");
  console.log(JSON.stringify({ checks }));
} catch (error) {
  await act(async () => { root.unmount(); });
  throw error;
} finally {
  await browser.happyDOM.close();
}
