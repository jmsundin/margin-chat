import { afterEach, describe, expect, test } from "bun:test";
import { createChatService } from "../server/chat/index.mjs";
import {
  DOCUMENT_TITLE_MODEL_ID,
  sanitizeGeneratedChatTitle,
  validateChatTitleRequest,
} from "../server/chat/title.mjs";
import { createEmptyState } from "../client/src/initialState";
import { getDocumentTitleSource, getSelectionDocumentTitleSource } from "../client/src/lib/documentTitle";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createService() {
  return createChatService({
    database: {},
    env: { GEMINI_API_KEY: "gemini-test-key", OPENAI_API_KEY: "openai-test-key" },
    runtimeConfig: {
      defaultBackendProvider: "gemini-api",
      geminiModel: "gemini-3.1-pro-preview",
      huggingFaceModel: "openai/gpt-oss-120b",
      openaiModel: "gpt-5.6",
      xaiModel: "grok-4.5",
    },
  });
}

describe("semantic chat titles", () => {
  test("generates and sanitizes a title with the selected provider", async () => {
    let requestBody: Record<string, any> | null = null;

    globalThis.fetch = (async (_input, init) => {
      requestBody = JSON.parse(String(init?.body));

      return Response.json({
        candidates: [
          { content: { parts: [{ text: '**"Postgres Hosting Tradeoffs."**\nExtra' }] } },
        ],
      });
    }) as typeof fetch;

    const result = await createService().generateTitle({
      modelId: "gemini-3.1-pro-preview",
      prompt: "Should I use Neon or host Postgres myself for this application?",
      serviceId: "gemini-api",
    });

    expect(result.title).toBe("Postgres Hosting Tradeoffs");
    expect(requestBody?.system_instruction.parts[0].text).toContain(
      "main topic, goal, or decision",
    );
    expect(requestBody?.contents[0].parts[0].text).toContain("Neon");
  });

  test("normalizes common model formatting and caps long titles", () => {
    expect(sanitizeGeneratedChatTitle("## Title: `API Reliability Plan!`"))
      .toBe("API Reliability Plan");
    expect(sanitizeGeneratedChatTitle("word ".repeat(30))).toHaveLength(79);
  });

  test("rejects unsupported models and oversized prompts", () => {
    expect(() =>
      validateChatTitleRequest({
        modelId: "not-a-model",
        prompt: "Valid prompt",
        serviceId: "gemini-api",
      }),
    ).toThrow("supported model");

    expect(() =>
      validateChatTitleRequest({
        modelId: "gemini-3.1-pro-preview",
        prompt: "x".repeat(8_001),
        serviceId: "gemini-api",
      }),
    ).toThrow("8,000 characters or fewer");
  });
});

describe("document titles", () => {
  test("always use OpenAI Luna with document instructions", async () => {
    let url = "";
    let requestBody: Record<string, any> | null = null;

    globalThis.fetch = (async (input, init) => {
      url = String(input);
      requestBody = JSON.parse(String(init?.body));
      return Response.json({ output_text: "Quarterly Hiring Plan" });
    }) as typeof fetch;

    const result = await createService().generateTitle({
      kind: "document",
      modelId: "gemini-3.1-pro-preview",
      prompt: "We plan to hire two engineers and a designer next quarter.",
      serviceId: "gemini-api",
    });

    expect(DOCUMENT_TITLE_MODEL_ID).toBe("gpt-6-luna");
    expect(result.title).toBe("Quarterly Hiring Plan");
    expect(url).toBe("https://api.openai.com/v1/responses");
    expect(requestBody?.model).toBe("gpt-6-luna");
    expect(JSON.stringify(requestBody)).toContain("title for a document from its content");
  });

  test("only titles documents with a placeholder title and enough content", () => {
    const state = createEmptyState();
    const base = state.conversations[state.rootId];
    const content = "Notes on migrating the billing service to Postgres. ".repeat(5);
    const withContent = (title: string, text = content) => ({
      ...base,
      title,
      document: {
        schemaVersion: 1 as const,
        blocks: [{ id: "a", kind: "markdown" as const, content: text, createdAt: base.createdAt, updatedAt: base.createdAt }],
        prompts: [],
        generations: [],
      },
    });

    expect(getDocumentTitleSource(withContent("Untitled document"))).toContain("billing service");
    expect(getDocumentTitleSource(withContent(""))).toContain("billing service");
    expect(getDocumentTitleSource(withContent("My billing notes"))).toBeNull();
    expect(getDocumentTitleSource(withContent("Untitled document", "Too short"))).toBeNull();
    expect(getDocumentTitleSource(withContent("Untitled document", "x".repeat(9_000)))).toHaveLength(6_000);
  });
});

describe("titles for documents created from a selection", () => {
  test("prefers the generated document and keeps the selection for context", () => {
    expect(
      getSelectionDocumentTitleSource({
        output: "Neon  separates\nstorage from compute.",
        prompt: "Explain the selected text.",
        quote: "serverless Postgres",
      }),
    ).toBe("Selected text: serverless Postgres\nDocument: Neon separates storage from compute.");
  });

  test("falls back to the selection and request before any output exists", () => {
    expect(
      getSelectionDocumentTitleSource({ prompt: "Explain the selected text.", quote: "serverless Postgres" }),
    ).toBe("Selected text: serverless Postgres\nRequest: Explain the selected text.");
    expect(getSelectionDocumentTitleSource({ prompt: "  ", quote: "" })).toBeNull();
  });
});
