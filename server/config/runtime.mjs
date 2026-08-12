import {
  getDefaultModelIdForService,
  normalizeBackendModelId,
} from "../lib/backendModels.mjs";

export function createRuntimeConfig(env) {
  const authSessionDays = parsePositiveInteger(env.AUTH_SESSION_DAYS, 30);
  const passwordResetMinutes = parsePositiveInteger(
    env.PASSWORD_RESET_MINUTES,
    60,
  );

  return {
    authSessionTtlMs: authSessionDays * 24 * 60 * 60 * 1000,
    authSessionTtlSeconds: authSessionDays * 24 * 60 * 60,
    defaultBackendProvider: normalizeBackendProvider(
      env.DEFAULT_BACKEND_PROVIDER,
    ),
    geminiModel: normalizeBackendModelId("gemini-api", env.GEMINI_MODEL),
    host: env.HOST ?? "127.0.0.1",
    huggingFaceModel:
      env.HUGGINGFACE_MODEL ??
      env.HF_MODEL ??
      getDefaultModelIdForService("huggingface-api"),
    openaiModel: normalizeBackendModelId("openai-api", env.OPENAI_MODEL),
    passwordResetTtlMs: passwordResetMinutes * 60 * 1000,
    secureAuthCookies: parseBoolean(
      env.SECURE_AUTH_COOKIES,
      env.NODE_ENV === "production",
    ),
    xaiModel: normalizeBackendModelId("xai-api", env.XAI_MODEL),
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
