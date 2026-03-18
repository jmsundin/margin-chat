import { getDefaultModelIdForService } from "../lib/backendModels.mjs";

export function createRuntimeConfig(env) {
  const authSessionDays = parsePositiveInteger(env.AUTH_SESSION_DAYS, 30);

  return {
    authSessionTtlMs: authSessionDays * 24 * 60 * 60 * 1000,
    authSessionTtlSeconds: authSessionDays * 24 * 60 * 60,
    defaultBackendProvider: normalizeBackendProvider(
      env.DEFAULT_BACKEND_PROVIDER,
    ),
    geminiModel:
      env.GEMINI_MODEL ?? getDefaultModelIdForService("gemini-api"),
    host: env.HOST ?? "127.0.0.1",
    huggingFaceModel:
      env.HUGGINGFACE_MODEL ??
      env.HF_MODEL ??
      getDefaultModelIdForService("huggingface-api"),
    openaiModel:
      env.OPENAI_MODEL ?? getDefaultModelIdForService("openai-api"),
    secureAuthCookies: parseBoolean(
      env.SECURE_AUTH_COOKIES,
      env.NODE_ENV === "production",
    ),
    xaiModel: env.XAI_MODEL ?? getDefaultModelIdForService("xai-api"),
    port: parsePort(env.PORT ?? env.BACKEND_PORT, 8787),
  };
}

function normalizeBackendProvider(value) {
  if (
    value === "gemini-api" ||
    value === "huggingface-api" ||
    value === "openai-api" ||
    value === "xai-api"
  ) {
    return value;
  }

  return "openai-api";
}

function parsePort(value, fallback) {
  const parsed = Number(value);

  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }

  return fallback;
}

function parseBoolean(value, fallback) {
  if (value === "true") {
    return true;
  }

  if (value === "false") {
    return false;
  }

  return fallback;
}

function parsePositiveInteger(value, fallback) {
  const parsed = Number(value);

  if (Number.isInteger(parsed) && parsed > 0) {
    return parsed;
  }

  return fallback;
}
