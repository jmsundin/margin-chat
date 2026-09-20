import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { ConversationGroup } from "../../client/src/types";

const browser = new Window({ url: "http://group-picker.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "Document", "DocumentFragment", "MutationObserver", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "FocusEvent"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { ConversationGroupSelect, ConversationGroupPickerContext } = await import("../../client/src/components/ConversationGroupControls");
const { assignConversationToGroup } = await import("../../client/src/lib/conversationGroups");
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const assignments: unknown[] = [], creations: unknown[] = [];
let parentClicks = 0, parentPointers = 0, outsideMouseDowns = 0;
const outsideMouseDown = () => { outsideMouseDowns++; };
browser.document.addEventListener("mousedown", outsideMouseDown);
const baseGroups: Record<string, ConversationGroup> = {
  research: { id: "research", name: "Research", color: "#4fbf9f", collapsed: false, conversationIds: ["chat"] },
  reading: { id: "reading", name: "Reading", color: "#6f88ff", collapsed: false, conversationIds: [] },
  plans: { id: "plans", name: "Plans", color: "#e9945f", collapsed: false, conversationIds: [] },
};
function Host({ suggestion = { name: "Research", groupId: "research" } as {name: string; groupId?: string} | null, status = "ready", create = true }) {
  const [groups, setGroups] = useState(baseGroups);
  return createElement(ConversationGroupPickerContext.Provider, { value: {
    getSuggestion: () => suggestion, status,
    onCreateAndAssign: create ? (id: string, name: string) => creations.push([id, name]) : undefined,
  } }, createElement("div", { onClick: () => parentClicks++, onPointerDown: () => parentPointers++ },
    createElement(ConversationGroupSelect, { conversationId: "chat", groups, onAssign: (id: string, groupId: string | null) => {
      assignments.push([id, groupId]);
      setGroups((current) => assignConversationToGroup(current, id, groupId));
    } }),
  ));
}
const render = async (props: Record<string, unknown> = {}) => { await act(async () => { root.render(createElement(Host, props)); }); };
const trigger = () => container.querySelector<HTMLButtonElement>('.conversation-group-trigger')!;
const dialog = () => browser.document.querySelector('[role="dialog"]');
const search = () => browser.document.querySelector<HTMLInputElement>('[role="combobox"]')!;
const options = () => [...browser.document.querySelectorAll('[role="option"]')];
const open = async () => {
  trigger().focus();
  await act(async () => {
    trigger().dispatchEvent(new browser.PointerEvent("pointerdown", { bubbles: true }));
    trigger().dispatchEvent(new browser.MouseEvent("mousedown", { bubbles: true }));
    trigger().click();
  });
};
const type = async (value: string) => {
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(search(), value);
    search().dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
};
const key = async (value: string, shiftKey = false) => {
  await act(async () => { browser.document.activeElement!.dispatchEvent(new browser.KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true })); });
};
const checks: string[] = [];
try {
  await render();
  assert.equal(container.querySelector('select'), null);
  await open();
  assert.equal(browser.document.activeElement, search());
  assert.equal(search().getAttribute('aria-controls'), browser.document.querySelector('[role="listbox"]')!.id);
  assert.equal(options().filter((option) => option.textContent?.includes('Research')).length, 1);
  const suggested = browser.document.querySelector('.is-suggested')!;
  assert.equal(suggested.getAttribute('aria-selected'), 'true');
  assert(suggested.textContent?.includes('Suggested by Jev'));
  assert.deepEqual(assignments, []);
  assert.equal(parentClicks, 0);
  assert.equal(parentPointers, 0);
  assert.equal(outsideMouseDowns, 0);
  await type('Re');
  assert.equal(options().filter((option) => !option.querySelector('.group-picker-option-name')?.textContent?.startsWith('Create')).length, 2);
  await key('ArrowDown');
  const active = browser.document.getElementById(search().getAttribute('aria-activedescendant')!)!;
  assert.equal(active.querySelector('.group-picker-option-name')!.textContent, 'Reading');
  await key('Enter');
  assert.deepEqual(assignments, [['chat', 'reading']]);
  assert.equal(dialog(), null);
  assert.equal(browser.document.activeElement, trigger());
  assert.equal(parentClicks, 0);
  checks.push('search, active descendant keyboard selection, current suggested group, and preserved manual assignment');

  await open();
  await type('Ungrouped');
  await key('Enter');
  assert.deepEqual(assignments.at(-1), ['chat', null]);
  await render({ suggestion: { name: 'Product design' } });
  await open();
  const suggestedCreate = browser.document.querySelector<HTMLButtonElement>('.group-picker-option.is-suggested')!;
  assert(suggestedCreate.textContent?.includes('Create “Product design”'));
  await act(async () => {
    suggestedCreate.dispatchEvent(new browser.PointerEvent('pointerdown', { bubbles: true }));
    suggestedCreate.dispatchEvent(new browser.MouseEvent('mousedown', { bubbles: true }));
    suggestedCreate.click();
  });
  assert.deepEqual(creations, [['chat', 'Product design']]);
  assert.equal(dialog(), null);
  assert.equal(parentClicks, 0);
  assert.equal(parentPointers, 0);
  assert.equal(outsideMouseDowns, 0);
  checks.push('Ungrouped and suggested creation are explicit choices; portal events stay isolated');

  await render({ suggestion: null, status: 'unavailable', create: false });
  await open();
  assert(browser.document.querySelector('.group-picker-status')!.textContent?.includes('unavailable'));
  await type('No matching group');
  assert.equal(options().length, 0);
  assert.equal(search().hasAttribute('aria-activedescendant'), false);
  assert(browser.document.querySelector('.group-picker-empty'));
  await key('Enter');
  assert(dialog());
  await key('Tab');
  assert.equal(browser.document.activeElement?.getAttribute('aria-label'), 'Close group picker');
  await key('Tab', true);
  assert.equal(browser.document.activeElement, search());
  await key('Escape');
  assert.equal(dialog(), null);
  assert.equal(browser.document.activeElement, trigger());
  assert.equal(browser.document.body.style.overflow, '');
  checks.push('empty search, unavailable suggestion, bidirectional focus trap, Escape and focus restoration');

  await render({ suggestion: null });
  await open();
  await type('research');
  assert.equal(options().length, 1, 'An existing group should not offer duplicate creation.');
  await type('New collection');
  assert.equal(options().length, 1);
  await key('Enter');
  assert.deepEqual(creations.at(-1), ['chat', 'New collection']);
  checks.push('autocomplete creates new groups only on explicit selection and avoids exact-name duplicates');
  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => { root.unmount(); });
  browser.document.removeEventListener('mousedown', outsideMouseDown);
  await browser.happyDOM.close();
}
