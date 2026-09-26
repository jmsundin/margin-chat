import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { GraphConcept, GraphEvidenceRef } from "../../client/src/lib/graphExploration";

const browser = new Window({ url: "http://graph-evidence.test/" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent", "HTMLInputElement", "HTMLTextAreaElement"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: GraphEvidenceView } = await import("../../client/src/components/GraphEvidenceView");
const { createMainConversation } = await import("../../client/src/initialState");
const { resolveGraphEvidence } = await import("../../client/src/lib/graphExploration");

const conversation = createMainConversation({ id: "source", createdAt: "2026-09-01T00:00:00.000Z" });
conversation.title = "Experiment report";
conversation.messages = [{ id: "message", role: "assistant", content: "Introduction.\n\nThe intervention improved retention by 15%.\n\nFurther research is needed.", createdAt: conversation.createdAt }];
const conversations = { source: conversation };
let concepts: GraphConcept[] = [];
let selectedConceptId: string | null = null;
let opened: GraphEvidenceRef | null = null;
let lens: "concepts" | "evidence" = "evidence";
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
function render() {
  root.render(createElement(GraphEvidenceView, { concepts, conversations, selectedConceptId, selectedConversationId: conversation.id, lens,
    onSelectConcept: (id) => { selectedConceptId = id; render(); },
    onSaveConcepts: (next) => { concepts = next; render(); }, onOpenEvidence: (evidence) => { opened = evidence; },
  }));
}
function element<T extends Element = Element>(selector: string): T {
  const result = container.querySelector(selector); assert.ok(result, `Missing ${selector}`); return result as unknown as T;
}
function button(text: string) {
  const result = [...container.querySelectorAll("button")].find((item) => item.textContent?.trim() === text);
  assert.ok(result, `Missing button ${text}`); return result;
}
async function click(target: any) { await act(async () => target.click()); }
async function input(target: HTMLInputElement, value: string) {
  await act(async () => {
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(target, value);
    target.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
}
await act(async () => render());
await click(button("Create your first claim"));
await input(element("form input"), "The intervention improves retention");
await act(async () => element("form").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
assert.equal(concepts.length, 1); assert.equal(concepts[0].kind, "claim");
await input(element('input[type="search"]'), "retention");
await click(element(".graph-evidence-results button"));
const textarea = element<HTMLTextAreaElement>(".graph-evidence-picker textarea");
const quote = "improved retention by 15%";
const start = textarea.value.indexOf(quote);
await act(async () => {
  textarea.focus();
  textarea.setSelectionRange(start, start + quote.length);
  textarea.dispatchEvent(new browser.KeyboardEvent("keyup", { key: "ArrowRight", bubbles: true }) as unknown as Event);
});
await act(async () => {
  const select = element<HTMLSelectElement>('[aria-label="New source evidence role"]');
  select.value = "supports";
  select.dispatchEvent(new browser.Event("change", { bubbles: true }) as unknown as Event);
});
await click(button("Attach selected passage"));
assert.equal(concepts[0].members.length, 1);
assert.equal(concepts[0].members[0].quote, quote);
assert.equal(concepts[0].members[0].relation, "supports");
assert.equal(resolveGraphEvidence(conversations, concepts[0].members[0]).status, "exact");
await click(element(".graph-evidence-source-open"));
assert.deepEqual(opened, concepts[0].members[0]);
await act(async () => {
  const select = element<HTMLSelectElement>('[aria-label="Evidence role for source 1"]');
  select.value = "challenges";
  select.dispatchEvent(new browser.Event("change", { bubbles: true }) as unknown as Event);
});
assert.equal(concepts[0].members[0].relation, "challenges");
assert.ok(container.querySelector('[data-evidence-role="challenges"] .graph-evidence-source'));

await act(async () => { lens = "concepts"; render(); });
await click(button("+ New concept"));
await input(element("form input"), "Retention");
await act(async () => element("form").dispatchEvent(new browser.Event("submit", { bubbles: true, cancelable: true }) as unknown as Event));
assert.equal(concepts.length, 2); assert.equal(concepts[1].kind, "concept");
await click(button("Attach selected document"));
assert.equal(concepts[1].members[0].conversationId, concepts[0].members[0].conversationId);
assert.equal(concepts[1].members[0].sourceKind, "conversation");
assert.ok(container.textContent.includes("Whole document · no passage anchor"));
await click(element('[aria-label="Remove source 1 from Retention"]'));
assert.equal(concepts[1].members.length, 0);
assert.equal(concepts[0].members.length, 1);
assert.equal(conversations.source.messages[0].content.includes(quote), true);
await act(async () => root.unmount());
browser.happyDOM.abort();
console.log("Evidence creation, exact passage selection, role changes, source navigation, overlap, and removal passed.");
