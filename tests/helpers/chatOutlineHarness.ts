import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { Conversation } from "../../client/src/types";
import { buildChatOutline } from "../../client/src/lib/chatOutline";

const browser = new Window({ url: "http://chat-outline.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Document", "DocumentFragment", "MutationObserver", "Event", "MouseEvent", "KeyboardEvent"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("../../client/node_modules/react/index.js");
const { createRoot } = await import("../../client/node_modules/react-dom/client.js");
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
  assert.equal(container.querySelectorAll('.outline-conversation-section').length, 2);
  assert.equal(container.querySelectorAll('.outline-response-link').length, 3);
  assert.equal(container.querySelector('[aria-current="location"]')?.textContent, 'First week');
  assert.equal(container.querySelector('.is-current-response .outline-response-link')?.textContent, 'AI response 1');
  assert(container.querySelector('.outline-heading-level-3'));
  checks.push('prompts separate response groups while nested headings retain active location');

  await act(async () => { button('Collapse headings for ai response 1').click(); });
  assert.equal(container.querySelector('#outline-sections-message-answer-1'), null);
  assert.deepEqual(selected, []);
  await act(async () => { button('AI response 1').click(); });
  assert.deepEqual(selected, ['message-answer-1']);
  assert.equal(container.querySelector('#outline-sections-message-answer-1'), null, 'Jumping should not reopen headings.');
  await act(async () => { button('Expand headings for ai response 1').click(); });
  await act(async () => { button('First week').click(); });
  assert.deepEqual(selected, ['message-answer-1', 'heading-answer-1-1']);
  checks.push('response jumps and separate disclosure buttons never steal one another’s action');

  await act(async () => { button('Collapse headings').click(); });
  assert.equal(container.querySelectorAll('.outline-response-headings').length, 0);
  assert.equal(container.querySelectorAll('.outline-response-link').length, 3);
  await act(async () => { button('AI response 2').click(); });
  assert.equal(selected.at(-1), 'message-answer-2');
  await act(async () => { button('Prompt 2What should we measure?').click(); });
  assert.equal(selected.at(-1), 'message-prompt-2');
  await act(async () => { button('Expand headings').click(); });
  assert.equal(container.querySelectorAll('.outline-response-headings').length, 2);
  checks.push('response-only scan keeps every prompt and answer reachable and restores subdivisions');

  await act(async () => { root.render(createElement(ChatOutline, { ...props, items: items.filter((item) => item.kind === 'heading'), activeItemId: 'heading-answer-3-0' })); });
  assert.equal(container.querySelectorAll('.outline-response-link').length, 0);
  assert.equal(container.querySelectorAll('.outline-heading-link').length, 5);
  assert.equal(container.querySelector('[aria-current="location"]')?.textContent, 'Learning goals');
  checks.push('headings-only outlines remain navigable without invented AI response groups');
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => { root.unmount(); });
  await browser.happyDOM.close();
}
