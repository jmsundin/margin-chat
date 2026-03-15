import { HttpError } from "../lib/errors.mjs";
import {
  requestGeminiResponse,
  requestHuggingFaceResponse,
  requestOpenAIResponse,
} from "./providers.mjs";
import { buildSystemInstruction } from "./systemPrompt.mjs";
import { validateChatRequest } from "./validation.mjs";

export function createChatService({ env, runtimeConfig }) {
  function getHuggingFaceApiKey() {
    return env.HUGGINGFACE_API_KEY ?? env.HF_TOKEN ?? null;
  }

  function resolveServiceId(requestedServiceId) {
    if (requestedServiceId === "openai-api") {
      if (!env.OPENAI_API_KEY) {
        throw new HttpError(
          503,
          "OpenAI API is selected but OPENAI_API_KEY is missing.",
        );
      }

      return requestedServiceId;
    }

    if (requestedServiceId === "gemini-api") {
      if (!env.GEMINI_API_KEY) {
        throw new HttpError(
          503,
          "Gemini API is selected but GEMINI_API_KEY is missing.",
        );
      }

      return requestedServiceId;
    }

    if (requestedServiceId === "huggingface-api") {
      if (!getHuggingFaceApiKey()) {
        throw new HttpError(
          503,
          "Hugging Face API is selected but HUGGINGFACE_API_KEY or HF_TOKEN is missing.",
        );
      }

      return requestedServiceId;
    }

    if (
      runtimeConfig.defaultBackendProvider === "gemini-api" &&
      env.GEMINI_API_KEY
    ) {
      return "gemini-api";
    }

    if (
      runtimeConfig.defaultBackendProvider === "openai-api" &&
      env.OPENAI_API_KEY
    ) {
      return "openai-api";
    }

    if (
      runtimeConfig.defaultBackendProvider === "huggingface-api" &&
      getHuggingFaceApiKey()
    ) {
      return "huggingface-api";
    }

    if (env.OPENAI_API_KEY) {
      return "openai-api";
    }

    if (env.GEMINI_API_KEY) {
      return "gemini-api";
    }

    if (getHuggingFaceApiKey()) {
      return "huggingface-api";
    }

    throw new HttpError(
      503,
      "No backend provider is configured. Add OPENAI_API_KEY, GEMINI_API_KEY, or HUGGINGFACE_API_KEY (or HF_TOKEN).",
    );
  }

  async function requestReply(payload) {
    const chatRequest = validateChatRequest(payload);
    const resolvedServiceId = resolveServiceId(chatRequest.serviceId);
    const systemInstruction = buildSystemInstruction(chatRequest);
    let result;

    if (resolvedServiceId === "openai-api") {
      result = await requestOpenAIResponse({
        apiKey: env.OPENAI_API_KEY,
        chatRequest,
        model: runtimeConfig.openaiModel,
        systemInstruction,
      });
    } else if (resolvedServiceId === "gemini-api") {
      result = await requestGeminiResponse({
        apiKey: env.GEMINI_API_KEY,
        chatRequest,
        model: runtimeConfig.geminiModel,
        systemInstruction,
      });
    } else {
      result = await requestHuggingFaceResponse({
        apiKey: getHuggingFaceApiKey(),
        chatRequest,
        model: runtimeConfig.huggingFaceModel,
        systemInstruction,
      });
    }

    return {
      metadata: {
        model: result.model,
        requestedServiceId: chatRequest.serviceId,
        resolvedServiceId,
      },
      reply: result.reply,
    };
  }

  function buildHealthPayload(databaseHealth) {
    const services = {
      "backend-services": {
        configured: Boolean(
          env.OPENAI_API_KEY || env.GEMINI_API_KEY || getHuggingFaceApiKey(),
        ),
      },
      "gemini-api": {
        configured: Boolean(env.GEMINI_API_KEY),
        model: runtimeConfig.geminiModel,
      },
      "huggingface-api": {
        configured: Boolean(getHuggingFaceApiKey()),
        model: runtimeConfig.huggingFaceModel,
      },
      "openai-api": {
        configured: Boolean(env.OPENAI_API_KEY),
        model: runtimeConfig.openaiModel,
      },
    };
    const aiConfigured = services["backend-services"].configured;

    return {
      defaultBackendProvider: runtimeConfig.defaultBackendProvider,
      services,
      status: aiConfigured && databaseHealth.ready ? "ok" : "degraded",
      storage: {
        postgres: databaseHealth,
      },
    };
  }

  return {
    buildHealthPayload,
    requestReply,
  };
}
