import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { Conversation } from "../../client/src/types";
import { buildChatOutline, buildEditableDocumentOutline } from "../../client/src/lib/chatOutline";

const browser = new Window({ url: "http://chat-outline.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Document", "DocumentFragment", "MutationObserver", "Event", "MouseEvent", "KeyboardEvent"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: ChatOutline } = await import("../../client/src/components/ChatOutline");
const conversation = {
  messages: [
    { id: "prompt-1", role: "user", content: "Help me plan a launch" },
    { id: "answer-1", role: "assistant", content: "# Launch plan\n\n## First week\n\n### Interviews" },
    { id: "answer-2", role: "assistant", content: "Another answer without headings." },
    { id: "prompt-2", role: "user", content: "What should we measure?" },
    { id: "answer-3", role: "assistant", content: "## Learning goals\n\n### Retention" },
  ],
} as Conversation;
const items = buildChatOutline(conversation);
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const selected: string[] = [];
const props = { items, activeItemId: "heading-answer-1-1", onSelect(id: string) { selected.push(id); } };
const button = (label: string) => {
  const found = [...container.querySelectorAll("button")].find((element) => element.getAttribute("aria-label") === label || element.textContent?.trim() === label);
  assert(found, `Missing button: ${label}`);
  return found;
};
const checks: string[] = [];
try {
  await act(async () => { root.render(createElement(ChatOutline, props)); });
  assert.deepEqual([...container.querySelectorAll('button')].map((item) => item.textContent),
    ['Launch plan', 'First week', 'Interviews', 'Learning goals', 'Retention']);
  assert.equal(container.querySelector('[aria-current="location"]')?.textContent, 'First week');
  assert(container.querySelector('.outline-heading-level-3'));
  assert(!container.textContent?.includes('AI response'));
  assert(!container.textContent?.includes('Help me plan a launch'));
  checks.push('only document headings appear, in order and with their depth and active location');

  await act(async () => { button('First week').click(); });
  assert.deepEqual(selected, ['heading-answer-1-1']);
  await act(async () => { root.render(createElement(ChatOutline, { ...props, activeItemId: 'message-answer-2' })); });
  assert.equal(container.querySelector('[aria-current="location"]')?.textContent, 'Interviews');
  checks.push('heading jumps retain their targets and paragraph navigation retains the preceding heading');

  const documentItems = buildEditableDocumentOutline({ ...conversation, document: {
    schemaVersion: 1, prompts: [], generations: [], blocks: [
      { id: 'authored', kind: 'markdown', content: '# Written content', createdAt: '', updatedAt: '' },
      { id: 'prose', kind: 'markdown', content: 'A paragraph without headings.', createdAt: '', updatedAt: '' },
    ],
  } });
  await act(async () => { root.render(createElement(ChatOutline, { ...props, items: documentItems })); });
  assert.equal(container.textContent, 'Written content');
  await act(async () => { button('Written content').click(); });
  assert.equal(selected.at(-1), 'heading-document:authored-0');
  checks.push('editable document headings retain their targets without written section metadata');

  for (const emptyItems of [[], items.filter((item) => item.kind !== 'heading')]) {
    await act(async () => { root.render(createElement(ChatOutline, { ...props, items: emptyItems })); });
    assert.equal(container.querySelectorAll('button').length, 0);
    assert.equal(container.querySelector('.chat-outline-empty')?.textContent, 'Add headings to your document to see its outline.');
  }
  checks.push('empty and heading-free documents explain how to populate the outline');
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => { root.unmount(); });
  await browser.happyDOM.close();
}
