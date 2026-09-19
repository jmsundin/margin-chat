import { describe, expect, test } from "bun:test";
import { createMainConversation, createStandaloneNoteConversation } from "../client/src/initialState";
import { buildSearchExploration } from "../client/src/lib/conversationSearch";
import { getStandaloneNoteContextMessageId } from "../client/src/lib/standaloneNotes";
import type { Conversation, ConversationGroup } from "../client/src/types";

function chat(id: string, content: string, date = "2026-09-18T00:00:00Z") {
  const conversation = createMainConversation({ id, createdAt: date });
  conversation.title = `Conversation ${id}`;
  conversation.messages = [{ id: `${id}-reply`, role: "assistant", content, createdAt: date }];
  return conversation;
}
function note(id: string, content: string) {
  const conversation = createStandaloneNoteConversation({ id, noteId: `${id}-body`, createdAt: "2026-09-18T00:00:00Z" });
  conversation.title = `Note ${id}`;
  conversation.notes![0].content = content;
  return conversation;
}
const index = (...items: Conversation[]) => Object.fromEntries(items.map((item) => [item.id, item]));
const count = (result: ReturnType<typeof buildSearchExploration>, facetId: string) => result.facets.find((facet) => facet.id === facetId)?.count ?? 0;

describe("search exploration", () => {
  test("offers source headings as specific topic filters and excludes code-like headings", () => {
    const a = chat("a", "## Returning to saved ideas\n\nHelp readers recover a saved passage.\n\n## Reminder fatigue\n\nReaders may ignore too many reminders.\n\n```md\n# Fake topic\n```");
    const result = buildSearchExploration({ conversations: index(a), query: "readers" });
    const headingFacets = result.facets.filter((facet) => facet.id.startsWith("topic:heading:"));
    expect(headingFacets.map((facet) => facet.label).sort()).toEqual(["Reminder fatigue", "Returning to saved ideas"]);
    expect(headingFacets.every((facet) => facet.count === 1)).toBe(true);
    for (const facet of headingFacets) {
      expect(buildSearchExploration({ conversations: index(a), query: "readers", activeFacetIds: [facet.id] }).totalCount).toBe(1);
    }
    expect(buildSearchExploration({ conversations: index(a), query: "" }).facets.some((facet) => facet.label === "Fake topic")).toBe(false);
  });
  test("returns distinct exact passages from every matching message and note, retaining private local sources", () => {
    const a = chat("a", "An introduction.\n\nThe **telescope** decision.\n\nAnother telescope detail.");
    a.messages.push({ id: "follow-up", role: "user", content: "A telescope question?", createdAt: a.createdAt });
    a.messages.push({ id: "system", role: "system", content: "telescope system policy", createdAt: a.createdAt });
    a.messages.push({ id: getStandaloneNoteContextMessageId("body"), role: "user", content: "telescope synthetic context", createdAt: a.createdAt });
    const b = note("b", "A telescope observation.");
    a.notes = [{ ...b.notes![0], kind: "comment", id: "private", content: "My telescope thought." }];
    const conversations = index(a, b);
    const original = structuredClone(conversations);
    const result = buildSearchExploration({ conversations, query: "telescope" });
    expect(result.totalCount).toBe(5);
    expect(new Set(result.results.map((entry) => entry.id)).size).toBe(5);
    for (const entry of result.results) {
      const conversation = conversations[entry.conversationId];
      const source = entry.evidence.messageId ? conversation.messages.find((message) => message.id === entry.evidence.messageId)!.content
        : conversation.notes!.find((item) => item.id === entry.evidence.noteId)!.content;
      expect(source.slice(entry.evidence.startOffset, entry.evidence.endOffset)).toBe(entry.passage);
      expect(entry.evidence.quote).toBe(entry.passage);
    }
    expect(result.results.find((entry) => entry.evidence.noteId === "private")).toMatchObject({ localOnly: true, evidence: { sourceKind: "annotation" } });
    expect(result.results.find((entry) => entry.evidence.noteId === "b-body")).toMatchObject({ localOnly: false, evidence: { sourceKind: "standalone-note" } });
    expect(result.results.some((entry) => ["system", getStandaloneNoteContextMessageId("body")].includes(entry.evidence.messageId ?? ""))).toBe(false);
    expect(conversations).toEqual(original);
  });

  test("keeps complete corpus counts and map membership even when the displayed result slice is limited", () => {
    const conversations = index(...Array.from({ length: 65 }, (_, i) => chat(`a${i}`, "needle We decided on the design.")));
    const result = buildSearchExploration({ conversations, query: "needle", limit: 12 });
    expect(result.results).toHaveLength(12);
    expect(result.totalCount).toBe(65);
    expect(result.workspaceCount).toBe(130);
    expect(result.matchedConversationIds).toHaveLength(65);
    expect(count(result, "type:chat")).toBe(65);
    expect(count(result, "purpose:decision")).toBe(65);
    expect(buildSearchExploration({ conversations, query: "needle" }).results).toHaveLength(65);
  });

  test("supports overlapping purpose filters, OR within a dimension, AND across dimensions, and useful disjunctive counts", () => {
    const conversations = index(
      chat("a", "needle We decided after benchmark evidence."),
      chat("b", "needle Another approach instead."),
      note("c", "needle Decision: choose labels."),
      note("d", "needle Evidence according to measurements."),
    );
    const combined = buildSearchExploration({ conversations, query: "needle", activeFacetIds: ["purpose:decision", "purpose:evidence"] });
    expect(combined.totalCount).toBe(3);
    expect(count(combined, "purpose:decision")).toBe(2);
    expect(count(combined, "purpose:evidence")).toBe(2);
    const restricted = buildSearchExploration({ conversations, query: "needle", activeFacetIds: ["purpose:decision", "type:chat"] });
    expect(restricted.results.map((result) => result.conversationId)).toEqual(["a"]);
    expect(count(restricted, "purpose:alternative")).toBe(1);
    expect(count(restricted, "type:note")).toBe(1);
    expect(restricted.facets.find((facet) => facet.id === "purpose:decision")?.selected).toBe(true);
    expect(buildSearchExploration({ conversations, query: "needle", activeFacetIds: ["group:id:removed"] }).totalCount).toBe(0);
  });

  test("includes group, type, and automatic topic facets without changing persistent assignments", () => {
    const a = chat("a", "needle Use a TypeScript API component and typography design.");
    const b = note("b", "needle Camping checklist.");
    const groups: Record<string, ConversationGroup> = { project: { id: "project", name: "Website", color: "#333", collapsed: false, conversationIds: ["a"] } };
    const original = structuredClone(groups);
    const result = buildSearchExploration({ conversations: index(a, b), groups, query: "needle" });
    expect(count(result, "group:id:project")).toBe(1);
    expect(count(result, "group:ungrouped")).toBe(1);
    expect(count(result, "topic:coding")).toBe(1);
    expect(count(result, "topic:design")).toBe(1);
    expect(count(result, "type:note")).toBe(1);
    expect(groups).toEqual(original);
  });

  test("current-chat context can boost relevant older passages while ordinary search retains recency", () => {
    const current = chat("current", "Investigate cache eviction memory constraints.");
    const older = chat("older", "tradeoffs for cache eviction memory", "2026-09-01T00:00:00Z");
    const recent = chat("recent", "tradeoffs for planting vegetables", "2026-09-19T00:00:00Z");
    const options = { conversations: index(current, older, recent), query: "tradeoffs", currentConversationId: "current" };
    expect(buildSearchExploration(options).results[0].conversationId).toBe("recent");
    expect(buildSearchExploration({ ...options, contextual: true }).results[0].conversationId).toBe("older");
  });

  test("queryless directions are grounded, varied, and apply to real nonempty result sets", () => {
    const conversations = index(chat("a", "We decided to use a TypeScript API."), note("b", "Evidence from the measurements."), chat("c", "What remains unknown about the garden?"));
    const result = buildSearchExploration({ conversations, query: "" });
    expect(result.directions).toHaveLength(3);
    expect(new Set(result.directions.map((direction) => direction.id)).size).toBe(3);
    for (const direction of result.directions) {
      const filtered = buildSearchExploration({ conversations, query: "", activeFacetIds: direction.facetIds });
      expect(filtered.totalCount).toBe(direction.count);
      expect(direction.count).toBeGreaterThan(0);
    }
    expect(buildSearchExploration({ conversations: {}, query: "" }).directions).toEqual([]);
    expect(buildSearchExploration({ conversations, query: "unknown" }).directions).toEqual([]);
  });

  test("suggests useful directions within a broad typed query without repeating the current result set", () => {
    const conversations = index(chat("a", "## Reminder timing\n\nReading reminders once a week.\n\n## Recovering ideas\n\nReading notes should be easy to find."));
    const result = buildSearchExploration({ conversations, query: "reading" });
    expect(result.directions.length).toBeGreaterThan(0);
    for (const direction of result.directions) {
      expect(direction.count).toBeLessThan(result.totalCount);
      expect(buildSearchExploration({ conversations, query: "reading", activeFacetIds: direction.facetIds }).totalCount).toBe(direction.count);
    }
  });

  test("different passages in the same chat can support different directions without treating code punctuation as questions", () => {
    const a = chat("a", "We decided to proceed.\n\nEvidence according to measurements.\n\nAnother approach instead.\n\nconst result = ready ? first : second;");
    const result = buildSearchExploration({ conversations: index(a), query: "" });
    expect(result.directions).toHaveLength(3);
    expect(count(result, "purpose:open-question")).toBe(0);
    expect(result.directions.every((direction) => direction.count === 1)).toBe(true);
  });

  test("matches explicit terms within a passage and keeps original Unicode offsets and bounded long passages", () => {
    const content = `🙂 Intro.\n\nİstanbul CAFÉ telescope.\n\n${"word ".repeat(600)}needle end`;
    const a = chat("a", content);
    const matches = buildSearchExploration({ conversations: index(a), query: "café telescope" });
    expect(matches.totalCount).toBe(1);
    const exact = matches.results[0].evidence;
    expect(content.slice(exact.startOffset, exact.endOffset)).toBe("İstanbul CAFÉ telescope.");
    const long = buildSearchExploration({ conversations: index(a), query: "needle" }).results[0];
    expect(long.passage.length).toBeLessThanOrEqual(1200);
    expect(content.slice(long.evidence.startOffset, long.evidence.endOffset)).toBe(long.passage);
    expect(long.preview).toContain("needle");
    expect(long.preview.length).toBeLessThanOrEqual(220);
    expect(buildSearchExploration({ conversations: index(a), query: "Intro telescope" }).totalCount).toBe(0);
  });

  test("previews Markdown tables as readable text even when a match is late in the passage", () => {
    const a = chat("a", `| Moment | Action |\n| --- | --- |\n${"| Arriving | Continue reading |\n".repeat(8)}| Finishing | Reflection prompt |`);
    const result = buildSearchExploration({ conversations: index(a), query: "reflection" }).results[0];
    expect(result.preview).toContain("Reflection prompt");
    expect(result.preview).not.toContain("|");
    expect(result.passage).toContain("| Finishing |");
  });
});
