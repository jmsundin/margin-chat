const DEFAULT_MODEL_IDS = {
  "backend-services": "smart-routing",
  "gemini-api": "gemini-3.1-pro-preview",
  "huggingface-api": "openai/gpt-oss-120b",
  "openai-api": "gpt-5.6",
  "openai-agent": "gpt-5.6",
  "xai-api": "grok-4.5",
};

const MODEL_IDS_BY_SERVICE = {
  "backend-services": new Set(["smart-routing"]),
  "gemini-api": new Set([
    "gemini-3.1-pro-preview",
    "gemini-3.5-flash",
    "gemini-3.1-flash-lite",
  ]),
  "huggingface-api": new Set([
    "moonshotai/Kimi-K3",
    "openai/gpt-oss-120b",
    "deepseek-ai/DeepSeek-R1",
    "Qwen/Qwen3-Coder-480B-A35B-Instruct",
  ]),
  "openai-api": new Set([
    "gpt-5.6",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]),
  "openai-agent": new Set([
    "gpt-5.6",
    "gpt-5.6-terra",
    "gpt-5.6-luna",
  ]),
  "xai-api": new Set([
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
