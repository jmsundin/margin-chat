import { describe, expect, test } from "bun:test";
import { createEmptyState, createStandaloneNoteConversation } from "../client/src/initialState";
import { applyJevGroupSuggestions } from "../client/src/lib/jevGrouping";
import { buildJevWorkspaceSnapshot } from "../client/src/lib/jevAssistance";

function fixture() {
  const state = createEmptyState();
  const chat = state.conversations[state.rootId];
  chat.messages = [{ id: "prompt", role: "user", content: "Review this interface.", createdAt: chat.createdAt }];
  const note = createStandaloneNoteConversation({ id: "note", noteId: "note-body" });
  note.notes![0].content = "Navigation design decisions.";
  state.conversations[note.id] = note;
  return { state, chat, note };
}

describe("persistent Jev group application", () => {
  test("puts chats and standalone notes into a shared category group without mutating input", () => {
    const { state, chat, note } = fixture();
    const original = structuredClone(state);
    const next = applyJevGroupSuggestions(state, { [chat.id]: "design", [note.id]: "design" }, {});
    expect(next.groups["jev-category-design"].name).toBe("Design");
    expect(next.groups["jev-category-design"].conversationIds).toEqual([chat.id, note.id]);
    expect(next.conversations[chat.id].grouping).toBe("automatic");
    expect(next.conversations[note.id].grouping).toBe("automatic");
    expect(state).toEqual(original);
    expect(applyJevGroupSuggestions(next, { [chat.id]: "coding", [note.id]: "writing" }, {})).toBe(next);
  });

  test("existing semantic matches take priority over category fallback", () => {
    const { state, chat } = fixture();
    state.groups.project = { id: "project", name: "Apollo", color: "#4fbf9f", collapsed: true, conversationIds: [] };
    const next = applyJevGroupSuggestions(state, { [chat.id]: "design" }, { [chat.id]: { groupId: "project", confidence: 0.9 } });
    expect(next.groups.project.conversationIds).toEqual([chat.id]);
    expect(next.groups.project.collapsed).toBe(true);
    expect(next.groups["jev-category-design"]).toBeUndefined();
  });

  test("reuses case-insensitive category names and avoids overwriting an unrelated colliding ID", () => {
    const { state, chat, note } = fixture();
    state.groups.custom = { id: "custom", name: " design ", color: "#4fbf9f", collapsed: false, conversationIds: [] };
    state.groups["jev-category-writing"] = { id: "jev-category-writing", name: "Family", color: "#4fbf9f", collapsed: false, conversationIds: [] };
    const next = applyJevGroupSuggestions(state, { [chat.id]: "design", [note.id]: "writing" }, {});
    expect(next.groups.custom.conversationIds).toEqual([chat.id]);
    expect(next.groups["jev-category-writing"]).toEqual(state.groups["jev-category-writing"]);
    expect(next.groups["jev-category-writing-2"].conversationIds).toEqual([note.id]);
  });

  test("respects manual Ungrouped and existing placements made while analysis was in flight", () => {
    const { state, chat, note } = fixture();
    chat.grouping = "manual";
    state.groups.handPicked = { id: "handPicked", name: "Hand picked", color: "#4fbf9f", collapsed: false, conversationIds: [note.id] };
    expect(applyJevGroupSuggestions(state, { [chat.id]: "design", [note.id]: "design" }, { [chat.id]: { groupId: "handPicked", confidence: 1 } })).toBe(state);
    expect(state.groups.handPicked.conversationIds).toEqual([note.id]);
  });

  test("ignores blank and private-only items, unknown categories, missing IDs, and invalid matches", () => {
    const { state, chat, note } = fixture();
    chat.messages = [{ id: "private", role: "system", content: "Private system instructions", createdAt: chat.createdAt }];
    chat.notes = [{ ...note.notes![0], kind: "comment", content: "Private annotation" }];
    note.notes![0].content = " ";
    expect(applyJevGroupSuggestions(state, { [chat.id]: "design", [note.id]: "writing", missing: "coding" }, {})).toBe(state);
    note.notes![0].content = "Useful writing.";
    expect(applyJevGroupSuggestions(state, { [note.id]: "invented" as any }, { [note.id]: { groupId: "missing", confidence: 0.9 } })).toBe(state);
    state.groups.project = { id: "project", name: "Other", color: "#4fbf9f", collapsed: false, conversationIds: [] };
    const fallback = applyJevGroupSuggestions(state, { [note.id]: "writing" }, { [note.id]: { groupId: "project", confidence: 2 } });
    expect(fallback.groups.project.conversationIds).toEqual([]);
    expect(fallback.groups["jev-category-writing"].conversationIds).toEqual([note.id]);
  });

  test("bounded snapshots advance to ungrouped content after the first batch is organized", () => {
    const { state, chat } = fixture();
    const groupedIds: string[] = [];
    for (let i = 0; i < 60; i++) {
      const note = createStandaloneNoteConversation({ id: `note-${i}`, noteId: `body-${i}` });
      note.notes![0].content = `Content ${i}`;
      note.updatedAt = `2026-09-${String(i < 40 ? 19 : 1).padStart(2, "0")}T00:00:00Z`;
      state.conversations[note.id] = note;
      if (i < 40) groupedIds.push(note.id);
    }
    state.groups.done = { id: "done", name: "Already organized", color: "#4fbf9f", collapsed: false, conversationIds: groupedIds };
    const snapshot = buildJevWorkspaceSnapshot(state.conversations, chat.id, state.groups)!;
    expect(snapshot.items).toHaveLength(40);
    for (let i = 40; i < 60; i++) expect(snapshot.items.some((item) => item.id === `note-${i}`)).toBe(true);
  });
});
