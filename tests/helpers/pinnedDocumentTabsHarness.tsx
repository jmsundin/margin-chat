import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://pinned-tabs.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "DOMRect"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: DocumentTabs } = await import("../../client/src/components/DocumentTabs");
const { createMainConversation } = await import("../../client/src/initialState");
const date = "2026-09-23T00:00:00.000Z";
const pinned = { ...createMainConversation({ id: "pinned", createdAt: date }), title: "Pinned research" };
pinned.messages = [{ id: "old", role: "assistant", content: "Outdated historical answer", createdAt: date }];
pinned.document = { schemaVersion: 1, blocks: [{ id: "edited", kind: "markdown", content: "## Current findings\n\nThe latest edited document is used in this preview.", createdAt: date, updatedAt: date }], prompts: [], generations: [] };
const ordinary = { ...createMainConversation({ id: "ordinary", createdAt: date }), title: "Ordinary research" };
const selected: string[] = [];
const toggled: string[] = [];
const rootElement = browser.document.createElement("div");
browser.document.body.append(rootElement);
const root = createRoot(rootElement as unknown as Element);
const props = {
  documents: [pinned, ordinary], activeDocumentId: "ordinary", minimizedDocumentIds: [], pinnedDocumentIds: ["pinned"],
  onSelect: (id: string) => selected.push(id), onMinimize() {}, onReorder() {}, onNewSideDocument() {},
  onTogglePin: (id: string) => toggled.push(id),
};
function tab(id: string): any { return rootElement.querySelector(`[data-document-tab-id="${id}"] [role="tab"]`); }
function preview(): any { return browser.document.querySelector('.pinned-document-preview'); }
async function hover(target: any, type = 'pointerover', relatedTarget: any = null) {
  await act(async () => { target.dispatchEvent(new browser.PointerEvent(type, { pointerType: 'mouse', buttons: 0, bubbles: true, relatedTarget })); });
}
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 500)); }); }
async function key(target: any, value: string, shiftKey = false) {
  await act(async () => target.dispatchEvent(new browser.KeyboardEvent('keydown', { key: value, shiftKey, bubbles: true, cancelable: true })));
}
try {
  await act(async () => root.render(createElement(DocumentTabs, props)));
  assert(tab('pinned').getAttribute('aria-label').includes('Pinned research, pinned'));
  assert.equal(preview(), null);
  await hover(tab('pinned'));
  await settle();
  assert(preview());
  assert.equal(preview().parentElement, browser.document.body, 'Preview escapes the clipping tab strip.');
  assert(preview().textContent.includes('Pinned research'));
  assert(preview().textContent.includes('latest edited document'));
  assert(!preview().textContent.includes('Outdated historical answer'));
  assert.deepEqual(selected, [], 'Hovering does not select a document.');
  const card = preview();
  await hover(tab('pinned'), 'pointerout', card);
  await hover(card, 'pointerover', tab('pinned'));
  await settle();
  assert(preview(), 'The pointer can move onto the card without dismissing it.');
  await hover(card, 'pointerout', tab('ordinary'));
  await hover(tab('ordinary'), 'pointerover', card);
  await settle();
  assert.equal(preview(), null, 'Moving onto an ordinary tab dismisses the pinned preview.');
  await hover(tab('pinned'));
  assert(preview());
  await act(async () => tab('ordinary').focus());
  assert.equal(preview(), null, 'Focusing an ordinary tab dismisses the pinned preview.');
  await hover(tab('pinned'));
  await key(tab('pinned'), 'Escape');
  assert.equal(preview(), null);

  await act(async () => tab('pinned').focus());
  await settle();
  assert(preview(), 'Keyboard focus exposes the same document details.');
  await key(tab('pinned'), 'F10', true);
  assert.equal(preview(), null);
  assert(browser.document.querySelector('[role="menu"]'));
  assert(browser.document.querySelector('[role="menu"]')!.textContent.includes('Unpin document'));
  assert.deepEqual(selected, []);
  await key(browser.document.activeElement, 'Escape');
  await act(async () => tab('pinned').dispatchEvent(new browser.MouseEvent('contextmenu', { bubbles: true, cancelable: true })));
  assert(browser.document.querySelector('[role="menu"]'), 'A pinned icon retains its right-click document actions.');
  await act(async () => browser.document.querySelector<HTMLButtonElement>('[role="menuitem"]')!.click());
  assert.deepEqual(toggled, ['pinned']);

  await act(async () => tab('ordinary').focus());
  await hover(tab('ordinary'));
  await settle();
  assert.equal(preview(), null, 'Ordinary tabs keep their current presentation.');
  await hover(tab('pinned'));
  assert(preview());
  await act(async () => root.render(createElement(DocumentTabs, { ...props, pinnedDocumentIds: [] })));
  assert(!tab('pinned').closest('.is-pinned'));
  assert.equal(preview(), null, 'Unpinning removes the preview.');
  await act(async () => root.render(createElement(DocumentTabs, props)));
  assert.equal(preview(), null, 'Repinning does not restore a stale preview.');
  await hover(tab('pinned'));
  assert(preview());
  await act(async () => root.render(createElement(DocumentTabs, { ...props, documents: [ordinary] })));
  assert.equal(preview(), null, 'Removing a document removes its preview.');
  await act(async () => root.render(createElement(DocumentTabs, props)));
  assert.equal(preview(), null, 'Reopening a document does not restore a stale preview.');
  console.log('Pinned preview and context actions verified.');
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
