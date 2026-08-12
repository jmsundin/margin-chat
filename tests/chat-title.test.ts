import { afterEach, describe, expect, test } from "bun:test";
import { createChatService } from "../server/chat/index.mjs";
import {
  sanitizeGeneratedChatTitle,
  validateChatTitleRequest,
} from "../server/chat/title.mjs";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createService() {
  return createChatService({
    database: {},
    env: { GEMINI_API_KEY: "gemini-test-key" },
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
