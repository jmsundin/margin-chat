import { describe, expect, test } from "bun:test";
import {
  createChildConversation,
  createMainConversation,
  createStandaloneNoteConversation,
} from "../client/src/initialState";
import { getConversationRequestPayload } from "../client/src/lib/chatContext";
import { getStandaloneNoteContextMessageId } from "../client/src/lib/standaloneNotes";
import type { Conversation, Message } from "../client/src/types";

function message(id: string): Message {
  return { id, content: id, role: "user", createdAt: "2026-01-01" };
}

function branch(parent: Conversation, id: string, sourceMessageId: string) {
  const child = createChildConversation({ id, parentConversation: parent });
  child.branchAnchor = {
    id: `anchor-${id}`,
    sourceConversationId: parent.id,
    sourceMessageId,
    quote: "text",
    prompt: "Explain",
    startOffset: 0,
    endOffset: 4,
    createdAt: child.createdAt,
  };
  return child;
}

describe("chat request context", () => {
  test("cuts each ancestor at its branch anchor, including a newly created leaf", () => {
    const root = createMainConversation({ id: "root" });
    root.messages = [
      message("root-before"),
      message("root-anchor"),
      message("root-after"),
    ];
    const child = branch(root, "child", "root-anchor");
    child.messages = [message("child-anchor"), message("child-after")];
    const leaf = branch(child, "leaf", "child-anchor");
    const conversations = { root, child };
    const original = structuredClone(conversations);

    const payload = getConversationRequestPayload(conversations, leaf);

    expect(
      payload.ancestorContext.map(({ id, messages }) => ({
        id,
        messages: messages.map(({ id }) => id),
      })),
    ).toEqual([
      { id: "root", messages: ["root-before", "root-anchor"] },
      { id: "child", messages: ["child-anchor"] },
    ]);
    expect(payload.id).toBe("leaf");
    expect(conversations).toEqual(original);
  });

  test("inherits full history for side chats without a text anchor", () => {
    const root = createMainConversation({ id: "root" });
    root.messages = [message("first"), message("second")];
    const child = createChildConversation({
      id: "child",
      parentConversation: root,
    });
    expect(
      getConversationRequestPayload({ root }, child).ancestorContext[0]
        .messages,
    ).toEqual(root.messages);
  });

  test("uses current standalone note content without including private margin notes", () => {
    const note = createStandaloneNoteConversation({
      id: "note",
      noteId: "body",
    });
    note.notes![0].content = "Current note content";
    note.notes!.push({
      ...note.notes![0],
      id: "private",
      kind: "comment",
      content: "Private margin annotation",
    });
    note.messages = [message("old-note-context")];
    const child = createChildConversation({
      id: "child",
      parentConversation: note,
    });

    const context = getConversationRequestPayload({ note }, child)
      .ancestorContext[0];

    expect(context.messages).toEqual([
      {
        id: getStandaloneNoteContextMessageId("body"),
        content: "Current note content",
        role: "user",
        createdAt: note.notes![0].updatedAt,
      },
    ]);
    expect(context).not.toHaveProperty("notes");
  });

  test("builds root requests with no ancestors and defaults missing attachments", () => {
    const root = createMainConversation({ id: "root" });
    delete root.documents;
    expect(getConversationRequestPayload({ root }, root)).toMatchObject({
      ancestorContext: [],
      branchAnchor: null,
      documents: [],
      id: "root",
      parentId: null,
    });
  });
});
