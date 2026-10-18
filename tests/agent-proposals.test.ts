import { describe, expect, test } from "bun:test";
import type { AgentProposal, AIExecutionRecord, Conversation } from "../client/src/types";
import { createMainConversation } from "../client/src/initialState";
import { applyTextEdit, canUndoProposal, undoEditArguments, withProposalUpdate } from "../client/src/lib/agentProposals";
import { getEditableDocument, getEditableDocumentText, type DocumentBlock } from "../client/src/lib/editableDocument";

const now = "2026-10-18T12:00:00.000Z";
const later = "2026-10-18T13:00:00.000Z";

function documentWith(contents: string[], authorship: DocumentBlock["authorship"] = "user"): Conversation {
  const conversation = createMainConversation({ id: "plans", createdAt: now });
  const document = getEditableDocument(conversation);
  return { ...conversation, document: { ...document,
    blocks: contents.map((content, index) => ({ id: `block-${index}`, kind: "markdown", content, createdAt: now, updatedAt: now, authorship })) } };
}
const edited = (result: Conversation | string) => {
  if (typeof result === "string") throw new Error(`The edit failed: ${result}`);
  return result;
};
const blocksOf = (conversation: Conversation) => conversation.document!.blocks.map(({ id, content, authorship }) => ({ id, content, authorship }));

describe("applying an approved edit", () => {
  test("replaces text inside one block, which keeps its ID and shows as partly AI-written", () => {
    const conversation = documentWith(["# Plans", "Summarize the goals.", "Ship the beta."]);
    const result = edited(applyTextEdit(conversation, "Summarize", "Outline", later));
    expect(blocksOf(result)).toEqual([
      { id: "block-0", content: "# Plans", authorship: "user" },
      { id: "block-1", content: "Outline the goals.", authorship: "mixed" },
      { id: "block-2", content: "Ship the beta.", authorship: "user" },
    ]);
    expect(result.updatedAt).toBe(later);
    expect(result.document!.blocks[1].updatedAt).toBe(later);
  });

  test("an edit across blocks merges them, and new paragraphs become blocks of their own", () => {
    const conversation = documentWith(["One.", "Two.", "Three."]);
    const result = edited(applyTextEdit(conversation, "One.\n\nTwo", "First.\n\nSecond.\n\n- a list", later));
    expect(getEditableDocumentText(result)).toBe("First.\n\nSecond.\n\n- a list.\n\nThree.");
    expect(result.document!.blocks[0].id).toBe("block-0");
    expect(new Set(result.document!.blocks.map((block) => block.id)).size).toBe(result.document!.blocks.length);
    expect(result.document!.blocks.at(-1)).toMatchObject({ id: "block-2", content: "Three.", authorship: "user" });
  });

  test("an edit wholly inside AI-written text stays AI-written", () => {
    const result = edited(applyTextEdit(documentWith(["An AI paragraph."], "ai"), "AI", "agent", later));
    expect(blocksOf(result)).toEqual([{ id: "block-0", content: "An agent paragraph.", authorship: "ai" }]);
  });

  test("an empty find adds to the end, replacing a trailing empty block", () => {
    const result = edited(applyTextEdit(documentWith(["Intro.", ""]), "", "\n\nA closing line.\n\n", later));
    expect(blocksOf(result)).toEqual([
      { id: "block-0", content: "Intro.", authorship: "user" },
      { id: "agent-edit:plans:edit:0", content: "A closing line.", authorship: "ai" },
    ]);
  });

  test("deleting all the text leaves one empty block", () => {
    const result = edited(applyTextEdit(documentWith(["Only this."]), "Only this.", "", later));
    expect(blocksOf(result)).toEqual([{ id: "empty:plans", content: "", authorship: "user" }]);
  });

  test("text that is gone, or now appears twice, isn't edited", () => {
    const conversation = documentWith(["Ship it.", "Ship it."]);
    expect(applyTextEdit(conversation, "Launch", "Ship", later)).toBe("missing");
    expect(applyTextEdit(conversation, "Ship it.", "Done.", later)).toBe("ambiguous");
  });

  test("the same edit always gives the same document", () => {
    const conversation = documentWith(["A.", "B."]);
    expect(applyTextEdit(conversation, "A.\n\nB.", "C.\n\nD.\n\nE.", later)).toEqual(applyTextEdit(conversation, "A.\n\nB.", "C.\n\nD.\n\nE.", later));
  });
});

describe("undoing and recording a decision", () => {
  const edit: Extract<AgentProposal, { kind: "edit" }> = { id: "proposal-1", kind: "edit", documentId: "plans", documentTitle: "Plans", find: "Summarize", replace: "Outline", summary: "" };
  const create: AgentProposal = { id: "proposal-2", kind: "create", parentId: "plans", parentTitle: "Plans", title: "Pricing", content: "", summary: "" };

  test("only an approved edit that added text can be undone, by finding that text again", () => {
    expect(canUndoProposal(edit)).toBe(false);
    expect(canUndoProposal({ ...edit, status: "approved" })).toBe(true);
    expect(canUndoProposal({ ...edit, status: "approved", replace: " " })).toBe(false);
    expect(canUndoProposal({ ...create, status: "approved" })).toBe(false);
    expect(undoEditArguments(edit)).toEqual(["Outline", "Summarize"]);
    expect(undoEditArguments({ ...edit, find: "", replace: "\nA closing line.\n" })).toEqual(["A closing line.", ""]);
    const applied = edited(applyTextEdit(documentWith(["Summarize the goals."]), "Summarize", "Outline", later));
    expect(getEditableDocumentText(edited(applyTextEdit(applied, ...undoEditArguments(edit), later)))).toBe("Summarize the goals.");
  });

  test("a decision is saved on the reply's record, and undoing makes the proposal pending again", () => {
    const execution = { schemaVersion: 1, model: "m", provider: "meta-api", agent: { steps: [], stopReason: "answered", proposals: [edit, create] } } as unknown as AIExecutionRecord;
    const approved = withProposalUpdate(execution, "proposal-2", { status: "approved", createdId: "pricing-doc" });
    expect(approved.agent!.proposals).toEqual([edit, { ...create, status: "approved", createdId: "pricing-doc" }]);
    expect(execution.agent!.proposals![1]).toEqual(create);
    const undone = withProposalUpdate(withProposalUpdate(execution, "proposal-1", { status: "approved" }), "proposal-1", {});
    expect(undone.agent!.proposals![0]).toEqual(edit);
    expect(withProposalUpdate(execution, "proposal-1", { status: "dismissed", createdId: "ignored" }).agent!.proposals![0]).toEqual({ ...edit, status: "dismissed" });
    const plain = { ...execution, agent: { steps: [], stopReason: "answered" } } as unknown as AIExecutionRecord;
    expect(withProposalUpdate(plain, "proposal-1", { status: "approved" })).toBe(plain);
  });
});
