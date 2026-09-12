import { describe, expect, test } from "bun:test";
import {
  createChildConversation,
  createMainConversation,
  createStandaloneNoteConversation,
} from "../client/src/initialState";
import {
  buildSearchResults,
  buildThreadSummaries,
} from "../client/src/lib/conversationSearch";

function makeConversations() {
  const root = createMainConversation({ id: "root", createdAt: "2026-01-01" });
  root.title = "Research";
  const child = createChildConversation({
    id: "child",
    parentConversation: root,
    createdAt: "2026-01-03",
  });
  child.title = "Follow-up";
  child.messages = [
    {
      id: "message",
      role: "assistant",
      content: "A result about telescopes",
      createdAt: child.createdAt,
    },
  ];
  const other = createMainConversation({
    id: "other",
    createdAt: "2026-01-02",
  });
  other.title = "Other thread";
  return { root, child, other };
}

describe("conversation search and summaries", () => {
  test("uses the latest branch activity for its root without mixing other threads", () => {
    const conversations = makeConversations();
    const original = structuredClone(conversations);
    const summaries = buildThreadSummaries(conversations);

    expect(summaries.map(({ id }) => id)).toEqual(["root", "other"]);
    expect(summaries[0]).toMatchObject({
      conversationCount: 2,
      preview: "A result about telescopes",
      updatedAt: "2026-01-03",
    });
    expect(summaries[1]).toMatchObject({
      conversationCount: 1,
      preview: "No messages yet.",
    });
    expect(conversations).toEqual(original);
  });

  test("finds branch messages case-insensitively with their root context", () => {
    const results = buildSearchResults(makeConversations(), "  TELESCOPES  ");

    expect(results).toHaveLength(1);
    expect(results[0]).toMatchObject({
      conversationId: "child",
      locationLabel: "Branch conversation",
      matchLabel: "assistant message",
      rootTitle: "Research",
    });
    expect(results[0]).not.toHaveProperty("updatedAt");
  });

  test("preserves title priority over matching message content", () => {
    const conversations = makeConversations();
    conversations.child.title = "Telescopes";
    expect(buildSearchResults(conversations, "telescopes")[0]).toMatchObject({
      matchLabel: "Branch title",
      preview: 'Inside "Research"',
    });
  });

  test("shows empty standalone notes and distinguishes margin note matches", () => {
    const conversations = makeConversations();
    const note = createStandaloneNoteConversation({
      id: "note",
      noteId: "body",
      createdAt: "2026-01-04",
    });
    conversations.root.notes = [
      {
        ...note.notes![0],
        id: "annotation",
        kind: "comment",
        content: "My telescope observation",
      },
    ];
    const all = { ...conversations, note };

    expect(buildThreadSummaries(all)[0]).toMatchObject({
      kind: "note",
      preview: "Empty note",
    });
    expect(buildSearchResults(all, "  ")[0]).toMatchObject({
      conversationId: "note",
      matchLabel: "Recent note",
    });
    expect(buildSearchResults(all, "observation")[0]).toMatchObject({
      conversationId: "root",
      matchLabel: "Margin note",
    });
    note.notes![0].content = "A private observation";
    expect(
      buildSearchResults(all, "observation").find(
        ({ conversationId }) => conversationId === "note",
      ),
    ).toMatchObject({ matchLabel: "Note content" });
  });

  test("caps matching results at the 40 most recent conversations", () => {
    const conversations = Object.fromEntries(
      Array.from({ length: 45 }, (_, index) => {
        const conversation = createMainConversation({
          id: `root-${index}`,
          createdAt: new Date(Date.UTC(2026, 0, index + 1)).toISOString(),
        });
        conversation.title = "Matching thread";
        return [conversation.id, conversation];
      }),
    );
    const results = buildSearchResults(conversations, "matching");
    expect(results).toHaveLength(40);
    expect(results[0].conversationId).toBe("root-44");
    expect(results[39].conversationId).toBe("root-5");
    expect(buildSearchResults(conversations, "absent")).toEqual([]);
  });
});
