const DEFAULT_MODEL_IDS = {
  "backend-services": "smart-routing",
  "gemini-api": "gemini-3.1-pro-preview",
  "huggingface-api": "openai/gpt-oss-120b",
  "openai-api": "gpt-5.4",
  "xai-api": "grok-4.20-beta-latest-non-reasoning",
};

const MODEL_IDS_BY_SERVICE = {
  "backend-services": new Set(["smart-routing"]),
  "gemini-api": new Set([
    "gemini-3.1-pro-preview",
    "gemini-3-flash-preview",
    "gemini-3.1-flash-lite-preview",
  ]),
  "huggingface-api": new Set([
    "openai/gpt-oss-120b",
    "deepseek-ai/DeepSeek-R1",
    "Qwen/Qwen3-Coder-480B-A35B-Instruct",
  ]),
  "openai-api": new Set([
    "gpt-5.4",
    "gpt-5.4-pro",
    "gpt-5-chat-latest",
    "gpt-5.4-mini",
    "gpt-5.4-nano",
  ]),
  "xai-api": new Set([
    "grok-4.20-beta-latest-non-reasoning",
    "grok-4",
    "grok-4-fast",
    "grok-4-fast-non-reasoning",
    "grok-4-1-fast-reasoning",
    "grok-4-1-fast-non-reasoning",
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
  if (serviceId === "openai-api") {
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
