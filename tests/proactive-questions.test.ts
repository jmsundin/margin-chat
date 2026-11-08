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
    expect(pickProactivePassage(conversation, new Set(), new Set(["b"]))).toBeNull();
    expect(pickProactivePassage(doc([block("a", LONG, 2, "ai")]), new Set())).toBeNull();
    expect(pickProactivePassage(doc([block("a", "Todo", 2)]), new Set())).toBeNull();
  });

  test("leans the question the way the user chose", () => {
    expect(stanceQuestionPrompt("Ask.", "neutral")).toBe("Ask.");
    expect(stanceQuestionPrompt("Ask.", "antagonistic")).toContain("sceptic");
    expect(stanceQuestionPrompt("Ask.", "supportive")).toContain("strongest version");
  });
});
