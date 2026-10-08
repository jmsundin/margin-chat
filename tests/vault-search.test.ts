import { expect, test } from "bun:test";
import { createLocalVaultSearchProvider, searchLocalVault, type LocalVaultSearchInput } from "../client/src/lib/vaultSearch";
import type { VaultIndexEntry } from "../client/src/lib/vaultTypes";
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
