const DEFAULT_MODEL_IDS = {
  "backend-services": "smart-routing",
  "gemini-api": "gemini-3.8-flash",
  "huggingface-api": "deepseek-ai/DeepSeek-V4.1-Flash",
  "openai-api": "gpt-6-astra",
  "openai-agent": "gpt-6-astra",
  "xai-api": "grok-4.6",
};

// Include earlier picker IDs so persisted chats remain valid. The client offers
// only the reviewed catalog for new selections; this is a compatibility superset.
const MODEL_IDS_BY_SERVICE = {
  "backend-services": new Set(["smart-routing"]),
  "gemini-api": new Set([
    "gemini-3.8-flash",
    "gemini-3.5-flash-lite",
    "gemini-3.1-pro-preview",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
  ]),
  "huggingface-api": new Set([
    "deepseek-ai/DeepSeek-V4.1-Flash",
    "deepseek-ai/DeepSeek-V4-Pro-0813",
    "Qwen/Qwen3.8-27B",
    "zai-org/GLM-5.3",
    "Qwen/Qwen3.8-2.4T-A95B",
    "MiniMaxAI/MiniMax-M3",
    "moonshotai/Kimi-K3",
    "openai/gpt-oss-120b",
    "deepseek-ai/DeepSeek-R1",
    "Qwen/Qwen3-Coder-480B-A35B-Instruct",
  ]),
  "openai-api": new Set([
    "gpt-6-astra",
    "gpt-5.6",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]),
  "openai-agent": new Set([
    "gpt-6-astra",
    "gpt-5.6",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]),
  "xai-api": new Set([
    "grok-4.6",
    "grok-4.5",
    "grok-4.3",
  ]),
};

export function getDefaultModelIdForService(serviceId) {
  return DEFAULT_MODEL_IDS[serviceId] ?? DEFAULT_MODEL_IDS["backend-services"];
}

export function isBackendModelIdForService(serviceId, modelId) {
  return Boolean(
    typeof modelId === "string" &&
      MODEL_IDS_BY_SERVICE[serviceId]?.has(modelId),
  );
}

export function normalizeBackendModelId(serviceId, modelId) {
  return isBackendModelIdForService(serviceId, modelId)
    ? modelId
    : getDefaultModelIdForService(serviceId);
}

export function getRuntimeDefaultModelForService(runtimeConfig, serviceId) {
  if (serviceId === "openai-api" || serviceId === "openai-agent") {
    return runtimeConfig.openaiModel || getDefaultModelIdForService(serviceId);
  }

  if (serviceId === "gemini-api") {
    return runtimeConfig.geminiModel || getDefaultModelIdForService(serviceId);
  }

  if (serviceId === "huggingface-api") {
    return (
      runtimeConfig.huggingFaceModel || getDefaultModelIdForService(serviceId)
    );
  }

  if (serviceId === "xai-api") {
    return runtimeConfig.xaiModel || getDefaultModelIdForService(serviceId);
  }

  return getDefaultModelIdForService(serviceId);
}
