import { afterEach, describe, expect, test } from "bun:test";
import { createChatService } from "../server/chat/index.mjs";
import { chunkDocumentSections } from "../server/documents/chunking.mjs";
import { createDocumentService } from "../server/documents/index.mjs";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function embedding(value = 0.01) {
  return Array.from({ length: 1536 }, () => value);
}

describe("document RAG", () => {
  test("chunks long sections with overlap and stable source metadata", () => {
    const text = Array.from(
      { length: 80 },
      (_, index) => `Paragraph ${index} explains retrieval context in detail.`,
    ).join("\n\n");
    const chunks = chunkDocumentSections(
      [{ content: text, pageNumber: 3 }],
      { chunkCharacters: 500, overlapCharacters: 80 },
    );

    expect(chunks.length).toBeGreaterThan(2);
    expect(chunks.every((chunk) => chunk.pageNumber === 3)).toBe(true);
    expect(chunks.map((chunk) => chunk.index)).toEqual(
      chunks.map((_, index) => index),
    );
    expect(chunks[0].content).toContain("Paragraph 0");
    expect(chunks.at(-1)?.content).toContain("Paragraph 79");
  });

  test("extracts, embeds, and persists an uploaded text document", async () => {
    const calls: Array<Record<string, unknown>> = [];
    let completedArgs: Record<string, unknown> | null = null;
    const database = {
      completeDocument: async (args: Record<string, unknown>) => {
        completedArgs = args;
        return {
          createdAt: "2026-08-20T10:00:00.000Z",
          error: null,
          filename: "policy.md",
          id: "document-1",
          mimeType: "text/markdown",
          sizeBytes: 40,
          status: "ready",
        };
      },
      createDocument: async () => ({ id: "document-1" }),
      deleteDocument: async () => true,
      failDocument: async () => undefined,
    };

    globalThis.fetch = (async (_input, init) => {
      const body = JSON.parse(String(init?.body));
      calls.push(body);
      return Response.json({
        data: body.input.map((_input: string, index: number) => ({
          embedding: embedding(index + 0.01),
          index,
        })),
      });
    }) as typeof fetch;

    const service = createDocumentService({
      database,
      env: { OPENAI_API_KEY: "hosted-key" },
    });
    const result = await service.upload({
      context: { allowHosted: true, apiKeys: {} },
      file: new File(
        ["# Refund policy\n\nCustomers may request a refund within 30 days."],
        "policy.md",
        { type: "text/markdown" },
      ),
      userId: "user-1",
    });

    expect(result.status).toBe("ready");
    expect(calls[0].model).toBe("text-embedding-3-small");
    expect((completedArgs?.chunks as unknown[]).length).toBe(1);
  });

  test("injects retrieved sources into a non-OpenAI provider request", async () => {
    let geminiBody: Record<string, any> | null = null;
    const documentService = {
      retrieveContext: async () => ({
        chunks: [],
        instruction:
          "Relevant excerpts follow.\n\n[Source 1: policy.md]\nRefunds are available for 30 days.",
      }),
    };
    const chatService = createChatService({
      database: {},
      documentService,
      env: { GEMINI_API_KEY: "gemini-key" },
      runtimeConfig: {
        defaultBackendProvider: "gemini-api",
        geminiModel: "gemini-3.1-pro-preview",
        huggingFaceModel: "openai/gpt-oss-120b",
        openaiModel: "gpt-5.6",
        xaiModel: "grok-4.5",
      },
    });

    globalThis.fetch = (async (_input, init) => {
      geminiBody = JSON.parse(String(init?.body));
      return Response.json({
        candidates: [{ content: { parts: [{ text: "Within 30 days [Source 1]." }] } }],
      });
    }) as typeof fetch;

    const response = await chatService.requestReply({
      conversation: {
        ancestorContext: [],
        branchAnchor: null,
        documents: [{ filename: "policy.md", id: "document-1" }],
        id: "conversation-1",
        parentId: null,
        title: "Refunds",
      },
      messages: [{ content: "When can I get a refund?", role: "user" }],
      modelId: "gemini-3.1-pro-preview",
      serviceId: "gemini-api",
    });

    expect(response.reply).toContain("[Source 1]");
    expect(geminiBody?.system_instruction.parts[0].text).toContain(
      "[Source 1: policy.md]",
    );
  });
  test("with All notes as context, adds the best passages from the saved vault, skipping what was already sent", async () => {
    let geminiBody: Record<string, any> | null = null;
    const searches: any[] = [];
    const passageService = {
      available: true,
      search: async (args: any) => {
        searches.push(args);
        return { meaning: true, results: [
          { id: "sent", sourceKind: "conversation", kind: "note", title: "Already sent", heading: null, text: "Sent in the snapshot." },
          { id: "guide", sourceKind: "conversation", kind: "document", title: "Car guide", heading: "Tyres", text: "Rotate the tyres every season.", updatedAt: "2026-10-01T10:00:00.000Z" },
          { id: "file-1", sourceKind: "attachment", kind: "file", title: "Manual.pdf", heading: "Page 4", text: "Pressure is 2.3 bar." },
        ] };
      },
    };
    const chatService = createChatService({
      database: {},
      documentService: { retrieveContext: async () => ({ chunks: [], instruction: null }) },
      passageService,
      env: { GEMINI_API_KEY: "gemini-key" },
      runtimeConfig: {
        defaultBackendProvider: "gemini-api",
        geminiModel: "gemini-3.1-pro-preview",
        huggingFaceModel: "openai/gpt-oss-120b",
        openaiModel: "gpt-5.6",
        xaiModel: "grok-4.5",
      },
    });
    globalThis.fetch = (async (_input, init) => {
      geminiBody = JSON.parse(String(init?.body));
      return Response.json({ candidates: [{ content: { parts: [{ text: "Every season [Vault 1]." }] } }] });
    }) as typeof fetch;

    const payload = (contextScope: string) => ({
      ai: { mode: "balanced", contextScope, selectedConversationIds: [] },
      conversation: { ancestorContext: [], branchAnchor: null, documents: [], id: "conversation-1", parentId: null, title: "Car questions" },
      messages: [{ content: "How often should I rotate my tyres?", role: "user" }],
      workspaceContext: [{ id: "sent", title: "Already sent", updatedAt: "2026-10-01T10:00:00.000Z", content: "Sent in the snapshot.", messages: [] }],
      modelId: "gemini-3.1-pro-preview",
      serviceId: "gemini-api",
    });
    await chatService.requestReply(payload("workspace"), { userId: "u1" });
    const system = geminiBody?.system_instruction.parts[0].text as string;
    expect(searches[0]).toMatchObject({ userId: "u1", query: "How often should I rotate my tyres?" });
    expect(system).toContain("[Vault 1: Car guide › Tyres]\nRotate the tyres every season.");
    expect(system).toContain("[Vault 2: Manual.pdf › Page 4]\nPressure is 2.3 bar.");
    expect(system).not.toContain("[Vault 3");

    // Only when the user chose their whole workspace as context.
    await chatService.requestReply(payload("conversation"), { userId: "u1" });
    expect(searches).toHaveLength(1);
  });
});
