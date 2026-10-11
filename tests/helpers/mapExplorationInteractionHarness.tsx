import { startMapsInGroupedView } from "./groupedMapDefault";
import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { AppState } from "../../client/src/types";
import { extractPage } from "../../server/urlMap/page.mjs";
import { validateGeneratedUrlMap } from "../../server/urlMap/index.mjs";
import { urlMapHtml, urlMapModelReply } from "./urlMapFixture";

const browser = new Window({ url: "http://map-exploration-interactions.test/" });
startMapsInGroupedView(browser.localStorage as unknown as Storage);
for (const name of ["window", "document", "navigator", "localStorage", "sessionStorage", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "ResizeObserver", "DOMRect"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperties(browser.HTMLElement.prototype, {
  clientWidth: { configurable: true, get: () => 1000 },
  clientHeight: { configurable: true, get: () => 700 },
});
browser.HTMLElement.prototype.getBoundingClientRect = () => new browser.DOMRect(0, 0, 1000, 700);
let frameId = 0;
const frames = new Map<number, FrameRequestCallback>();
browser.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
browser.cancelAnimationFrame = (id) => { frames.delete(id); };

// Only this isolated test replaces network reads: Wikipedia, and the app's own map, page and AI routes.
const page = validateGeneratedUrlMap(urlMapModelReply, extractPage(urlMapHtml, "https://example.org/trees"));
const articles: Record<string, { id: string; wikitext: string }> = {
  "Systems thinking": { id: "Q990001", wikitext: "'''Systems thinking''' is a way of making sense of [[Feedback]] loops and [[Cybernetics]]." },
  Feedback: { id: "Q990002", wikitext: "'''Feedback''' is a central idea of [[Cybernetics]]." },
  Cybernetics: { id: "Q990003", wikitext: "'''Cybernetics''' is a field." },
};
const wikiPage = (title: string) => articles[title] ? { title, pageprops: { wikibase_item: articles[title].id }, description: `About ${title}.` } : { title, missing: true };
const legacyTopic = { id: "Q990010", aliases: [], label: "Earlier topic", description: "From the old public map.", wikidataUrl: "https://www.wikidata.org/wiki/Q990010", wikipediaUrl: "https://en.wikipedia.org/wiki/Earlier_topic", retrievedAt: "2026-10-01T00:00:00.000Z" };
const accountMap = { version: 1, graph: { roots: [legacyTopic.id], topics: { [legacyTopic.id]: legacyTopic }, positions: {}, expansions: {} }, viewport: { x: 0, y: 0, scale: 1 } };
const saves: any[] = [];
const requests: Array<{ path: string; body: any; userId: string | null }> = [];
const stream = (...events: unknown[]) => new Response(events.map((event) => JSON.stringify(event)).join("\n") + "\n", { headers: { "Content-Type": "application/x-ndjson" } });
globalThis.fetch = (async (input, init) => {
  const url = new URL(String(input), "http://map-exploration-interactions.test");
  if (url.hostname === "en.wikipedia.org") {
    if (url.pathname.startsWith("/api/rest_v1/page/summary/")) return Response.json({ title: decodeURIComponent(url.pathname.split("/").pop()!), extract: "A short Wikipedia summary." });
    if (url.searchParams.get("action") === "parse") {
      const title = url.searchParams.get("page")!;
      return Response.json({ parse: { title, wikitext: articles[title]?.wikitext ?? "", categories: [], properties: { wikibase_item: articles[title]?.id } } });
    }
    if (url.searchParams.get("generator")) {
      const search = (url.searchParams.get("gpssearch") ?? url.searchParams.get("gsrsearch"))!.toLowerCase();
      return Response.json({ query: { pages: Object.keys(articles).filter((title) => title.toLowerCase().includes(search)).map((title, index) => ({ index, ...wikiPage(title) })) } });
    }
    return Response.json({ query: { pages: url.searchParams.get("titles")!.split("|").map(wikiPage) } });
  }
  if (url.hostname === "www.wikidata.org") return Response.json({ entities: {} });
  const userId = new Headers(init?.headers).get("X-Margin-Vault-User");
  const body = init?.body ? JSON.parse(String(init.body)) : null;
  requests.push({ path: url.pathname, body, userId });
  if (url.pathname === "/api/public-map/state") {
    if (init?.method === "PUT") { saves.push(body.state); return Response.json({ ok: true }); }
    return Response.json({ state: accountMap, revision: 3, updatedAt: "2026-10-01T00:00:00.000Z" });
  }
  if (url.pathname === "/api/public-map/answers") return Response.json({ answers: [] });
  if (url.pathname === "/api/graph/url") return stream({ type: "progress", message: "Reading example.org…" }, { type: "done", graph: page });
  if (url.pathname === "/api/graph/ask") return stream({ type: "progress", message: "Thinking…" }, { type: "done", answer: {
    question: body.question, answer: "Feedback loops feed an output back in as an input.", related: [{ id: "Q990003", label: "Cybernetics", description: "Study of control.", relation: "studied by" }] } });
  throw new Error(`Unexpected request ${url.href}`);
}) as typeof fetch;

const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: KnowledgeGraphWorkspace } = await import("../../client/src/components/KnowledgeGraphWorkspace");
const { createEmptyState } = await import("../../client/src/initialState");
const { createMapNote } = await import("../../client/src/lib/graphWorkspaceEdits");
const { keepExploredItems } = await import("../../client/src/lib/keepExplored");
const { buildThreadSummaries } = await import("../../client/src/lib/conversationSearch");
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
let current: AppState = createMapNote(createEmptyState(), { id: "doc-angular", noteId: "doc-angular-note", createdAt: "2026-10-11T00:00:00.000Z", title: "Angular notes", content: "Signals and change detection." });
let createdSources: string[] = [];
let keepSequence = 0;

function Workspace() {
  const [state, setState] = useState(current);
  current = state;
  return createElement(KnowledgeGraphWorkspace, {
    workspaceKey: "explorer", activeConversationId: state.activeConversationId, conversations: state.conversations, groups: state.groups, graphLayouts: state.graphLayouts,
    threads: buildThreadSummaries(state.conversations),
    publicMapAccount: { userId: "explorer", canAsk: true, isAdmin: false },
    onKeepExplored(exploration, ids, detached) {
      const options = { createdAt: "2026-10-11T12:00:00.000Z", detached, newNote: (id: string) => ({ id: `kept-${++keepSequence}`, noteId: `kept-${keepSequence}-note` }) };
      const { kept, state: next } = keepExploredItems(current, exploration, ids, options);
      setState(next);
      return kept;
    },
    onSavePublicTopic() {}, onCreateMapNote(args) { if (args.url) createdSources.push(args.url); }, onSetMapConnection() {}, onRemoveMapNote() {}, onUndoMapEdit() {},
    onActivateConversation(id) { setState((previous) => ({ ...previous, activeConversationId: id })); },
    onAssignGroup() {}, onCreateChildConversation: () => null, onOpenConversation() {}, onToggleGroup() {},
  });
}

async function flushFrames() {
  for (let iteration = 0; frames.size && iteration < 20; iteration++) {
    const callbacks = [...frames.values()]; frames.clear();
    await act(async () => { callbacks.forEach((callback) => callback(0)); });
  }
}
async function wait(ms = 30) { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); await flushFrames(); }
function query(selector: string) { return container.querySelector(selector) as any; }
function element(selector: string) { const value = query(selector); assert(value, `Missing ${selector}`); return value; }
function all(selector: string) { return [...container.querySelectorAll(selector)] as any[]; }
function button(text: string, selector = "button") {
  const value = all(selector).find((item) => item.textContent.trim() === text);
  assert(value, `Missing button: ${text}`);
  return value;
}
async function click(target: any) { await act(async () => { target.click(); }); await flushFrames(); }
async function type(text: string) {
  const input = element('[aria-label="Search this map"]');
  await act(async () => {
    input.focus();
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, text);
    input.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  await flushFrames();
}
async function until(check: () => unknown, message: string) {
  for (let attempt = 0; attempt < 60; attempt++) { if (check()) return; await wait(25); }
  assert.fail(message);
}
const cards = () => all(".map-preview-card").map((card) => card.querySelector("strong").textContent);

try {
  await act(async () => { root.render(createElement(Workspace)); });
  await flushFrames();
  assert.equal(query('[aria-label="Choose map"]'), null, "The My map / Public / Map a URL switch is gone");
  assert.equal(element('[aria-label="Search this map"]').placeholder, "Search, ask, or paste a link…");

  // The old public map moves into history once the account copy loads.
  await until(() => query('[aria-label="Explored history, 1 items"]'), "The earlier public map is imported into history");
  await click(element('[aria-label="Explored history, 1 items"]'));
  assert(element('aside[aria-label="Explored history"]').textContent.includes("Earlier public map"));
  assert(element('aside[aria-label="Explored history"]').textContent.includes("Earlier topic"));
  assert.equal(cards().length, 0, "Imported history does not appear on the map by itself");
  await click(element('[aria-label="Close history"]'));

  // Words that match nothing in the map find Wikipedia articles to preview.
  await type("Systems");
  await until(() => all(".map-look-further-option").some((item) => item.textContent.includes("Systems thinking")), "Wikipedia matches appear in the search results");
  assert(element('[aria-label="Look further for Systems"]').textContent.includes("Not in your map yet"));
  await click(all(".map-look-further-option").find((item) => item.textContent.includes("Systems thinking")));
  await until(() => cards().includes("Feedback") && cards().includes("Cybernetics"), "The topic and its Wikipedia connections appear as previews");
  assert.deepEqual(cards().sort(), ["Cybernetics", "Feedback", "Systems thinking"]);
  assert(element('[aria-label="Preview of Systems thinking"]'), "The picked topic opens its preview panel");
  assert(element('[aria-label="Previews on the map"]').textContent.includes("3 previews"));
  assert.equal(Object.values(current.conversations).filter((item) => item.publicTopic).length, 0, "Previews add nothing to the workspace");

  // Keeping one preview keeps the preview it hangs off, connected; the rest stay previews.
  await click(element('[aria-label="Keep Feedback in my map"]'));
  await wait();
  const systems = current.conversations["public-topic-Q990001"], feedback = current.conversations["public-topic-Q990002"];
  assert(systems && feedback, "Keeping Feedback keeps Systems thinking with it");
  assert.equal(current.conversations["public-topic-Q990003"], undefined);
  // The opening sentence's first link is the broader topic, so Systems thinking is part of Feedback.
  assert(systems.relations?.some((relation) => relation.type === "part-of" && relation.targetConversationId === feedback.id && relation.note === "Wikipedia · broader topic"),
    `The kept topic is connected the way Wikipedia connects it: ${JSON.stringify([systems.relations, feedback.relations])}`);
  assert.deepEqual(cards(), ["Cybernetics"], "Kept previews leave the map; the others stay");

  // Removing a preview from the map keeps it in history.
  await click(element('[aria-label="Remove Cybernetics from the map"]'));
  assert.deepEqual(cards(), []);
  assert.equal(query('[aria-label="Previews on the map"]'), null);
  await click(element('[aria-label="Explored history, 2 items"]'));
  assert(element('[aria-label="Show Cybernetics on the map"]'), "A removed preview waits in history");
  assert.equal(query('[aria-label="Keep Systems thinking in my map"]'), null, "Kept items leave history");
  assert.equal(query('[aria-label="Keep Feedback in my map"]'), null, "Kept items leave history");
  await click(element('[aria-label="Show Cybernetics on the map"]'));
  assert.deepEqual(cards(), ["Cybernetics"]);
  await click(element('[aria-label="Close history"]'));

  // A pasted link goes into the search, which offers to map the page.
  await act(async () => {
    const paste = new browser.Event("paste", { bubbles: true, cancelable: true });
    Object.defineProperty(paste, "clipboardData", { value: { getData: () => "https://example.org/trees" } });
    browser.document.body.dispatchEvent(paste);
  });
  await flushFrames();
  assert.equal(element('[aria-label="Search this map"]').value, "https://example.org/trees");
  assert(button("Save as a source noteA linked note with room for your notes.Free"));
  await click(all(".map-look-further-option").find((item) => item.textContent.startsWith("Map this page")));
  await until(() => cards().includes("Urban trees"), "The mapped page's topics appear as previews");
  assert.deepEqual(cards().sort(), ["Cybernetics", "Healthy soil", "Shade", "Transpiration", "Urban trees"]);
  assert.equal(requests.find((request) => request.path === "/api/graph/url")?.body.url, "https://example.org/trees");
  assert(element('[aria-label="Preview of Urban trees"]').textContent.includes("Supporting passage"));
  await click(button("Keep in my map"));
  await wait();
  assert(current.conversations[`url-topic-${page.rootId}`], "A kept page topic becomes a source note");
  // The rest stay previews, now beside the new note wherever the map puts it.
  assert(element('[aria-label="Previews on the map"]').textContent.startsWith("4 previews"));

  // Enter on a question asks AI; the answer and the topics it names are previews beside the matching document.
  await type("how do feedback loops work");
  await act(async () => { element('[aria-label="Search this map"]').dispatchEvent(new browser.KeyboardEvent("keydown", { key: "Enter", bubbles: true })); });
  await until(() => cards().includes("how do feedback loops work"), "The AI answer appears as a preview");
  const ask = requests.find((request) => request.path === "/api/graph/ask")!;
  assert.equal(ask.body.question, "how do feedback loops work");
  assert(element('[aria-label="Preview of how do feedback loops work"]').textContent.includes("Keeping it connects it to Feedback."), "A question that names a document is answered beside it");
  await click(button("Keep without connecting"));
  await wait();
  const answer = Object.values(current.conversations).find((item) => item.title === "how do feedback loops work")!;
  assert(answer, "The kept answer becomes a note");
  assert.equal(answer.parentId, null, "Keep without connecting leaves it on its own");
  assert(answer.notes![0].content.includes("Feedback loops feed an output back in"));
  assert(element('[aria-label="Previews on the map"]').textContent.startsWith("4 previews"), "The topic the answer names stays a preview where it was");

  // History is saved to the account beside the old public map, which stays intact.
  await until(() => saves.length, "History is saved to the account");
  const saved = saves.at(-1);
  assert.deepEqual(saved.graph, accountMap.graph, "Saving history keeps the old public map record");
  assert.deepEqual(saved.viewport, accountMap.viewport);
  assert(saved.explored.items["topic:Q990003"], "The account copy holds what was explored");
  assert(saved.explored.importedPublicMap, "The import happens once");
  assert(requests.filter((request) => request.path.startsWith("/api/")).every((request) => request.userId === "explorer"));

  // Clearing history needs a second click and removes every preview.
  await click(element('[aria-label^="Explored history,"]'));
  await click(button("Clear history…"));
  await click(button("Forget all"));
  assert(element('aside[aria-label="Explored history"]').textContent.includes("Nothing here yet"), element('aside[aria-label="Explored history"]').textContent);
  assert.deepEqual(cards(), []);
  assert.deepEqual(createdSources, []);
  console.log("Map search previews, keep, history, paste, page mapping, AI answers, and account saving passed.");
} finally {
  await act(async () => { root.unmount(); });
  browser.close();
}
