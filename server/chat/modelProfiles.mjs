import { getRuntimeDefaultModelForService, isBackendModelIdForService, getDefaultModelIdForService } from "../lib/backendModels.mjs";

// Application preferences, not measured rankings. Keep exact IDs in the existing
// supported catalog; provider documentation is evidence of capabilities, not
// evidence of comparative quality on this application's tasks.
export const MODEL_PROFILE_VERSION = "heuristic-2026-09-18.1";
export const PROFILE_EVIDENCE = Object.freeze({
  kind: "heuristic",
  reviewedAt: "2026-09-18",
  sources: [
    "https://developers.openai.com/api/docs/guides/model-selection",
    "https://ai.google.dev/gemini-api/docs/models",
    "https://docs.x.ai/developers/models",
  ],
  limitation: "Task preferences are configurable heuristics; no application benchmark scores are available.",
});

const FAST_MODELS = {
  "openai-api": "gpt-5.6-luna",
  "gemini-api": "gemini-3.1-flash-lite",
  "huggingface-api": "openai/gpt-oss-120b",
  "xai-api": "grok-4.3",
};

export function selectProfileModel(serviceId, { mode, task }, runtimeConfig) {
  let model = getRuntimeDefaultModelForService(runtimeConfig, serviceId);
  if (mode === "fast") model = FAST_MODELS[serviceId] ?? model;
  if (serviceId === "huggingface-api" && mode !== "fast") {
    if (task === "coding") model = "Qwen/Qwen3-Coder-480B-A35B-Instruct";
    if (task === "reasoning") model = "deepseek-ai/DeepSeek-R1";
  }
  if (mode === "balanced" && task === "summary") {
    if (serviceId === "gemini-api") model = "gemini-3.5-flash";
    if (serviceId === "openai-api") model = "gpt-5.6-terra";
  }
  return isBackendModelIdForService(serviceId, model) ? model : getDefaultModelIdForService(serviceId);
}

// Explicit routing preferences rather than fabricated quality scores. The
// configured default breaks ties and controls ordinary conversational requests.
export const TASK_PROVIDER_PREFERENCES = Object.freeze({
  coding: ["openai-api", "huggingface-api", "gemini-api", "xai-api"],
  reasoning: ["openai-api", "huggingface-api", "gemini-api", "xai-api"],
  research: ["gemini-api", "openai-api", "xai-api", "huggingface-api"],
  summary: ["gemini-api", "openai-api", "huggingface-api", "xai-api"],
  writing: ["openai-api", "gemini-api", "xai-api", "huggingface-api"],
});
