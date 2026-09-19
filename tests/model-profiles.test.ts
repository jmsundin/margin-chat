import { describe, expect, test } from "bun:test";
import { getDefaultModelIdForService, isBackendModelIdForService } from "../server/lib/backendModels.mjs";
import { selectProfileModel } from "../server/chat/modelProfiles.mjs";
import { createSemanticRouteCandidates, planRoutes, TASK_CATEGORIES } from "../server/chat/routing.mjs";

const services = ["openai-api", "gemini-api", "huggingface-api", "xai-api"];

function request(mode = "balanced", content = "Help me with this.") {
  return {
    serviceId: "backend-services",
    modelId: "smart-routing",
    messages: [{ role: "user", content }],
    ai: { mode },
  };
}

describe("current automatic model profiles", () => {
  test("every planned and semantic route uses a model in the supported catalog", () => {
    for (const mode of ["fast", "balanced", "thorough"]) {
      for (const task of TASK_CATEGORIES) {
        const chatRequest = request(mode);
        const routes = planRoutes(chatRequest, services, {}, { task });
        expect(routes).toHaveLength(services.length);
        const candidates = createSemanticRouteCandidates(chatRequest, routes, {});
        for (const route of [...routes, ...candidates]) {
          expect(isBackendModelIdForService(route.serviceId, route.model)).toBe(true);
        }
      }
    }
  });

  test("balanced general requests use the refreshed provider defaults", () => {
    const routes = planRoutes(request(), services, {});
    expect(routes.map(({ serviceId, model }: any) => [serviceId, model])).toEqual([
      ["openai-api", "gpt-6-astra"],
      ["gemini-api", "gemini-3.8-flash"],
      ["huggingface-api", "deepseek-ai/DeepSeek-V4.1-Flash"],
      ["xai-api", "grok-4.6"],
    ]);
  });

  test("fast mode keeps fast variants even for coding and reasoning requests", () => {
    for (const task of ["general", "coding", "reasoning"]) {
      const models = services.map((serviceId) => selectProfileModel(serviceId, { mode: "fast", task }, {}));
      expect(models).toEqual(["gpt-5.6-luna", "gemini-3.5-flash-lite", "Qwen/Qwen3.8-27B", "grok-4.3"]);
    }
  });

  test("specialized requests select current coding, reasoning, and summary models", () => {
    for (const mode of ["balanced", "thorough"]) {
      expect(selectProfileModel("huggingface-api", { mode, task: "coding" }, {})).toBe("zai-org/GLM-5.3");
      expect(selectProfileModel("huggingface-api", { mode, task: "reasoning" }, {})).toBe("deepseek-ai/DeepSeek-V4-Pro-0813");
      expect(selectProfileModel("gemini-api", { mode, task: "reasoning" }, {})).toBe("gemini-3.1-pro-preview");
    }
    expect(selectProfileModel("gemini-api", { mode: "thorough", task: "research" }, {})).toBe("gemini-3.1-pro-preview");
    expect(selectProfileModel("gemini-api", { mode: "balanced", task: "summary" }, {})).toBe("gemini-3.8-flash");
  });

  test("retains supported runtime defaults for ordinary requests and repairs stale defaults", () => {
    const configured = { openaiModel: "gpt-5.6-terra", geminiModel: "gemini-3.5-flash-lite", huggingFaceModel: "openai/gpt-oss-120b", xaiModel: "grok-4.3" };
    expect(planRoutes(request(), services, configured).map(({ model }: any) => model)).toEqual([
      "gpt-5.6-terra", "gemini-3.5-flash-lite", "openai/gpt-oss-120b", "grok-4.3",
    ]);
    const stale = { openaiModel: "retired", geminiModel: "retired", huggingFaceModel: "retired", xaiModel: "retired" };
    for (const serviceId of services) {
      expect(selectProfileModel(serviceId, { mode: "balanced", task: "general" }, stale)).toBe(getDefaultModelIdForService(serviceId));
    }
  });

  test("explicit selections remain exact even when fast mode or task preferences differ", () => {
    const manual = { ...request("fast", "Debug this code."), serviceId: "openai-api", modelId: "gpt-6-astra" };
    expect(planRoutes(manual, services, {})).toEqual([
      expect.objectContaining({ serviceId: "openai-api", model: "gpt-6-astra", mode: "fast", task: "coding" }),
    ]);
    expect(createSemanticRouteCandidates(manual, planRoutes(manual, services, {}), {})).toEqual([]);
  });
});
