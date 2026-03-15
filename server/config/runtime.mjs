export function createRuntimeConfig(env) {
  return {
    defaultBackendProvider: normalizeBackendProvider(
      env.DEFAULT_BACKEND_PROVIDER,
    ),
    geminiModel: env.GEMINI_MODEL ?? "gemini-2.5-flash",
    host: env.HOST ?? "127.0.0.1",
    huggingFaceModel:
      env.HUGGINGFACE_MODEL ?? env.HF_MODEL ?? "Qwen/Qwen2.5-7B-Instruct",
    openaiModel: env.OPENAI_MODEL ?? "gpt-5-mini",
    port: parsePort(env.PORT ?? env.BACKEND_PORT, 8787),
  };
}

function normalizeBackendProvider(value) {
  if (
    value === "gemini-api" ||
    value === "huggingface-api" ||
    value === "openai-api"
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
