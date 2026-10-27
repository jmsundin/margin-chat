import { describe, expect, test } from "bun:test";
import { createEmptyState } from "../client/src/initialState";
import { addExampleVault, EXAMPLE_ROOT_ID, hasExampleVault } from "../client/src/lib/exampleVault";
import { completedStarterTasks, seedStarterDocument, STARTER_TITLE } from "../client/src/lib/starterDocument";
import { getDocumentGraphEdges } from "../client/src/lib/documentRelations";
import { onDevicePromptLimit, ON_DEVICE_PROMPT_CHARACTERS } from "../client/src/lib/onDeviceAI";
import { getEditableDocument } from "../client/src/lib/editableDocument";
import { ensureSessions } from "../client/src/lib/workspaceSessions";

const at = "2026-10-27T03:00:00.000Z";
// The workspace has its first session by the time the trial adds the examples.
const trial = () => addExampleVault(ensureSessions(seedStarterDocument(createEmptyState(), at), [], at), at);

describe("trial example vault", () => {
  test("adds linked documents, groups, margin notes, side documents, AI answers and a second session", () => {
    const state = trial();
    const conversations = Object.values(state.conversations);
    expect(hasExampleVault(state)).toBe(true);
    expect(conversations.length).toBeGreaterThan(20);
    expect(Object.values(state.groups).map((group) => group.name)).toEqual(["Aging biology", "Interventions", "Questions and reading"]);
    expect(conversations.some((item) => item.document?.marginNote && item.id.startsWith("example-"))).toBe(true);
    const answers = conversations.filter((item) => item.id.startsWith("example-ai-"));
    expect(answers.length).toBe(2);
    for (const answer of answers) expect(getEditableDocument(answer).blocks.some((block) => block.authorship === "ai")).toBe(true);
    expect(Object.values(state.sessions?.items ?? {}).map((session) => session.name)).toContain("Aging research");
    expect(state.sessions?.activeId).not.toBe("example-session-research");
    // Typed relations and [[links]] in the text both become lines on the map.
    const edges = getDocumentGraphEdges(state.conversations);
    expect(edges.filter((edge) => edge.kind === "relation").length).toBeGreaterThan(10);
    expect(edges.filter((edge) => edge.kind === "mention").length).toBeGreaterThan(10);
  });

  test("anchors every note, side document and answer to its passage", () => {
    const state = trial();
    for (const item of Object.values(state.conversations)) {
      const anchor = item.branchAnchor;
      if (!anchor || !item.id.startsWith("example-")) continue;
      const block = state.conversations[anchor.sourceConversationId].document!.blocks.find((candidate) => candidate.id === anchor.sourceBlockId)!;
      expect(block.content.slice(anchor.startOffset, anchor.endOffset)).toBe(anchor.quote);
    }
  });

  test("points Start here at the examples without ticking any of its tasks", () => {
    const state = trial();
    const start = Object.values(state.conversations).find((item) => item.title === STARTER_TITLE)!;
    expect(start.document!.blocks[1].content).toContain("[[Why we age]]");
    expect(completedStarterTasks(state).size).toBe(0);
    expect(state.activeConversationId).toBe(start.id);
  });

  test("is added once", () => {
    const state = trial();
    expect(addExampleVault(state, at)).toBe(state);
    expect(state.conversations[EXAMPLE_ROOT_ID].title).toBe("Why we age");
  });
});

describe("on-device prompt size", () => {
  test("follows the model's context window and leaves room for the answer", () => {
    expect(onDevicePromptLimit({})).toBe(ON_DEVICE_PROMPT_CHARACTERS);
    expect(onDevicePromptLimit({ contextWindow: 1000, contextUsage: 100 })).toBe(1620);
    expect(onDevicePromptLimit({ inputQuota: 6144, inputUsage: 0 })).toBe(11_059);
    expect(onDevicePromptLimit({ contextWindow: 9216 })).toBe(ON_DEVICE_PROMPT_CHARACTERS);
  });
});
