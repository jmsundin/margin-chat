import { describe, expect, test } from "bun:test";
import { createVaultAnswerDocument, markCitedPassages, vaultAnswerMarkdown, vaultAnswerMessages, vaultAnswerSettings, vaultAnswerSources } from "../client/src/lib/vaultAnswer";
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
