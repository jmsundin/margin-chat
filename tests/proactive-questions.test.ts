import { describe, expect, test } from "bun:test";
import { pickProactivePassage, stanceQuestionPrompt } from "../client/src/lib/proactiveQuestions";
import type { Conversation } from "../client/src/types";

const at = (minute: number) => `2026-11-07T10:${String(minute).padStart(2, "0")}:00.000Z`;
const block = (id: string, content: string, minute: number, authorship: "user" | "ai" = "user") =>
  ({ id, kind: "markdown", content, authorship, createdAt: at(0), updatedAt: at(minute), sourceMessageId: null });
const doc = (blocks: ReturnType<typeof block>[]) => ({ id: "doc", kind: "note", title: "Doc", parentId: null, childIds: [], branchAnchor: null,
  serviceId: "backend-services", modelId: "smart-routing", messages: [], notes: [], documents: [], createdAt: at(0), updatedAt: at(9),
  document: { schemaVersion: 1, blocks, prompts: [], generations: [] } }) as unknown as Conversation;

const LONG = "Rapamycin extends lifespan in mice even when started late in life, which suggests the effect does not need lifelong dosing.";
const LONGER = "I think intermittent dosing avoids the immune side effects, so a weekly dose should be safe for people who want to try it.";

describe("Thinks with you: a question after Enter", () => {
  test("picks the paragraph the user just finished, without its heading marks", () => {
    const passage = pickProactivePassage(doc([block("h", "# Mice", 1), block("a", LONG, 2), block("b", LONGER, 5)]), new Set())!;
    expect(passage.blockId).toBe("b");
    expect(passage.sectionKey).toBe("doc:b:0");
    expect(passage.quote).toBe(LONGER);
    const heading = pickProactivePassage(doc([block("h", "# How do timeshares work?", 3)]), new Set())!;
    expect(heading.quote).toBe("How do timeshares work?");
    expect(heading.from).toBe(2);
  });

  test("asks once per paragraph, and never about the AI's text, a noted paragraph or a thin line", () => {
    const conversation = doc([block("a", LONG, 2), block("b", LONGER, 5)]);
    expect(pickProactivePassage(conversation, new Set(["doc:b:0"]))).toBeNull();
    expect(pickProactivePassage(conversation, new Set(), [{ blockId: "b" }])).toBeNull();
    expect(pickProactivePassage(doc([block("a", LONG, 2, "ai")]), new Set())).toBeNull();
    expect(pickProactivePassage(doc([block("a", "Todo", 2)]), new Set())).toBeNull();
  });

  test("Enter on one bullet questions that bullet alone, even when another bullet has a note", () => {
    const list = "1. One thing. Focus is a survival variable, not a preference.\n2. Build something people are willing to pay for.\n3. Move toward the real work on hard problems.\n4. ";
    const conversation = doc([block("l", list, 4)]);
    const second = list.indexOf("2.");
    const end = list.indexOf("\n3.");
    // The caret at the end of bullet 2, as Enter was pressed.
    const passage = pickProactivePassage(conversation, new Set(), [], { blockId: "l", offset: end })!;
    expect(passage.quote).toBe("Build something people are willing to pay for.");
    expect(passage.from).toBe(second + 3);
    expect(passage.to).toBe(end);
    expect(passage.sectionKey).toBe(`doc:l:${second}`);
    // Enter on the new empty "4. " line finishes bullet 3.
    expect(pickProactivePassage(conversation, new Set(), [], { blockId: "l", offset: list.length })!.quote).toBe("Move toward the real work on hard problems.");
    // A note on bullet 1 doesn't stop a question on bullet 2; a note on bullet 2 does.
    expect(pickProactivePassage(conversation, new Set(), [{ blockId: "l", from: 3, to: 60 }], { blockId: "l", offset: end })).not.toBeNull();
    expect(pickProactivePassage(conversation, new Set(), [{ blockId: "l", from: second + 3, to: end }], { blockId: "l", offset: end })).toBeNull();
    // Without a caret, the last item of the list rather than the whole list.
    expect(pickProactivePassage(conversation, new Set())!.quote).toBe("Move toward the real work on hard problems.");
  });

  test("a paragraph of several lines stays one passage", () => {
    const text = `${LONG}\n${LONGER}`;
    const passage = pickProactivePassage(doc([block("p", text, 4)]), new Set(), [], { blockId: "p", offset: 10 })!;
    expect(passage.quote).toBe(text);
  });

  test("leans the question the way the user chose", () => {
    expect(stanceQuestionPrompt("Ask.", "neutral")).toBe("Ask.");
    expect(stanceQuestionPrompt("Ask.", "antagonistic")).toContain("sceptic");
    expect(stanceQuestionPrompt("Ask.", "supportive")).toContain("strongest version");
  });
});
