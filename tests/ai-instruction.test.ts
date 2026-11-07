import { describe, expect, test } from "bun:test";
import { createMarkdownWorkspace, discoverMarkdownWorkspace, normalizeAIInstruction, parseMarkdownWorkspace } from "@margin-chat/workspace-contracts";
import { createEmptyState } from "../client/src/initialState";
import { buildDiagramAIMessage, buildDocumentAIMessage, documentAIInstruction, documentAIInstructionSource } from "../client/src/lib/documentAI";
import type { Conversation } from "../client/src/types";

const at = "2026-11-07T10:00:00.000Z";

function documentFile(extra: Record<string, unknown>) {
  const state = createEmptyState();
  const conversation = state.conversations[state.rootId];
  Object.assign(conversation, { id: "doc", title: "Doc", createdAt: at, updatedAt: at, childIds: [], ...extra });
  conversation.document = { schemaVersion: 1, prompts: [], generations: [],
    blocks: [{ id: "b", kind: "markdown", content: "Rapamycin is safe.", createdAt: at, updatedAt: at, authorship: "user" }] } as any;
  state.conversations = { doc: conversation };
  const [[path, content]] = Object.entries(createMarkdownWorkspace(state, at).files as Record<string, string>);
  return { path, content, conversation };
}

describe("the document's standing instruction to the AI", () => {
  test("is one line in frontmatter that round-trips, and is left out when empty", () => {
    const { path, content } = documentFile({ aiInstruction: "Be antagonistic: \"disagree\"\nwith my premise." });
    expect(content).toContain('ai-instruction: "Be antagonistic: \\"disagree\\" with my premise."');
    const { manifest, files } = discoverMarkdownWorkspace({ [path]: content });
    expect(parseMarkdownWorkspace(manifest, files)!.conversations.doc.aiInstruction).toBe('Be antagonistic: "disagree" with my premise.');
    expect(documentFile({}).content).not.toContain("ai-instruction");
    expect(documentFile({ aiInstruction: "   " }).content).not.toContain("ai-instruction");
  });

  test("reads hand-written frontmatter and keeps at most 400 characters", () => {
    const source = "---\nmargin-chat-id: \"hand\"\ntitle: \"Hand\"\nai-instruction: Ask me questions, don't answer\n---\n\n# Hand\n\nText.\n";
    const { manifest, files } = discoverMarkdownWorkspace({ "Hand.md": source });
    const parsed = parseMarkdownWorkspace(manifest, files)!;
    expect(Object.values(parsed.conversations).find((item) => item.title === "Hand")?.aiInstruction).toBe("Ask me questions, don't answer");
    expect(normalizeAIInstruction("x".repeat(500))!.length).toBe(400);
    expect(normalizeAIInstruction(42)).toBeNull();
  });

  test("margin notes and side documents follow their nearest parent's instruction", () => {
    const doc = { id: "doc", title: "Doc", aiInstruction: "Question my claims" } as Conversation;
    const side = { id: "side", title: "Side", parentId: "doc" } as Conversation;
    const note = { id: "note", title: "Note", parentId: "side" } as Conversation;
    const own = { id: "own", title: "Own", parentId: "doc", aiInstruction: "Be kind" } as Conversation;
    const conversations = { doc, side, note, own };
    expect(documentAIInstruction(conversations, note)).toBe("Question my claims");
    expect(documentAIInstructionSource(conversations, note)?.document.id).toBe("doc");
    expect(documentAIInstruction(conversations, own)).toBe("Be kind");
    const loop = { a: { id: "a", parentId: "b" } as Conversation, b: { id: "b", parentId: "a" } as Conversation };
    expect(documentAIInstruction(loop, loop.a)).toBeNull();
  });

  test("goes with Ask AI as the user's own words, outside the reference material", () => {
    const { conversation } = documentFile({});
    const prompt = { id: "m", role: "user" as const, content: "Is this right?", createdAt: at };
    const message = buildDocumentAIMessage(conversation as Conversation, prompt, "safe", { instruction: "Question my claims" });
    const reference = message.content.indexOf("{\"title\"");
    const instruction = message.content.indexOf("The user's standing instruction for this document: Question my claims");
    expect(instruction).toBeGreaterThan(reference);
    expect(instruction).toBeLessThan(message.content.indexOf("User request:"));
    expect(buildDocumentAIMessage(conversation as Conversation, prompt).content).not.toContain("standing instruction");
    expect(buildDiagramAIMessage(conversation as Conversation, prompt, { diagram: "flowchart TD\n A-->B" }, "Keep it short").content)
      .toContain("standing instruction for this document: Keep it short");
  });
});
