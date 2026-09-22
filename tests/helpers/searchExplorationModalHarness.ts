import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { Conversation, ConversationGroup, ThreadCategoryId } from "../../client/src/types";
import type { SearchEvidenceRef } from "../../client/src/lib/conversationSearch";

const browser = new Window({ url: "http://search-exploration.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "Text", "NodeFilter", "Document", "DocumentFragment", "MutationObserver", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "FocusEvent", "getComputedStyle"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value: name === "getComputedStyle" ? value.bind(browser) : value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: SearchModal } = await import("../../client/src/components/SearchModal");
const { buildSearchExploration } = await import("../../client/src/lib/conversationSearch");
const createdAt = "2026-09-19T12:00:00Z";
const conversations: Record<string, Conversation> = {};
const categories: Record<string, ThreadCategoryId> = {};
for (let index = 0; index < 45; index++) {
  const id = `chat-${String(index).padStart(2, "0")}`;
  conversations[id] = {
    id, title: `Archive ${index}`, branchAnchor: null, childIds: [], parentId: null, serviceId: "backend-services", modelId: "auto", createdAt, updatedAt: createdAt,
    messages: [{ id: `${id}-message`, role: "assistant", content: `# Background\n\n${index % 3 === 0 ? "We decided needle is the chosen option." : index % 3 === 1 ? "An alternative needle approach needs comparison." : "An unresolved needle question remains?"} **Passage ${index}**.`, createdAt }],
  };
  categories[id] = index % 2 ? "research" : "coding";
}
conversations["chat-00"].notes = [{ id: "private-note", kind: "comment", sourceMessageId: "chat-00-message", startOffset: null, endOffset: null, quote: null, content: "needle private annotation", createdAt, updatedAt: createdAt }];
conversations["standalone"] = { ...conversations["chat-00"], id: "standalone", title: "Standalone journal", kind: "note", messages: [], notes: [{ id: "standalone-body", kind: "standalone", sourceMessageId: null, startOffset: null, endOffset: null, quote: null, content: "needle in a standalone journal", createdAt, updatedAt: createdAt }] };
const groups: Record<string, ConversationGroup> = { launch: { id: "launch", name: "Launch", color: "#abc", collapsed: false, conversationIds: Object.keys(conversations).slice(0, 15) } };
const initialGroups = JSON.stringify(groups);
const opened: SearchEvidenceRef[] = [];
const legacyOpened: string[] = [];
let setOpen!: (value: boolean) => void;
let setQuery!: (value: string) => void;
let latestQuery = "";
let parentClicks = 0, parentPointers = 0;
let networkCalls = 0;
Object.defineProperty(globalThis, "fetch", { configurable: true, value: async () => { networkCalls++; throw new Error("Search without Jev must remain local."); } });

function Host() {
  const [open, updateOpen] = useState(false), [query, updateQuery] = useState("needle");
  setOpen = updateOpen; setQuery = updateQuery; latestQuery = query;
  return createElement("div", { onClick() { parentClicks++; }, onPointerDown() { parentPointers++; } },
    createElement("button", { id: "launch-search", onClick() { updateOpen(true); } }, "Open search"),
    createElement(SearchModal, { isOpen: open, onClose() { updateOpen(false); }, onQueryChange: updateQuery, onSelectResult(id: string) { legacyOpened.push(id); }, query, results: [], conversations, categories, groups, currentConversation: conversations["chat-00"], onOpenSource(source: SearchEvidenceRef) { opened.push(source); } }),
  );
}
const container = browser.document.createElement("div"); browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const dialog = () => browser.document.querySelector<HTMLElement>('[role="dialog"]')!;
const cards = () => [...dialog().querySelectorAll<HTMLElement>(".search-passage-card")];
const button = (label: string) => {
  const found = [...dialog().querySelectorAll<HTMLButtonElement>("button")].find((element) => (element.getAttribute("aria-label") ?? element.textContent?.trim()) === label);
  assert(found, `Missing button ${label}`); return found;
};
const click = async (element: Element) => { await act(async () => { (element as HTMLElement).click(); }); };
const input = () => dialog().querySelector<HTMLInputElement>('input[type="search"]')!;
const type = async (value: string) => { await act(async () => { Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input(), value); input().dispatchEvent(new browser.Event("input", { bubbles: true })); }); };
const key = async (element: Element, value: string, shiftKey = false) => { await act(async () => { element.dispatchEvent(new browser.KeyboardEvent("keydown", { key: value, shiftKey, bubbles: true, cancelable: true })); }); };
const facetButton = (label: string) => {
  const found = [...dialog().querySelectorAll<HTMLButtonElement>(".search-facet-chip")].find((element) => element.firstElementChild?.textContent === label);
  assert(found, `Missing facet ${label}`); return found;
};
const checks: string[] = [];
try {
  await act(async () => { root.render(createElement(Host)); });
  const trigger = container.querySelector<HTMLButtonElement>("#launch-search")!; trigger.focus();
  await act(async () => { setOpen(true); });
  assert.equal(browser.document.activeElement, input());
  assert.equal(dialog().querySelector("h2")?.textContent, "Search & explore");
  assert.equal(dialog().querySelector('[aria-label="Temporary search filters"]'), null, "Filters start minimized on desktop too.");
  assert.equal(dialog().querySelector(".search-filter-toggle")!.getAttribute("aria-expanded"), "false");
  await click(dialog().querySelector(".search-filter-toggle")!);
  assert(dialog().querySelector('[aria-label="Temporary search filters"]'), "The Filters button reveals the filter controls.");
  assert.equal(cards().length, 12);
  assert(dialog().querySelector(".search-pagination")!.textContent?.includes("of 47"));
  assert(dialog().querySelectorAll(".search-direction-card").length <= 3);
  const seen = new Set(cards().map((card) => card.dataset.searchResult));
  for (let page = 1; page < 4; page++) { await click(button("Next")); cards().forEach((card) => seen.add(card.dataset.searchResult)); }
  assert.equal(seen.size, 47, "Pagination must expose matches beyond the old forty-result cap.");
  assert.equal(button("Next").disabled, true);
  await click(button("Back in search"));
  assert(dialog().querySelector(".search-pagination")!.textContent?.includes("Page 3 of 4"));
  checks.push("all matches are paginated beyond forty and page navigation supports Back");

  await click(facetButton("Launch"));
  const expected = buildSearchExploration({ conversations, groups, categories, query: "needle", activeFacetIds: ["group:id:launch"] });
  assert(dialog().querySelector(".search-result-heading")!.textContent?.includes(`${expected.totalCount} passages`));
  assert.equal(facetButton("Launch").getAttribute("aria-pressed"), "true");
  assert.equal(JSON.stringify(groups), initialGroups, "Search facets must not change saved group assignments.");
  const queryBeforeConnections = latestQuery;
  await click(button("Connections"));
  assert(dialog().querySelector(".search-topic-neighborhood"));
  assert.equal(facetButton("Launch").getAttribute("aria-pressed"), "true");
  await click(dialog().querySelector(".search-topic-node")!);
  assert.equal(button("Passages").getAttribute("aria-selected"), "true");
  assert.equal(facetButton("Launch").getAttribute("aria-pressed"), "true");
  assert.equal(latestQuery, queryBeforeConnections);
  await click(button("Back in search"));
  assert.equal(button("Connections").getAttribute("aria-selected"), "true");
  assert.equal(dialog().querySelectorAll('.search-facet-chip[aria-pressed="true"]').length, 1, "Back restores the exact prior filters.");
  checks.push("temporary facet counts and Connections share query, filters, and reversible history");

  await click(button("Passages"));
  await click(button("Clear filters"));
  const first = cards()[0];
  const result = buildSearchExploration({ conversations, groups, categories, query: "needle" }).results.find((entry) => entry.id === first.dataset.searchResult)!;
  await click(first.querySelector(".search-passage-select")!);
  const renderedPassage = dialog().querySelector(".search-passage-detail blockquote")!.textContent!;
  assert(renderedPassage.length > 10);
  assert(!renderedPassage.includes("**"), "Markdown should read as formatted text in the passage preview.");
  await click(dialog().querySelector(".search-open-source")!);
  assert.deepEqual(opened, [result.evidence], "Opening a passage passes the exact canonical source, quote, and offsets.");
  assert.equal(browser.document.querySelector('[role="dialog"]'), null);
  assert.equal(browser.document.activeElement, trigger);
  await act(async () => { setOpen(true); });
  assert.equal(latestQuery, "needle");
  assert(dialog().querySelector(".search-passage-detail"), "The passage and search location survive opening a source and returning.");
  assert.equal(button("Back in search").disabled, false);
  checks.push("readable exact passage previews open canonical sources and preserve the return location");

  await click(dialog().querySelector(".search-context-toggle input")!);
  assert(dialog().querySelector(".search-result-heading")!.textContent?.includes("Current document given more weight"));
  assert(dialog().querySelector(".search-pagination")!.textContent?.includes("of 47"), "Context boosts must not exclude other chats.");
  await click(facetButton("Private notes"));
  assert.equal(cards().length, 1);
  await click(cards()[0].querySelector(".search-passage-select")!);
  assert(dialog().querySelector(".search-passage-private"));
  await click(dialog().querySelector(".search-open-source")!);
  assert.equal(opened.at(-1)?.sourceKind, "annotation");
  assert.equal(opened.at(-1)?.noteId, "private-note");
  assert.equal(networkCalls, 0, "Private/local searching must not make model requests when assistance is disabled.");
  checks.push("current-chat context boosts rather than filters and private note sources remain local");

  await act(async () => { setOpen(true); });
  await click(button("Clear filters"));
  await type("needle something-absent");
  assert.equal(cards().length, 0);
  assert(dialog().querySelector(".search-explore-empty")?.textContent?.includes("No passages match"));
  await click(button("Back in search"));
  assert.equal(latestQuery, "needle");
  assert(cards().length > 0);
  await act(async () => { setQuery(""); });
  assert.equal(dialog().querySelectorAll(".search-direction-card").length, 3);
  const direction = dialog().querySelector<HTMLElement>(".search-direction-card")!;
  await click(direction);
  assert(dialog().querySelectorAll('.search-facet-chip[aria-pressed="true"]').length > 0);
  assert(cards().length > 0, "Suggested directions must be grounded in available passages.");
  checks.push("query Back, actionable empty states, and grounded exploration directions");

  const close = button("Close search"); close.focus();
  await key(close, "Tab", true);
  const last = browser.document.activeElement!;
  assert.notEqual(last, close);
  assert(dialog().contains(last));
  await key(last, "Tab");
  assert.equal(browser.document.activeElement, close);
  await act(async () => { dialog().dispatchEvent(new browser.PointerEvent("pointerdown", { bubbles: true })); });
  assert.equal(parentClicks, 0); assert.equal(parentPointers, 0);
  await key(close, "Escape");
  assert.equal(browser.document.querySelector('[role="dialog"]'), null);
  assert.equal(browser.document.body.style.overflow, "");
  assert.equal(browser.document.activeElement, trigger);
  checks.push("modal traps focus, restores focus and scrolling, and isolates underlying pane events");

  await act(async () => { root.render(createElement(SearchModal, { isOpen: true, onClose() {}, onQueryChange() {}, onSelectResult(id: string) { legacyOpened.push(id); }, query: "legacy", results: [{ conversationId: "legacy-id", title: "Legacy result", preview: "Legacy passage", rootTitle: "Legacy result", matchLabel: "Message", locationLabel: "Main chat", updatedLabel: "today" }] })); });
  await click(cards()[0].querySelector(".search-passage-select")!);
  await click(dialog().querySelector(".search-open-source")!);
  assert.deepEqual(legacyOpened, ["legacy-id"], "The original result-only props retain their source-opening callback.");
  checks.push("existing result-only callers retain a useful fallback");

  const assistanceRequests: any[] = [];
  Object.defineProperty(globalThis, "fetch", { configurable: true, value: async (url: string, init: RequestInit) => {
    assert.equal(url, "/api/jev/search");
    const payload = JSON.parse(String(init.body));
    assistanceRequests.push(payload);
    return Response.json({ available: true, scores: payload.items.map((item: any, index: number) => ({ id: item.id, score: index / payload.items.length, confidence: 0.95 })), suggestedFacetIds: payload.facets.slice(0, 1).map((facet: any) => facet.id) });
  } });
  const assistedProps = { isOpen: true, onClose() {}, onQueryChange() {}, onSelectResult() {}, query: "needle", results: [], conversations, categories, groups, currentConversation: conversations["chat-00"], jev: { userId: "test-owner", enabled: true, ready: true, serviceStatus: "ready" as const } };
  await act(async () => { root.render(createElement(SearchModal, assistedProps)); });
  assert.equal(cards().length, 12, "Local results appear before optional judgments arrive.");
  assert(dialog().querySelector(".search-jev-status")!.textContent?.includes("refining"));
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); });
  assert.equal(assistanceRequests.length, 1);
  assert.equal(assistanceRequests[0].current, undefined, "Current-chat context is shared only after explicitly selecting it.");
  assert(assistanceRequests[0].items.every((item: any) => item.sourceKind !== "annotation" && !item.content.includes("private annotation")));
  assert(dialog().querySelector(".search-jev-status")!.textContent?.includes("Jev reviewed 20 passages"));
  await click(dialog().querySelector(".search-filter-toggle")!);
  assert(dialog().querySelector(".search-facet-suggestion"));
  assert.equal(dialog().querySelectorAll('.search-facet-chip[aria-pressed="true"]').length, 0, "Jev suggestions must never apply filters automatically.");
  const reviewedIds = new Set(assistanceRequests[0].items.map((item: any) => item.id));
  assert.equal(cards().find((card) => reviewedIds.has(card.dataset.searchResult))?.dataset.searchResult, assistanceRequests[0].items.at(-1).id, "Reviewed passages use the returned relevance order without moving private-result slots.");
  assert(dialog().querySelector(".search-pagination")!.textContent?.includes("of 47"), "Assistance must not alter complete local counts.");
  await click(dialog().querySelector(".search-context-toggle input")!);
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); });
  assert.equal(assistanceRequests.length, 2);
  assert.equal(assistanceRequests[1].current.title, conversations["chat-00"].title);
  await act(async () => { root.render(createElement(SearchModal, { ...assistedProps, isOpen: false })); });
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 550)); });
  assert.equal(assistanceRequests.length, 2, "A closed search cannot make assistance requests.");
  checks.push("Jev refines reviewed passages and suggests explicit filters without leaking private notes, changing counts, or requesting assistance while closed");
  console.log(JSON.stringify({ checks }));
} finally { await act(async () => { root.unmount(); }); await browser.happyDOM.close(); }
