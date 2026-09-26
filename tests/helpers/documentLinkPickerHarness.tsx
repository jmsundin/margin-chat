import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://document-link-picker.test", width: 375, height: 667 });
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement: el } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: DocumentLinkPicker } = await import("../../client/src/components/DocumentLinkPicker");
const { createStandaloneNoteConversation } = await import("../../client/src/initialState");
const timestamp = "2026-09-25T10:00:00.000Z";
function conversation(id: string, title: string, content: string[]) {
  return { ...createStandaloneNoteConversation({ id, noteId: `${id}-note` }), title,
    document: { schemaVersion: 1 as const, prompts: [], generations: [], blocks: content.map((text, index) => ({
      id: `${id}-${index}`, kind: "markdown" as const, content: text, createdAt: timestamp, updatedAt: timestamp,
    })) },
  };
}
const source = conversation("source", "Angular", ["## Selected source", "Other ideas"]);
const target = conversation("target", "Architecture", ["# Dependencies", "**Needles** in [haystacks](https://example.com)", ""]);
const empty = conversation("empty", "Draft", [""]);
const picked: { conversationId: string; blockId?: string }[] = [];
let cancelled = 0;
const props = { conversations: { source, target, empty }, sourceConversationId: "source", sourceBlockId: "source-0",
  onSelect: (value: { conversationId: string; blockId?: string }) => picked.push(value), onCancel: () => { cancelled += 1; } };
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const find = (label: string) => container.querySelector(`[aria-label="${label}"]`)!;
const input = () => container.querySelector<HTMLInputElement>("input")!;
async function click(element: any) { await act(async () => element.click()); }
async function press(element: any, key: string) {
  await act(async () => element.dispatchEvent(new browser.KeyboardEvent("keydown", { key, bubbles: true, cancelable: true })));
}
async function type(value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input(), value);
    input().dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
}

try {
  await act(async () => root.render(el(DocumentLinkPicker, props)));
  assert.equal(browser.document.activeElement, input());
  assert.equal(container.querySelectorAll(".document-link-picker-document").length, 3);
  await click(find("Connect to document Architecture"));
  assert.deepEqual(picked, [{ conversationId: "target" }], "A document target has no block ID");
  await click(find("Connect to document Draft"));
  assert.deepEqual(picked.at(-1), { conversationId: "empty" }, "Empty documents remain valid whole-document targets");
  assert.equal(container.querySelector('[aria-label="Browse blocks in Draft"]'), null);

  await type("needles");
  assert.equal(container.querySelectorAll(".document-link-picker-document").length, 1, "Search includes block text, not only titles");
  assert.equal(container.querySelector(".document-link-picker-preview")?.textContent, "Needles in haystacks");
  await press(input(), "ArrowDown");
  assert.equal(browser.document.activeElement, find("Connect to document Architecture"));
  await press(browser.document.activeElement, "ArrowDown");
  assert.equal(browser.document.activeElement, find("Browse blocks in Architecture"));
  await click(find("Browse blocks in Architecture"));
  assert.equal(browser.document.activeElement, input());
  assert.equal(input().value, "needles", "Browsing a body search preserves the matching block query");
  assert.equal(container.querySelectorAll(".document-link-picker-block").length, 1);
  assert.equal(container.querySelector(".document-link-picker-block-label")?.textContent, "Block 2");
  await click(container.querySelector(".document-link-picker-block"));
  assert.deepEqual(picked.at(-1), { conversationId: "target", blockId: "target-1" }, "A block selection retains its stable ID");
  await press(input(), "Escape");
  assert.equal(cancelled, 0, "Escape returns to documents before leaving the picker");
  assert.equal(input().value, "needles");
  await type("");
  assert.equal(container.querySelector('[aria-label="Connect to document Angular"]'), null, "The source cannot link to itself as a whole document");
  await click(find("Browse other blocks in Angular"));
  assert.equal(container.querySelectorAll(".document-link-picker-block").length, 1, "The exact source block is excluded");
  assert.equal(container.querySelector(".document-link-picker-block-label")?.textContent, "Block 2", "Block numbers retain their document positions");
  await click(container.querySelector(".document-link-picker-block"));
  assert.deepEqual(picked.at(-1), { conversationId: "source", blockId: "source-1" });
  await type("missing");
  assert.equal(container.querySelector('[role="status"]')?.textContent, "No matches. Try another search.");
  await click(find("Back to documents"));
  await press(input(), "Escape");
  assert.equal(cancelled, 1);
  await click(find("Cancel connection"));
  assert.equal(cancelled, 2);

  await act(async () => root.render(el(DocumentLinkPicker, { ...props, disabled: true, error: "The target was removed." })));
  assert.equal(container.querySelector('[role="alert"]')?.textContent, "The target was removed.");
  assert.equal(container.querySelector('[aria-busy="true"]')?.querySelectorAll("button:not(:disabled)").length, 0);
  assert.equal(input().disabled, true);

  await act(async () => root.render(el(DocumentLinkPicker, props)));
  await click(find("Browse blocks in Architecture"));
  await act(async () => root.render(el(DocumentLinkPicker, { ...props, conversations: { source, empty } })));
  assert.equal(container.querySelectorAll(".document-link-picker-block").length, 0, "A removed document cannot supply stale block targets");
  assert(container.textContent.includes("Connect to a document or block"));
  console.log("Document link picker checks passed.");
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
