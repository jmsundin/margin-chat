import { expect, test } from "bun:test";
import { cacheVaultCloudSearch, createLocalVaultSearchProvider, createVaultSearchProvider, searchLocalVault, type LocalVaultSearchInput, type VaultCloudSearch, type VaultSearchResults } from "../client/src/lib/vaultSearch";
import type { VaultIndexEntry, VaultSearchEvent } from "../client/src/lib/vaultTypes";
import type { Conversation } from "../client/src/types";

const now = Date.parse("2026-10-08T12:00:00Z");
function chat(id: string, title: string, content: string, updatedAt: string, extra: Partial<Conversation> = {}): Conversation {
  return {
    id, title, branchAnchor: null, childIds: [], parentId: null, serviceId: "backend-services", modelId: "auto", createdAt: updatedAt, updatedAt,
    messages: [{ id: `${id}-m`, role: "assistant", content, createdAt: updatedAt }], ...extra,
  } as Conversation;
}
const conversations: Record<string, Conversation> = {
  heat: chat("heat", "Urban heat draft", "Shade changes the picture at street level.", "2026-10-06T10:00:00Z", { childIds: ["trees"] }),
  trees: chat("trees", "Trees vs. shade sails", "Trees cool the air; fabric shade only blocks light.", "2026-10-07T10:00:00Z", { parentId: "heat" }),
  garden: chat("garden", "Garden log", "", "2023-06-02T10:00:00Z", { kind: "note", messages: [], notes: [{ id: "garden-body", kind: "standalone", sourceMessageId: null, startOffset: null, endOffset: null, quote: null, content: "Ferns did well in the shade under the maple.", createdAt: "2023-06-02T10:00:00Z", updatedAt: "2023-06-02T10:00:00Z" }] } as Partial<Conversation>),
  budget: chat("budget", "City budget", "Street trees compete with potholes.", "2024-11-20T10:00:00Z"),
};
const cloudDocuments: VaultIndexEntry[] = [
  { path: "school.md", id: "school", type: "conversation", kind: "chat", title: "Shade structures for the school yard", revision: "1", updated: "2025-03-12T10:00:00Z" },
  { path: "plants.md", id: "plants", type: "conversation", kind: "note", title: "Shade-tolerant plants", revision: "1", updated: "2026-09-01T10:00:00Z" },
];
const input: LocalVaultSearchInput = { conversations, cloudDocuments, now };

test("one search finds titles on this device and in the cloud, newest first, plus passages", () => {
  const results = searchLocalVault({ query: "shade", scope: "all", currentConversationId: "heat" }, input);
  expect(results.documents.map((hit) => hit.title)).toEqual(["Trees vs. shade sails", "Shade-tolerant plants", "Shade structures for the school yard"]);
  expect(results.documents[1].target).toEqual({ kind: "cloud", path: "plants.md" });
  expect(results.documents[0]).toMatchObject({ kindLabel: "Branch chat", familyTitle: "Urban heat draft", target: { kind: "loaded", conversationId: "trees" } });
  // Passages exclude title-only matches, which the documents list already shows.
  expect(results.passages.map((hit) => hit.conversationId).sort()).toEqual(["garden", "heat", "trees"]);
  expect(results.passages.every((hit) => hit.evidence.sourceKind !== "conversation")).toBe(true);
  expect(results.complete).toBe(true);
});

test("scopes narrow both titles and passages", () => {
  const family = searchLocalVault({ query: "shade", scope: "family", currentConversationId: "trees" }, input);
  expect(family.documents.map((hit) => hit.title)).toEqual(["Trees vs. shade sails"]);
  expect(family.passages.map((hit) => hit.conversationId).sort()).toEqual(["heat", "trees"]);
  const notes = searchLocalVault({ query: "shade", scope: "notes" }, input);
  expect(notes.documents.map((hit) => hit.title)).toEqual(["Shade-tolerant plants"]);
  expect(notes.passages.map((hit) => hit.conversationId)).toEqual(["garden"]);
  const recent = searchLocalVault({ query: "shade", scope: "recent" }, input);
  expect(recent.documents.map((hit) => hit.title)).toEqual(["Trees vs. shade sails", "Shade-tolerant plants"]);
  expect(recent.passages.some((hit) => hit.conversationId === "garden")).toBe(false);
});

test("an empty query lists recent documents and the provider answers through emit", () => {
  const seen: string[][] = [];
  const cancel = createLocalVaultSearchProvider(() => input).search({ query: "  ", scope: "all" }, (results) => seen.push(results.documents.map((hit) => hit.title)));
  cancel();
  expect(seen).toEqual([["Trees vs. shade sails", "Urban heat draft", "City budget", "Garden log"]]);
});

test("matching ignores accents and case and needs every word", () => {
  const accented = { ...input, conversations: { cafe: chat("cafe", "Café notes", "Nothing here", "2026-01-01T00:00:00Z") } };
  expect(searchLocalVault({ query: "CAFE", scope: "all" }, accented).documents).toHaveLength(1);
  expect(searchLocalVault({ query: "shade yard", scope: "all" }, input).documents.map((hit) => hit.title)).toEqual(["Shade structures for the school yard"]);
});

const serverEvents: VaultSearchEvent[] = [
  { type: "documents", results: [
    { path: "trees.md", id: "trees", type: "conversation", kind: "chat", title: "Trees vs. shade sails", revision: "1", updated: "2026-10-07T10:00:00Z" },
    cloudDocuments[0],
    { path: "porch.md", id: "porch", type: "conversation", kind: "chat", title: "Porch shade ideas", revision: "1", updated: "2022-05-01T10:00:00Z" },
  ] },
  { type: "passages", source: "documents", results: [
    { id: "porch", path: "porch.md", title: "Porch shade ideas", source: "document", snippet: "…a deep shade over the steps", match: { start: 8, end: 13 }, position: { blockId: "b2", start: 40, end: 45 }, updated: "2022-05-01T10:00:00Z" },
    // Already on this device: the local search answers for it.
    { id: "heat", title: "Urban heat draft", source: "document", snippet: "Shade changes", match: { start: 0, end: 5 }, position: { blockId: "b1", start: 0, end: 5 }, updated: "2026-10-06T10:00:00Z" },
  ] },
  { type: "passages", source: "notes", results: [], error: "Passages could not be searched. Titles are still listed." },
  { type: "done", revision: 7 },
];
const settle = () => new Promise((resolve) => setTimeout(resolve, 200));

test("the server adds what the rest of the vault holds, after this device answers", async () => {
  const calls: string[] = [];
  const searchCloud: VaultCloudSearch = async (query, options, onEvent) => { calls.push(`${query}:${options.limit}`); for (const event of serverEvents) onEvent(event); };
  const emitted: VaultSearchResults[] = [];
  createVaultSearchProvider(() => input, searchCloud).search({ query: "shade", scope: "all" }, (results) => emitted.push(results));
  expect(emitted).toHaveLength(1);
  expect(emitted[0].complete).toBe(false);
  await settle();
  expect(calls).toEqual(["shade:50"]);
  const last = emitted.at(-1)!;
  expect(last.complete).toBe(true);
  expect(last.notice).toContain("Passages could not be searched");
  // Titles: no duplicates of loaded documents or cloud titles already listed.
  expect(last.documents.map((hit) => hit.title)).toEqual(["Trees vs. shade sails", "Shade-tolerant plants", "Shade structures for the school yard", "Porch shade ideas"]);
  const porch = last.passages.find((hit) => hit.conversationId === "porch")!;
  expect(porch).toMatchObject({ cloudPath: "porch.md", matchLabel: "Document text", preview: "…a deep shade over the steps",
    evidence: { conversationId: "porch", sourceKind: "document", sourceBlockId: "b2", quote: "shade", startOffset: 40, endOffset: 45 } });
  expect(last.passages.filter((hit) => hit.conversationId === "heat")).toHaveLength(1);
});

test("the family scope, an empty query and a failed server stay on this device", async () => {
  let calls = 0;
  const failing: VaultCloudSearch = async () => { calls++; throw new Error("This server cannot search the vault yet."); };
  const provider = createVaultSearchProvider(() => input, failing);
  const emitted: VaultSearchResults[] = [];
  provider.search({ query: "shade", scope: "family", currentConversationId: "trees" }, (results) => emitted.push(results));
  provider.search({ query: "", scope: "all" }, (results) => emitted.push(results));
  expect(emitted.map((results) => results.complete)).toEqual([true, true]);
  provider.search({ query: "shade", scope: "all" }, (results) => emitted.push(results));
  await settle();
  expect(calls).toBe(1);
  expect(emitted.at(-1)).toMatchObject({ complete: true, documents: searchLocalVault({ query: "shade", scope: "all" }, input).documents });
  expect(emitted.at(-1)!.notice).toBeUndefined();
});

test("typing cancels the previous server search before it starts", async () => {
  const calls: string[] = [];
  const provider = createVaultSearchProvider(() => input, async (query, _options, onEvent) => { calls.push(query); onEvent({ type: "done", revision: 1 }); });
  const cancel = provider.search({ query: "sha", scope: "all" }, () => undefined);
  cancel();
  provider.search({ query: "shade", scope: "all" }, () => undefined);
  await settle();
  expect(calls).toEqual(["shade"]);
});

test("a finished server search is reused while results refresh for local edits", async () => {
  let clock = 0;
  let calls = 0;
  const cached = cacheVaultCloudSearch(async (_query, _options, onEvent) => { calls++; for (const event of serverEvents.slice(0, 2)) onEvent(event); onEvent({ type: "done", revision: 7 }); }, { now: () => clock });
  const seen: string[] = [];
  await cached("shade", { limit: 50 }, (event) => seen.push(event.type));
  await cached("shade ", { limit: 50 }, (event) => seen.push(event.type));
  expect(calls).toBe(1);
  expect(seen).toEqual(["documents", "passages", "done", "documents", "passages", "done"]);
  clock = 61_000;
  await cached("shade", { limit: 50 }, () => undefined);
  expect(calls).toBe(2);
  // A search with a failed source is not kept.
  await cached("heat", { limit: 50 }, () => undefined);
  const failing = cacheVaultCloudSearch(async (_query, _options, onEvent) => { calls++; onEvent(serverEvents[2]); onEvent({ type: "done", revision: 7 }); });
  await failing("x", {}, () => undefined);
  await failing("x", {}, () => undefined);
  expect(calls).toBe(5);
});
