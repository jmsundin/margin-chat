import { describe, expect, test } from "bun:test";
import {
  getBackendServiceOption,
  getDefaultModelIdForService as getClientDefaultModelId,
} from "../client/src/lib/services";
import { createRuntimeConfig } from "../server/config/runtime.mjs";
import {
  getDefaultModelIdForService as getServerDefaultModelId,
  isBackendModelIdForService,
} from "../server/lib/backendModels.mjs";

const EXPECTED_MODELS = {
  "gemini-api": [
    "gemini-3.1-pro-preview",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
  ],
  "huggingface-api": [
    "openai/gpt-oss-120b",
    "moonshotai/Kimi-K3",
    "deepseek-ai/DeepSeek-R1",
    "Qwen/Qwen3-Coder-480B-A35B-Instruct",
  ],
  "openai-api": ["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"],
  "xai-api": ["grok-4.5", "grok-4.3"],
} as const;

describe("provider model catalog", () => {
  for (const [serviceId, modelIds] of Object.entries(EXPECTED_MODELS)) {
    test(`${serviceId} stays aligned between client and server`, () => {
      expect(
        getBackendServiceOption(serviceId as keyof typeof EXPECTED_MODELS)?.models.map(
          ({ id }) => id,
        ),
      ).toEqual(modelIds);
      expect(getClientDefaultModelId(serviceId as keyof typeof EXPECTED_MODELS)).toBe(
        modelIds[0],
      );
      expect(getServerDefaultModelId(serviceId)).toBe(modelIds[0]);

      for (const modelId of modelIds) {
        expect(isBackendModelIdForService(serviceId, modelId)).toBe(true);
      }
    });
  }

  test("stale environment model IDs fall back to current defaults", () => {
    const config = createRuntimeConfig({
      GEMINI_MODEL: "gemini-3.1-flash-lite-preview",
      OPENAI_MODEL: "gpt-5.4",
      XAI_MODEL: "grok-4.20-beta-latest-non-reasoning",
    });

    expect(config.geminiModel).toBe("gemini-3.1-pro-preview");
    expect(config.openaiModel).toBe("gpt-5.6");
    expect(config.xaiModel).toBe("grok-4.5");
  });
});
