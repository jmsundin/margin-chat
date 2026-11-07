import { describe, expect, test } from "bun:test";
import { buildNoteChatMessage, findNoteChat, splitTryNext } from "../client/src/lib/noteChat";
import type { Conversation } from "../client/src/types";

const base = { serviceId: "backend-services", modelId: "smart-routing", branchAnchor: null, messages: [], notes: [], documents: [], createdAt: "2026-11-07T00:00:00.000Z", updatedAt: "2026-11-07T00:00:00.000Z" } as const;
const doc = { ...base, id: "doc", kind: "note", title: "Rapamycin", parentId: null, childIds: ["side", "chat"],
  document: { schemaVersion: 1, blocks: [{ id: "b1", kind: "markdown", content: "Rapamycin extends lifespan in mice.", authorship: "user", createdAt: base.createdAt, updatedAt: base.createdAt, sourceMessageId: null }], prompts: [], generations: [] } } as unknown as Conversation;
const side = { ...base, id: "side", kind: "chat", title: "Side", parentId: "doc", childIds: [] } as unknown as Conversation;
const chat = { ...base, id: "chat", kind: "chat", title: "Questions", parentId: "doc", childIds: [], noteChat: true } as unknown as Conversation;

describe("Ask about this note", () => {
  test("finds the document's own note chat, not its other children", () => {
    expect(findNoteChat({ doc, side, chat }, "doc")?.id).toBe("chat");
    expect(findNoteChat({ doc, side }, "doc")).toBeNull();
    expect(findNoteChat({}, "doc")).toBeNull();
  });

  test("sends the whole note, the standing instruction and the Try next ask with the question", () => {
    const message = buildNoteChatMessage(doc, { id: "m", role: "user", content: "Is this proven?", createdAt: base.createdAt }, { instruction: "Be blunt", thinks: true });
    expect(message.content).toContain("Rapamycin extends lifespan in mice.");
    expect(message.content).toContain("### Try next");
    expect(message.content).toContain("Be blunt");
    expect(message.content).toContain("makes the user think");
    expect(message.content.endsWith("Is this proven?")).toBe(true);
    expect(buildNoteChatMessage(doc, { id: "m", role: "user", content: "Q", createdAt: base.createdAt }).content).not.toContain("makes the user think");
  });

  test("splits an answer's Try next list off its body", () => {
    expect(splitTryNext("Answer.\n\n### Try next\n\n- First\n* **Second**\n1. Third")).toEqual({ body: "Answer.", tryNext: ["First", "Second", "Third"] });
    expect(splitTryNext("No list here.")).toEqual({ body: "No list here.", tryNext: [] });
    expect(splitTryNext("Answer.\n\n## Try next\n\nnothing listed")).toEqual({ body: "Answer.\n\n## Try next\n\nnothing listed", tryNext: [] });
  });
});
