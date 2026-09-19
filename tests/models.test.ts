import { describe, expect, test } from "bun:test";
import {
  getBackendServiceOption,
  getBackendServiceModelLabel,
  getDefaultModelIdForService as getClientDefaultModelId,
  resolveBackendServiceModelId,
} from "../client/src/lib/services";
import { createRuntimeConfig } from "../server/config/runtime.mjs";
import {
  getDefaultModelIdForService as getServerDefaultModelId,
  isBackendModelIdForService,
} from "../server/lib/backendModels.mjs";

const EXPECTED_MODELS = {
  "gemini-api": [
    "gemini-3.8-flash",
    "gemini-3.1-pro-preview",
    "gemini-3.5-flash-lite",
  ],
  "huggingface-api": [
    "deepseek-ai/DeepSeek-V4.1-Flash",
    "deepseek-ai/DeepSeek-V4-Pro-0813",
    "Qwen/Qwen3.8-27B",
    "zai-org/GLM-5.3",
    "moonshotai/Kimi-K3",
    "Qwen/Qwen3.8-2.4T-A95B",
    "MiniMaxAI/MiniMax-M3",
  ],
  "openai-api": ["gpt-6-astra", "gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"],
  "openai-agent": ["gpt-6-astra", "gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"],
  "xai-api": ["grok-4.6", "grok-4.3"],
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

    expect(config.geminiModel).toBe("gemini-3.8-flash");
    expect(config.openaiModel).toBe("gpt-6-astra");
    expect(config.xaiModel).toBe("grok-4.6");
  });

  test("runtime defaults match the refreshed catalog", () => {
    const config = createRuntimeConfig({});
    expect(config.openaiModel).toBe(getServerDefaultModelId("openai-api"));
    expect(config.geminiModel).toBe(getServerDefaultModelId("gemini-api"));
    expect(config.huggingFaceModel).toBe(getServerDefaultModelId("huggingface-api"));
    expect(config.xaiModel).toBe(getServerDefaultModelId("xai-api"));
  });

  test("earlier selections keep their exact IDs and labels without crowding the catalog", () => {
    const previousSelections = [
      ["gemini-api", "gemini-3.5-flash", "Gemini 3.5 Flash"],
      ["gemini-api", "gemini-3.1-flash-lite", "Gemini 3.1 Flash-Lite"],
      ["huggingface-api", "openai/gpt-oss-120b", "gpt-oss-120b"],
      ["huggingface-api", "deepseek-ai/DeepSeek-R1", "DeepSeek R1"],
      ["huggingface-api", "Qwen/Qwen3-Coder-480B-A35B-Instruct", "Qwen3 Coder 480B"],
      ["xai-api", "grok-4.5", "Grok 4.5"],
    ] as const;
    for (const [serviceId, modelId, label] of previousSelections) {
      expect(isBackendModelIdForService(serviceId, modelId)).toBe(true);
      expect(resolveBackendServiceModelId(serviceId, modelId)).toBe(modelId);
      expect(getBackendServiceModelLabel(serviceId, modelId)).toBe(label);
      expect(getBackendServiceOption(serviceId)?.models.some(({ id }) => id === modelId)).toBe(false);
    }
  });

  test("models from another provider and unknown IDs are still rejected", () => {
    expect(isBackendModelIdForService("gemini-api", "gpt-6-astra")).toBe(false);
    expect(isBackendModelIdForService("huggingface-api", "unknown/model")).toBe(false);
    expect(resolveBackendServiceModelId("openai-api", "unknown-model")).toBe("gpt-6-astra");
  });
});
