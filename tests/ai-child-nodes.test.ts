import { expect, test } from "bun:test";
import { createEmptyState, createMainConversation } from "../client/src/initialState";
import { addAIChildNodes, getGenerationBlocks, proposeAIChildNodes } from "../client/src/lib/aiChildNodes";
import { getEditableDocument } from "../client/src/lib/editableDocument";
import { getDocumentKind, getPresentedParentId } from "../client/src/lib/documentBreadcrumbs";
import { getDocumentWorkspace } from "../client/src/lib/documentWorkspace";
import type { AppState, Conversation } from "../client/src/types";

const date = "2026-10-09T00:00:00.000Z";

function withAnswer(content: string): { state: AppState; parent: Conversation } {
  const parent = createMainConversation({ id: "parent", createdAt: date });
  parent.messages = [
    { id: "question", role: "user", content: "Explain the 2008 crisis.", createdAt: date },
    { id: "answer", role: "assistant", content, createdAt: date },
  ];
  parent.document = getEditableDocument(parent);
  const empty = createEmptyState();
  return { parent, state: { ...empty, rootId: parent.id, activeConversationId: parent.id, conversations: { [parent.id]: parent }, graphLayouts: { [parent.id]: { x: 0, y: 0, width: 300, height: 200 } } } };
}

function proposals(parent: Conversation) {
  const document = getEditableDocument(parent);
  return proposeAIChildNodes(getGenerationBlocks(document, document.generations[0]));
}

test("headings split a response into sections, skipping a lone title heading", () => {
  const { parent } = withAnswer("# The 2008 crisis\n\nIntro.\n\n## Causes\n\nThe **housing** bubble.\n\n## Effects\n\n- Jobs lost\n- Banks failed\n\n## Responses\n\nTARP and rate cuts.\n");
  const result = proposals(parent);
  expect(result.map((item) => item.title)).toEqual(["Causes", "Effects", "Responses"]);
  expect(result[1].content).toBe("- Jobs lost\n- Banks failed");
  const blocks = getEditableDocument(parent).blocks;
  for (const item of result) expect(blocks.find((block) => block.id === item.blockId)!.content.slice(item.from, item.to)).toBe(item.title);
});

test("without headings the main list's items become nodes, titled by their bold lead-in or first sentence", () => {
  const { parent } = withAnswer("Options:\n\n1. **Kafka**: a durable log.\n   - partitions\n2. **SQS**: a managed queue.\n3. Redis streams are fast. Also cheap.\n");
  const result = proposals(parent);
  expect(result.map((item) => item.title)).toEqual(["Kafka", "SQS", "Redis streams are fast"]);
  expect(result[0].content).toBe("**Kafka**: a durable log.\n- partitions");
});

test("plain paragraphs are the fallback, and a single paragraph proposes nothing", () => {
  expect(proposals(withAnswer("Photosynthesis makes sugar. More detail.\n\nRespiration: burns it.\n").parent).map((item) => item.title))
    .toEqual(["Photosynthesis makes sugar", "Respiration"]);
  expect(proposals(withAnswer("Just one short answer.").parent)).toEqual([]);
});

test("picked proposals become anchored children of the parent, beside it in the map and closed in Document view", () => {
  const { state, parent } = withAnswer("## Causes\n\nThe housing bubble.\n\n## Effects\n\nJobs lost.\n");
  const picked = proposals(parent).map((item, index) => index === 1 ? { ...item, title: "What happened next" } : item);
  let counter = 0;
  const { state: next, createdIds } = addAIChildNodes(state, parent.id, picked, { createId: (prefix) => `${prefix}-${++counter}`, now: date });
  expect(createdIds).toHaveLength(2);
  expect(next.conversations[parent.id].childIds).toEqual(createdIds);
  expect(next.activeConversationId).toBe(parent.id);
  const [causes, effects] = createdIds.map((id) => next.conversations[id]);
  expect(causes.title).toBe("Causes");
  expect(effects.title).toBe("What happened next");
  expect(getEditableDocument(effects).blocks.map((block) => block.content).join("")).toBe("Jobs lost.");
  expect(getEditableDocument(effects).blocks[0].authorship).toBe("ai");
  for (const child of [causes, effects]) {
    expect(getDocumentKind(child)).toBe("branch");
    expect(getPresentedParentId(next.conversations, child.id)).toBe(parent.id);
    expect(next.graphLayouts[child.id].x).toBeGreaterThan(next.graphLayouts[parent.id].x);
  }
  const anchor = causes.branchAnchor!;
  const source = getEditableDocument(parent).blocks.find((block) => block.id === anchor.sourceBlockId)!;
  expect(source.content.slice(anchor.startOffset, anchor.endOffset)).toBe("Causes");
  expect(anchor.sourceMessageId).toBe("answer");
  expect(getDocumentWorkspace(next.conversations, parent.id).closedIds).toEqual(createdIds);
});
