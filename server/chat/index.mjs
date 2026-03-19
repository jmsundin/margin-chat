import { HttpError } from "../lib/errors.mjs";
import { getRuntimeDefaultModelForService } from "../lib/backendModels.mjs";
import { requestOpenAIAgentResponse } from "./openaiAgent.mjs";
import {
  requestGeminiResponse,
  requestHuggingFaceResponse,
  requestOpenAIResponse,
  requestXAIResponse,
} from "./providers.mjs";
import {
  buildOpenAIAgentInstruction,
  buildSystemInstruction,
} from "./systemPrompt.mjs";
import { validateChatRequest } from "./validation.mjs";

export function createChatService({ database, env, runtimeConfig }) {
  function getHuggingFaceApiKey() {
    return env.HUGGINGFACE_API_KEY ?? env.HF_TOKEN ?? null;
  }

  function getXaiApiKey() {
    return env.XAI_API_KEY ?? null;
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

    if (requestedServiceId === "openai-agent") {
      if (!env.OPENAI_API_KEY) {
        throw new HttpError(
          503,
          "OpenAI Agent is selected but OPENAI_API_KEY is missing.",
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

    if (requestedServiceId === "xai-api") {
      if (!getXaiApiKey()) {
        throw new HttpError(
          503,
          "xAI API is selected but XAI_API_KEY is missing.",
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

    if (
      runtimeConfig.defaultBackendProvider === "xai-api" &&
      getXaiApiKey()
    ) {
      return "xai-api";
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

    if (getXaiApiKey()) {
      return "xai-api";
    }

    throw new HttpError(
      503,
      "No backend provider is configured. Add OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY, or HUGGINGFACE_API_KEY (or HF_TOKEN).",
    );
  }

  async function requestReply(payload, context = {}) {
    const chatRequest = validateChatRequest(payload);
    const resolvedServiceId = resolveServiceId(chatRequest.serviceId);
    const resolvedModel =
      chatRequest.serviceId === resolvedServiceId
        ? chatRequest.modelId
        : getRuntimeDefaultModelForService(runtimeConfig, resolvedServiceId);
    const systemInstruction =
      resolvedServiceId === "openai-agent"
        ? buildOpenAIAgentInstruction(chatRequest)
        : buildSystemInstruction(chatRequest);
    let result;

    if (resolvedServiceId === "openai-agent") {
      result = await requestOpenAIAgentResponse({
        apiKey: env.OPENAI_API_KEY,
        chatRequest,
        database,
        model: resolvedModel,
        systemInstruction,
        userId: context.userId,
      });
    } else if (resolvedServiceId === "openai-api") {
      result = await requestOpenAIResponse({
        apiKey: env.OPENAI_API_KEY,
        chatRequest,
        model: resolvedModel,
        systemInstruction,
      });
    } else if (resolvedServiceId === "gemini-api") {
      result = await requestGeminiResponse({
        apiKey: env.GEMINI_API_KEY,
        chatRequest,
        model: resolvedModel,
        systemInstruction,
      });
    } else if (resolvedServiceId === "xai-api") {
      result = await requestXAIResponse({
        apiKey: getXaiApiKey(),
        chatRequest,
        model: resolvedModel,
        systemInstruction,
      });
    } else {
      result = await requestHuggingFaceResponse({
        apiKey: getHuggingFaceApiKey(),
        chatRequest,
        model: resolvedModel,
        systemInstruction,
      });
    }

    return {
      metadata: {
        model: result.model,
        requestedModelId: chatRequest.modelId,
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
          env.OPENAI_API_KEY ||
            env.GEMINI_API_KEY ||
            getXaiApiKey() ||
            getHuggingFaceApiKey(),
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
      "openai-agent": {
        configured: Boolean(env.OPENAI_API_KEY),
        model: runtimeConfig.openaiModel,
      },
      "xai-api": {
        configured: Boolean(getXaiApiKey()),
        model: runtimeConfig.xaiModel,
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
