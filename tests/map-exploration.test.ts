import { describe, expect, test } from "bun:test";
import {
  addExplored, answerItems, capExploration, emptyExploration, expansionItems, exploredChildren, forgetBatch, forgetExplored, importPublicMap, isFullWebAddress,
  layoutPreviews, MAX_EXPLORED_ITEMS, MAX_EXPLORED_PAGES, mergeExplorations, pageItemId, pageItems, parseExploration, PREVIEW_CARD, setOnMap, settleExplored, topicItem, webAddress,
  type ExploredBatch, type MapExploration,
} from "../client/src/lib/mapExploration";
import { keepExploredItems, keepOrder, savedConversationFor } from "../client/src/lib/keepExplored";
import { fitExploration } from "../client/src/lib/useMapExploration";
import { looksLikeQuestion, visibleParent } from "../client/src/components/MapPreviews";
import { createEmptyState } from "../client/src/initialState";
import { createMapNote } from "../client/src/lib/graphWorkspaceEdits";
import type { PublicExpansion, PublicTopic } from "../client/src/lib/publicKnowledge";
import { extractPage } from "../server/urlMap/page.mjs";
import { validateGeneratedUrlMap } from "../server/urlMap/index.mjs";
import { urlMapHtml, urlMapModelReply } from "./helpers/urlMapFixture";
import type { UrlMapGraph } from "../client/src/lib/urlMap";

const at = "2026-10-11T20:00:00.000Z";
const topic = (id: string, label: string): PublicTopic => ({ id, aliases: [], label, description: `${label} description`, wikidataUrl: `https://www.wikidata.org/wiki/${id}`,
  wikipediaUrl: `https://en.wikipedia.org/wiki/${label.replace(/ /g, "_")}`, retrievedAt: at });
const batch = (id = "b1", createdAt = at): ExploredBatch => ({ id, title: id, createdAt });
const angular = topic("Q28925578", "Angular (web framework)");
const expansion: PublicExpansion = {
  topic: angular, hasMore: true, nextOffset: 3,
  topics: [topic("Q2005", "JavaScript"), topic("Q978185", "TypeScript"), topic("Q1062639", "Single-page application")],
  relations: [
    { id: "r1", sourceId: angular.id, targetId: "Q978185", propertyId: "wikipedia-lead", label: "Lead", sourceUrl: "" },
    { id: "r2", sourceId: angular.id, targetId: "Q2005", propertyId: "wikipedia-broader", label: "Broader", sourceUrl: "" },
    { id: "r3", sourceId: angular.id, targetId: "Q1062639", propertyId: "wikipedia-see-also", label: "See also", sourceUrl: "" },
  ],
};
const pageGraph = () => validateGeneratedUrlMap(urlMapModelReply, extractPage(urlMapHtml, "https://example.org/trees")) as UrlMapGraph;

describe("map search reading", () => {
  test("recognizes links, bare domains and questions", () => {
    expect(webAddress("https://angular.dev/guide/signals")).toBe("https://angular.dev/guide/signals");
    expect(webAddress("  angular.dev ")).toBe("https://angular.dev/");
    expect(webAddress("www.example.org/a?b=1")).toBe("https://www.example.org/a?b=1");
    for (const text of ["signals", "angular signals", "ftp://example.org", "javascript:alert(1)", "http://localhost", ""]) expect(webAddress(text)).toBeNull();
    expect(isFullWebAddress("angular.dev")).toBe(false);
    expect(isFullWebAddress("https://angular.dev")).toBe(true);
    expect(looksLikeQuestion("how do signals work")).toBe(true);
    expect(looksLikeQuestion("zone.js?")).toBe(true);
    expect(looksLikeQuestion("Angular signals")).toBe(false);
  });
});

describe("explored items", () => {
  test("Wikipedia connections become previews that remember how they join", () => {
    const items = expansionItems(expansion, { parent: { kind: "document", id: "doc-1" }, batchId: "b1", exploredAt: at });
    expect(items.map((item) => [item.id, item.connection?.kind, item.via])).toEqual([
      ["topic:Q978185", "narrower", "Wikipedia · Lead"],
      ["topic:Q2005", "broader", "Wikipedia · Broader"],
      ["topic:Q1062639", "related", "Wikipedia · See also"],
    ]);
    expect(items.every((item) => item.onMap && item.parent?.kind === "document")).toBe(true);
  });

  test("a mapped page hangs its topics off its main topic, unlinked ones included", () => {
    const graph = pageGraph();
    const items = pageItems(graph, { parent: null, batchId: "b1", exploredAt: at });
    expect(items).toHaveLength(graph.nodes.length);
    expect(items[0]).toMatchObject({ id: pageItemId(graph.rootId), parent: null, via: "Page · example.org" });
    const ids = new Set(items.map((item) => item.id));
    for (const item of items.slice(1)) expect(item.parent?.kind === "item" && ids.has(item.parent.id)).toBe(true);
  });

  test("an AI answer is a preview with the topics it names under it", () => {
    const items = answerItems({ question: "What are signals?", answer: "Reactive values.", related: [{ id: "Q1", label: "Reactivity", description: "", relation: "explains" }] }, "a1",
      { parent: null, batchId: "b1", exploredAt: at });
    expect(items.map((item) => [item.id, item.parent])).toEqual([["answer:a1", null], ["topic:Q1", { kind: "item", id: "answer:a1" }]]);
    expect(items[1].connection).toEqual({ kind: "related", label: "explains" });
  });

  test("something explored again stays put on the map, and comes back from history in its new place", () => {
    const root = topicItem(angular, { parent: null, batchId: "b1", exploredAt: at });
    let state = addExplored(emptyExploration(), batch(), [root, ...expansionItems(expansion, { parent: { kind: "item", id: root.id }, batchId: "b1", exploredAt: at })]);
    const again = { ...state.items["topic:Q978185"], parent: { kind: "document" as const, id: "doc-2" }, exploredAt: "2026-10-11T22:00:00.000Z", batchId: "b2" };
    expect(addExplored(state, batch("b2"), [again]).items["topic:Q978185"]).toEqual(state.items["topic:Q978185"]);
    state = setOnMap(state, ["topic:Q978185"], false);
    expect(addExplored(state, batch("b2"), [again]).items["topic:Q978185"]).toEqual(again);
    // Bringing the root back under one of its own previews would make a loop, so it stays where it was.
    state = setOnMap(state, [root.id], false);
    const loop = { ...root, parent: { kind: "item" as const, id: "topic:Q2005" }, exploredAt: "2026-10-11T23:00:00.000Z" };
    expect(addExplored(state, batch("b3"), [loop]).items[root.id]).toEqual({ ...state.items[root.id], onMap: true });
  });

  test("forgetting moves what hung off it up a level and drops empty batches and pages", () => {
    const graph = pageGraph();
    const items = pageItems(graph, { parent: { kind: "document", id: "doc-1" }, batchId: "page", exploredAt: at });
    let state = addExplored(emptyExploration(), batch("page"), items, [graph]);
    state = forgetExplored(state, [pageItemId(graph.rootId)]);
    expect(state.items[pageItemId(graph.rootId)]).toBeUndefined();
    const direct = items.filter((item) => item.parent?.kind === "item" && item.parent.id === pageItemId(graph.rootId));
    for (const item of direct) expect(state.items[item.id].parent).toEqual({ kind: "document", id: "doc-1" });
    state = forgetBatch(state, "page");
    expect(state).toMatchObject({ items: {}, batches: {}, pages: {} });
  });

  test("kept items leave history and their previews hang off the new note", () => {
    const root = topicItem(angular, { parent: null, batchId: "b1", exploredAt: at });
    const state = addExplored(emptyExploration(), batch(), [root, ...expansionItems(expansion, { parent: { kind: "item", id: root.id }, batchId: "b1", exploredAt: at })]);
    expect(settleExplored(state, () => null)).toBe(state);
    const settled = settleExplored(state, (item) => item.id === root.id ? "note-1" : null);
    expect(settled.items[root.id]).toBeUndefined();
    expect(settled.items["topic:Q2005"].parent).toEqual({ kind: "document", id: "note-1" });
    expect(settleExplored(settled, () => null, (id) => id !== "note-1").items["topic:Q2005"].parent).toBeNull();
  });

  test("history stays bounded and drops the oldest items that are not on the map", () => {
    const many = Array.from({ length: MAX_EXPLORED_ITEMS + 5 }, (_, index) => ({
      ...topicItem(topic(`Q${index + 1}`, `Topic ${index}`), { parent: null, batchId: "b1", exploredAt: `2026-10-11T20:${String(index % 60).padStart(2, "0")}:00.000Z` }),
      onMap: index > 10,
    }));
    const state = capExploration({ ...emptyExploration(), items: Object.fromEntries(many.map((item) => [item.id, item])), batches: { b1: batch() } });
    expect(Object.keys(state.items)).toHaveLength(MAX_EXPLORED_ITEMS);
    expect(Object.values(state.items).filter((item) => !item.onMap)).toHaveLength(6);
  });

  test("only mapped pages with nothing left on the map make room for newer pages", () => {
    let state = emptyExploration();
    for (let index = 0; index <= MAX_EXPLORED_PAGES + 1; index += 1) {
      const base = pageGraph();
      const own = (id: string) => `${id}-${index}`;
      const graph = { ...base, rootId: own(base.rootId), source: { ...base.source, url: `https://example.org/page-${index}`, retrievedAt: `2026-10-11T20:${String(index).padStart(2, "0")}:00.000Z` },
        nodes: base.nodes.map((node) => ({ ...node, id: own(node.id) })), edges: base.edges.map((edge) => ({ ...edge, sourceId: own(edge.sourceId), targetId: own(edge.targetId) })) };
      const items = pageItems(graph, { parent: null, batchId: `p${index}`, exploredAt: at }).map((item) => ({ ...item, onMap: index === 0 }));
      state = addExplored(state, batch(`p${index}`), items, [graph]);
    }
    const urls = Object.keys(state.pages);
    expect(urls).toHaveLength(MAX_EXPLORED_PAGES);
    // The oldest page is still on the map, so the next two oldest go instead.
    expect(urls).toContain("https://example.org/page-0");
    expect(urls).not.toContain("https://example.org/page-1");
    expect(urls).not.toContain("https://example.org/page-2");
    expect(Object.values(state.items).some((item) => item.source.kind === "page" && item.source.url === "https://example.org/page-0")).toBe(true);
  });

  test("two copies merge with the newest item winning", () => {
    const older = topicItem(angular, { parent: null, batchId: "b1", exploredAt: at });
    const newer = { ...older, onMap: false, exploredAt: "2026-10-11T21:00:00.000Z", batchId: "b2" };
    const merged = mergeExplorations(addExplored(emptyExploration(), batch(), [older]), addExplored(emptyExploration(), batch("b2"), [newer]));
    expect(merged.items[older.id]).toEqual(newer);
    expect(Object.keys(merged.batches)).toEqual(["b2"]);
  });

  test("the old public map moves into history once, with how its topics were reached", () => {
    const legacy = { roots: [angular.id], topics: { [angular.id]: angular, Q2005: topic("Q2005", "JavaScript") }, positions: {},
      expansions: { [angular.id]: { topicIds: ["Q2005"], relations: [expansion.relations[1]], visible: true, hasMore: false, nextOffset: 1 } } };
    const imported = importPublicMap(emptyExploration(), legacy as never, at);
    expect(imported.importedPublicMap).toBe(true);
    expect(imported.items["topic:Q2005"]).toMatchObject({ onMap: false, parent: { kind: "item", id: `topic:${angular.id}` }, connection: { kind: "broader" } });
    expect(imported.batches["public-map"].title).toBe("Earlier public map");
    expect(importPublicMap(forgetBatch(imported, "public-map"), legacy as never, at).items).toEqual({});
  });

  test("a stored copy keeps only well-formed items", () => {
    const graph = pageGraph();
    const good = addExplored(emptyExploration(), batch(), [topicItem(angular, { parent: null, batchId: "b1", exploredAt: at }),
      ...pageItems(graph, { parent: null, batchId: "b1", exploredAt: at })], [graph]);
    const stored = JSON.parse(JSON.stringify(good));
    expect(parseExploration(stored)).toEqual(good);
    stored.items["topic:Q28925578"].onMap = "yes";
    delete stored.pages[graph.source.url];
    const parsed = parseExploration(stored)!;
    expect(Object.keys(parsed.items)).toEqual([]);
    expect(parseExploration({ version: 2 })).toBeNull();
    expect(parseExploration("nope")).toBeNull();
  });

  test("the account copy drops the oldest history to fit, keeping previews on the map", () => {
    const items = Array.from({ length: 60 }, (_, index) => ({ ...topicItem(topic(`Q${index + 1}`, `Topic ${index}`), { parent: null, batchId: "b1", exploredAt: `2026-10-11T20:${String(index).padStart(2, "0")}:00.000Z` }), onMap: index < 5 }));
    const state: MapExploration = { ...emptyExploration(), items: Object.fromEntries(items.map((item) => [item.id, item])), batches: { b1: batch() } };
    const limit = JSON.stringify(state).length / 2;
    const fitted = fitExploration(state, limit);
    expect(JSON.stringify(fitted).length).toBeLessThanOrEqual(limit);
    expect(Object.values(fitted.items).filter((item) => item.onMap)).toHaveLength(5);
  });
});

describe("preview layout", () => {
  test("trees open to the right of their anchor, and groups that would overlap move down", () => {
    const anchor = { x: 100, y: 200, width: 120, height: 60 };
    const children: Record<string, string[]> = { a: ["a1", "a2"], b: [] };
    const boxes = layoutPreviews([{ anchor, rootIds: ["a"] }, { anchor: { ...anchor, y: 210 }, rootIds: ["b"] }], (id) => children[id] ?? []);
    const a = boxes.get("a")!, a1 = boxes.get("a1")!, a2 = boxes.get("a2")!, b = boxes.get("b")!;
    expect(a.x).toBe(anchor.x + anchor.width + 48);
    expect(a1.x).toBe(a.x + PREVIEW_CARD.width + 48);
    expect(a1.y + PREVIEW_CARD.height).toBeLessThanOrEqual(a2.y);
    expect(a.y + a.height / 2).toBeCloseTo((a1.y + a2.y + PREVIEW_CARD.height) / 2);
    expect(b.y).toBeGreaterThanOrEqual(a2.y + PREVIEW_CARD.height);
  });

  test("a preview under a hidden one shows beside the nearest visible parent", () => {
    const root = topicItem(angular, { parent: { kind: "document", id: "doc-1" }, batchId: "b1", exploredAt: at });
    const state = setOnMap(addExplored(emptyExploration(), batch(), [root, ...expansionItems(expansion, { parent: { kind: "item", id: root.id }, batchId: "b1", exploredAt: at })]), [root.id], false);
    expect(visibleParent(state, state.items["topic:Q2005"])).toEqual({ kind: "document", id: "doc-1" });
    expect(exploredChildren(Object.values(state.items)).get(`item:${root.id}`)).toHaveLength(3);
  });
});

describe("keeping previews", () => {
  const workspace = () => {
    const state = createEmptyState();
    return createMapNote(state, { id: "doc-1", noteId: "doc-1-note", createdAt: at, title: "Angular notes" });
  };
  const options = { createdAt: at, newNote: (id: string) => ({ id: `kept-${id.replace(/\W/g, "-")}`, noteId: `kept-${id.replace(/\W/g, "-")}-note` }) };

  test("a kept topic becomes a note connected to the document it came from", () => {
    const items = expansionItems(expansion, { parent: { kind: "document", id: "doc-1" }, batchId: "b1", exploredAt: at });
    const exploration = addExplored(emptyExploration(), batch(), items);
    const { state, kept } = keepExploredItems(workspace(), exploration, ["topic:Q2005", "topic:Q978185"], options);
    const javascript = state.conversations[kept["topic:Q2005"]];
    const typescript = state.conversations[kept["topic:Q978185"]];
    expect(javascript.title).toBe("JavaScript");
    expect(state.conversations["doc-1"].relations).toContainEqual(expect.objectContaining({ type: "part-of", targetConversationId: javascript.id, origin: "import" }));
    expect(typescript.relations).toContainEqual(expect.objectContaining({ type: "elaborates", targetConversationId: "doc-1" }));
    expect(savedConversationFor(state, items[1])).toBe(javascript.id);
    expect(keepExploredItems(state, exploration, ["topic:Q2005"], options).state).toBe(state);
  });

  test("keeping a preview keeps the previews that connect it, parents first, and can skip the document", () => {
    const answer = answerItems({ question: "What are signals?", answer: "Reactive values.", related: [{ id: "Q1", label: "Reactivity", description: "", relation: "explains" }] }, "a1",
      { parent: { kind: "document", id: "doc-1" }, batchId: "b1", exploredAt: at });
    const exploration = addExplored(emptyExploration(), batch(), answer);
    expect(keepOrder(exploration, ["topic:Q1"]).map((item) => item.id)).toEqual(["answer:a1", "topic:Q1"]);
    const { state, kept } = keepExploredItems(workspace(), exploration, ["topic:Q1"], options);
    const note = state.conversations[kept["answer:a1"]];
    expect(note.parentId).toBe("doc-1");
    expect(note.notes![0].content).toContain("Reactive values.");
    const [owner, other] = [note.id, kept["topic:Q1"]].sort();
    expect(state.conversations[owner].linkedConversationIds).toContain(other);
    const alone = keepExploredItems(workspace(), exploration, ["answer:a1"], { ...options, detached: ["answer:a1"] });
    expect(alone.state.conversations[alone.kept["answer:a1"]].parentId).toBeNull();
  });

  test("a kept page topic becomes a source note connected to its document", () => {
    const graph = pageGraph();
    const exploration = addExplored(emptyExploration(), batch(), pageItems(graph, { parent: { kind: "document", id: "doc-1" }, batchId: "b1", exploredAt: at }), [graph]);
    const { state, kept } = keepExploredItems(workspace(), exploration, [pageItemId(graph.rootId)], options);
    const note = state.conversations[kept[pageItemId(graph.rootId)]];
    expect(note.notes![0].content).toContain("Source: <https://example.org/trees>");
    const [owner, other] = [note.id, "doc-1"].sort();
    expect(state.conversations[owner].linkedConversationIds).toContain(other);
  });
});
