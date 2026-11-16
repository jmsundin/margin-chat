import { describe, expect, test } from "bun:test";
import { PAGE_BESIDE_LINE, buildDocumentAIMessage } from "../client/src/lib/documentAI";
import { buildNoteChatMessage } from "../client/src/lib/noteChat";
import type { Conversation, Message } from "../client/src/types";

const note = { id: "n", kind: "document", title: "HashMap notes", parentId: "game", childIds: [], messages: [], notes: [], documents: [],
  document: { blocks: [{ id: "b", kind: "markdown", content: "merge adds one", authorship: "user", createdAt: "", updatedAt: "" }], prompts: [], generations: [] },
  createdAt: "", updatedAt: "" } as unknown as Conversation;
const question: Message = { id: "m", role: "user", content: "Why is merge better than this?", createdAt: "" };
const beside = { page: "Glider Gauntlet.html", screen: {
  visible: "Lab: Group and count\nQuestion 4 of 6", fields: [{ label: "Your code", value: "counts.put(w, 1);" }], page: "Lab: Group and count\nQuestion 4 of 6\nFooter" } };

function reference(content: string) {
  const line = content.split("\n\n").find((part) => part.startsWith("{"));
  return JSON.parse(line!);
}

describe("Ask AI from a note beside a game", () => {
  test("a document request carries what the game shows now and what was typed into it", () => {
    const sent = buildDocumentAIMessage(note, question, "", { beside }).content;
    expect(sent).toContain(PAGE_BESIDE_LINE);
    expect(reference(sent).pageBesideNow).toEqual({ page: "Glider Gauntlet.html", onScreenNow: beside.screen.visible,
      typedOnScreen: beside.screen.fields, wholePageNow: beside.screen.page });
    expect(sent.endsWith(question.content)).toBe(true);
  });

  test("a question in the note's Ask panel carries it too", () => {
    const sent = buildNoteChatMessage(note, question, { beside }).content;
    expect(sent).toContain(PAGE_BESIDE_LINE);
    expect(reference(sent).pageBesideNow.onScreenNow).toBe(beside.screen.visible);
  });

  test("a note that isn't beside a game asks exactly as before", () => {
    for (const sent of [buildDocumentAIMessage(note, question, "").content, buildDocumentAIMessage(note, question, "", { beside: null }).content, buildNoteChatMessage(note, question).content]) {
      expect(sent).not.toContain("pageBesideNow");
      expect(sent).not.toContain(PAGE_BESIDE_LINE);
    }
  });

  test("a screen with nothing typed and nothing out of view stays small", () => {
    const sent = buildDocumentAIMessage(note, question, "", { beside: { page: "Quiz.html", screen: { visible: "Q1", fields: [], page: "Q1" } } }).content;
    expect(reference(sent).pageBesideNow).toEqual({ page: "Quiz.html", onScreenNow: "Q1" });
  });
});
