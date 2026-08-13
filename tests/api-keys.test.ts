import { afterEach, describe, expect, test } from "bun:test";
import { decryptSecret, encryptSecret } from "../server/apiKeys/crypto.mjs";
import { createChatService } from "../server/chat/index.mjs";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createPayload(serviceId: "backend-services" | "openai-api") {
  return {
    conversation: {
      ancestorContext: [],
      branchAnchor: null,
      id: "conversation-1",
      parentId: null,
      title: "API key test",
    },
    messages: [{ content: "Reply with OK.", role: "user" }],
    modelId: serviceId === "backend-services" ? "smart-routing" : "gpt-5.6",
    serviceId,
  };
}

function createService() {
  return createChatService({
    database: {},
    env: { OPENAI_API_KEY: "hosted-openai-key" },
    runtimeConfig: {
      defaultBackendProvider: "openai-api",
      geminiModel: "gemini-3.1-pro-preview",
      huggingFaceModel: "openai/gpt-oss-120b",
      openaiModel: "gpt-5.6",
      xaiModel: "grok-4.5",
    },
  });
}

describe("personal provider API keys", () => {
  test("encrypts API keys with authenticated encryption", () => {
    const env = {
      API_KEY_ENCRYPTION_KEY: Buffer.alloc(32, 7).toString("base64"),
    };
    const encrypted = encryptSecret("sk-user-secret", env);

    expect(encrypted).not.toContain("sk-user-secret");
    expect(decryptSecret(encrypted, env)).toBe("sk-user-secret");
  });

  test("prefers a personal key and blocks hosted keys without billing access", async () => {
    const authorizationHeaders: string[] = [];

    globalThis.fetch = (async (
      _input: string | URL | Request,
      init?: RequestInit,
    ) => {
      authorizationHeaders.push(
        String(new Headers(init?.headers).get("Authorization")),
      );
      return Response.json({ model: "gpt-5.6", output_text: "OK" });
    }) as typeof fetch;

    const service = createService();
    const personalReply = await service.requestReply(createPayload("openai-api"), {
      allowHosted: true,
      apiKeys: { openai: "personal-openai-key" },
    });

    expect(personalReply.metadata.credentialSource).toBe("personal");
    expect(authorizationHeaders[0]).toBe("Bearer personal-openai-key");

    await expect(
      service.requestReply(createPayload("openai-api"), {
        allowHosted: false,
        apiKeys: {},
      }),
    ).rejects.toMatchObject({ statusCode: 402 });
    expect(authorizationHeaders).toHaveLength(1);
  });

  test("automatic routing stays on personal providers when any are saved", () => {
    const service = createService();

    expect(
      service.getPlannedCredentialSource(createPayload("backend-services"), {
        allowHosted: true,
        apiKeys: { gemini: "personal-gemini-key" },
      }),
    ).toBe("personal");
  });
});
