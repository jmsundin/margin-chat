import { describe, expect, test } from "bun:test";
import { changedAnswerSources, createVaultAnswerDocument, findSavedAnswer, isVaultAnswer, markCitedPassages, questionSimilarity, updateVaultAnswerDocument, vaultAnswerMarkdown, vaultAnswerMessages, vaultAnswerSettings, vaultAnswerSources } from "../client/src/lib/vaultAnswer";
import type { AIRetrievalRecord } from "../client/src/types";

const retrieval: AIRetrievalRecord = { status: "used", meaning: true, passages: [
  { label: "Vault 1", id: "rapa", kind: "document", title: "Rapamycin", heading: "Mice", matched: "both", blockId: "b1" },
  { label: "Vault 2", id: "file-1", openId: "trial", kind: "file", title: "ITP results.pdf", heading: "Page 3", matched: "meaning" },
  { label: "Vault 3", id: "rapa", kind: "document", title: "Rapamycin", heading: "Dose", matched: "keyword" },
  { label: "Vault 4", id: "sleep", kind: "note", title: "Sleep [draft]", matched: "meaning" },
] };
let counter = 0;
const createId = (prefix: string) => `${prefix}-${++counter}`;

describe("Answer from my vault", () => {
  test("asks for the workspace's passages without an agent, and sends the question as the user's own words", () => {
    expect(vaultAnswerSettings({ mode: "fast", contextScope: "conversation", selectedConversationIds: ["x"], agent: true })).toMatchObject({
      mode: "thorough", contextScope: "workspace", agent: false, selectedConversationIds: [] });
    const messages = vaultAnswerMessages("  Does rapamycin help old mice? ", "2026-11-07T00:00:00Z", createId);
    expect(messages.map((message) => message.role)).toEqual(["system", "user"]);
    expect(messages[0].content).toContain("[Vault N]");
    // The server searches the vault by the latest user message, so it is the bare question.
    expect(messages[1].content).toBe("Does rapamycin help old mice?");
  });

  test("marks what the answer cites and lists sources cited first, one per document", () => {
    const marked = markCitedPassages(retrieval, "Yes, in mice [Vault 2], at weekly doses [Vault 1, 3].")!;
    expect(marked.passages.map((passage) => !!passage.cited)).toEqual([true, true, true, false]);
    expect(vaultAnswerSources(marked).map((passage) => passage.title)).toEqual(["Rapamycin", "ITP results.pdf", "Sleep [draft]"]);
    expect(vaultAnswerSources(null)).toEqual([]);
  });

  test("a saved answer links each citation and lists its sources as [[links]]", () => {
    const markdown = vaultAnswerMarkdown("Yes, in mice [Vault 2], at weekly doses [Vault 1, 3]. Unknown [Vault 9].", retrieval);
    expect(markdown).toBe("Yes, in mice ([[ITP results.pdf]]), at weekly doses ([[Rapamycin]]). Unknown.\n\n## Sources\n\n- [[ITP results.pdf]] · Page 3\n- [[Rapamycin]] · Mice");
    expect(vaultAnswerMarkdown("Nothing here covers it.", { status: "none-found", meaning: true, passages: [] })).toBe("Nothing here covers it.");
    expect(vaultAnswerMarkdown("See [Vault 4].", retrieval)).toContain("[[Sleep draft]]");
  });

  test("the saved document is top level, titled by the question, and its text is credited to AI", () => {
    const saved = createVaultAnswerDocument({ question: "Does rapamycin help old mice?", answer: "Yes [Vault 1].", retrieval,
      serviceId: "openai", modelId: "gpt", createId, now: "2026-11-07T00:00:00Z" });
    expect(saved).toMatchObject({ parentId: null, title: "Does rapamycin help old mice", childIds: [] });
    expect(saved.messages.map((message) => message.role)).toEqual(["user", "assistant"]);
    const blocks = saved.document!.blocks;
    expect(blocks.map((block) => block.content).join("")).toContain("Yes ([[Rapamycin]]).");
    expect(blocks.every((block) => block.authorship === "ai" && block.sourceMessageId === saved.messages[1].id)).toBe(true);
  });
});

describe("saved answers", () => {
  const conversations = () => {
    const rapa = createVaultAnswerDocument({ question: "x", answer: "x", retrieval: null, serviceId: "openai", modelId: "gpt", createId });
    return rapa;
  };

  test("a saved answer is typed, cites what it cited, and survives being written to Markdown and read back", async () => {
    const { createEmptyState, createStandaloneNoteConversation } = await import("../client/src/initialState");
    const { createMarkdownWorkspace, parseMarkdownWorkspace } = await import("../client/src/lib/workspaceMarkdown");
    const state = createEmptyState();
    for (const [id, title] of [["rapa", "Rapamycin"], ["trial", "ITP trial"]]) {
      const note = createStandaloneNoteConversation({ createdAt: "2026-10-01T10:00:00.000Z", id, noteId: `${id}-note` });
      note.title = title;
      state.conversations[id] = note;
    }
    const saved = createVaultAnswerDocument({ question: "Does rapamycin help old mice?", answer: "Yes [Vault 1], in a trial [Vault 2].",
      retrieval, serviceId: "openai", modelId: "gpt", createId, now: "2026-11-07T00:00:00.000Z" });
    expect(saved.nodeType).toBe("answer");
    expect(saved.relations).toEqual([
      { type: "cites", targetConversationId: "rapa", targetBlockId: "b1", origin: "ai", createdAt: "2026-11-07T00:00:00.000Z" },
      { type: "cites", targetConversationId: "trial", origin: "ai", createdAt: "2026-11-07T00:00:00.000Z" },
    ]);
    state.conversations[saved.id] = saved;
    state.rootConversationIds = [...(state.rootConversationIds ?? []), saved.id];
    const workspace = createMarkdownWorkspace(state, "2026-11-07T00:00:00.000Z");
    const parsed = parseMarkdownWorkspace(workspace.manifest, workspace.files)!;
    const back = parsed.conversations[saved.id];
    expect(back.nodeType).toBe("answer");
    expect(back.relations?.map((relation) => [relation.type, relation.targetConversationId, relation.createdAt])).toEqual([
      ["cites", "rapa", "2026-11-07T00:00:00.000Z"], ["cites", "trial", "2026-11-07T00:00:00.000Z"]]);
    expect(isVaultAnswer(back)).toBe(true);
  });

  test("an earlier answer to the same question is found, and an edited source marks it worth refreshing", () => {
    const saved = createVaultAnswerDocument({ question: "Does rapamycin help old mice?", answer: "Yes [Vault 1].", retrieval,
      serviceId: "openai", modelId: "gpt", createId, now: "2026-11-07T00:00:00.000Z" });
    const rapa = { ...conversations(), id: "rapa", nodeType: undefined, updatedAt: "2026-11-06T00:00:00.000Z" };
    const all = { [saved.id]: saved, rapa };
    expect(findSavedAnswer(all, "does rapamycin help old mice")?.id).toBe(saved.id);
    expect(findSavedAnswer(all, "how does metformin work")).toBeNull();
    expect(questionSimilarity("Does rapamycin help old mice?", "rapamycin old mice help")).toBeGreaterThan(0.75);
    expect(changedAnswerSources(all, saved)).toEqual([]);
    const edited = { ...all, rapa: { ...rapa, updatedAt: "2026-11-08T00:00:00.000Z" } };
    expect(changedAnswerSources(edited, saved).map((source) => source.id)).toEqual(["rapa"]);
  });

  test("updating replaces an untouched answer, and keeps the user's own lines under a new heading", () => {
    const saved = createVaultAnswerDocument({ question: "Does rapamycin help?", answer: "Yes [Vault 1].", retrieval,
      serviceId: "openai", modelId: "gpt", createId, now: "2026-11-07T00:00:00.000Z" });
    const fresh = updateVaultAnswerDocument(saved, { answer: "Probably [Vault 2].", retrieval, createId, now: "2026-11-09T00:00:00.000Z" });
    expect(fresh.document!.blocks.map((block) => block.content).join("")).toContain("Probably ([[ITP results.pdf]]).");
    expect(fresh.document!.blocks.map((block) => block.content).join("")).not.toContain("Yes");
    expect(fresh.relations).toEqual([{ type: "cites", targetConversationId: "trial", origin: "ai", createdAt: "2026-11-09T00:00:00.000Z" }]);

    const mine = { ...saved, document: { ...saved.document!, blocks: [...saved.document!.blocks,
      { id: "mine", kind: "markdown" as const, content: "My own note.", createdAt: "x", updatedAt: "x", authorship: "user" as const }] } };
    const kept = updateVaultAnswerDocument(mine, { answer: "Probably [Vault 2].", retrieval, createId, now: "2026-11-09T00:00:00.000Z" });
    const text = kept.document!.blocks.map((block) => block.content).join("\n");
    expect(text).toContain("My own note.");
    expect(text).toContain("## Updated answer, 2026-11-09");
    expect(kept.relations!.map((relation) => relation.targetConversationId)).toEqual(["rapa", "trial"]);
  });
});
