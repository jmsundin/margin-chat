import { HttpError } from "../lib/errors.mjs";
import { getRuntimeDefaultModelForService } from "../lib/backendModels.mjs";
import {
  requestOpenAIAgentResponse,
  requestOpenAIAgentResponseStream,
} from "./openaiAgent.mjs";
import {
  requestGeminiResponse,
  requestGeminiResponseStream,
  requestHuggingFaceResponse,
  requestHuggingFaceResponseStream,
  requestOpenAIResponse,
  requestOpenAIResponseStream,
  requestXAIResponse,
  requestXAIResponseStream,
} from "./providers.mjs";
import {
  buildOpenAIAgentInstruction,
  buildSystemInstruction,
} from "./systemPrompt.mjs";
import {
  buildChatTitleInstruction,
  sanitizeGeneratedChatTitle,
  validateChatTitleRequest,
} from "./title.mjs";
import { validateChatRequest } from "./validation.mjs";

export function createChatService({ database, env, runtimeConfig }) {
  const automaticServicePriority = [
    runtimeConfig.defaultBackendProvider,
    "openai-api",
    "gemini-api",
    "huggingface-api",
    "xai-api",
  ];

  function getHuggingFaceApiKey() {
    return env.HUGGINGFACE_API_KEY ?? env.HF_TOKEN ?? null;
  }

  function getXaiApiKey() {
    return env.XAI_API_KEY ?? null;
  }

  function isServiceConfigured(serviceId) {
    if (serviceId === "openai-api" || serviceId === "openai-agent") {
      return Boolean(env.OPENAI_API_KEY);
    }

    if (serviceId === "gemini-api") {
      return Boolean(env.GEMINI_API_KEY);
    }

    if (serviceId === "huggingface-api") {
      return Boolean(getHuggingFaceApiKey());
    }

    if (serviceId === "xai-api") {
      return Boolean(getXaiApiKey());
    }

    return false;
  }

  function getAutomaticServiceIds() {
    return [...new Set(automaticServicePriority)].filter((serviceId) =>
      isServiceConfigured(serviceId),
    );
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

    return getAutomaticServiceIds()[0] ?? null;
  }

  async function requestProviderReply(
    chatRequest,
    resolvedServiceId,
    context,
    systemInstructionOverride = null,
  ) {
    const resolvedModel =
      chatRequest.serviceId === resolvedServiceId
        ? chatRequest.modelId
        : getRuntimeDefaultModelForService(runtimeConfig, resolvedServiceId);
    const systemInstruction =
      systemInstructionOverride ??
      (resolvedServiceId === "openai-agent"
        ? buildOpenAIAgentInstruction(chatRequest)
        : buildSystemInstruction(chatRequest));
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
      model: result.model,
      reply: result.reply,
      resolvedServiceId,
    };
  }

  async function requestAutomaticReply(
    chatRequest,
    context,
    systemInstructionOverride = null,
  ) {
    const serviceIds = getAutomaticServiceIds();

    if (!serviceIds.length) {
      throw new HttpError(
        503,
        "No backend provider is configured. Add OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY, or HUGGINGFACE_API_KEY (or HF_TOKEN).",
      );
    }

    const failures = [];

    for (const serviceId of serviceIds) {
      try {
        return await requestProviderReply(
          chatRequest,
          serviceId,
          context,
          systemInstructionOverride,
        );
      } catch (error) {
        failures.push({ error, serviceId });
      }
    }

    if (failures.length === 1) {
      throw failures[0].error;
    }

    const failureSummary = failures
      .map(({ error, serviceId }) => `${serviceId}: ${error?.message ?? "request failed"}`)
      .join("; ");

    throw new HttpError(
      502,
      `Automatic routing tried every configured provider without success. ${failureSummary}`,
    );
  }

  async function requestProviderReplyStream(
    chatRequest,
    resolvedServiceId,
    context,
    handlers,
  ) {
    const resolvedModel =
      chatRequest.serviceId === resolvedServiceId
        ? chatRequest.modelId
        : getRuntimeDefaultModelForService(runtimeConfig, resolvedServiceId);
    const systemInstruction =
      resolvedServiceId === "openai-agent"
        ? buildOpenAIAgentInstruction(chatRequest)
        : buildSystemInstruction(chatRequest);
    const streamMetadata = {
      model: resolvedModel,
      requestedModelId: chatRequest.modelId,
      requestedServiceId: chatRequest.serviceId,
      resolvedServiceId,
    };
    let clientStreamReady = false;

    const ensureClientStreamReady = async () => {
      if (clientStreamReady) {
        return;
      }

      clientStreamReady = true;
      await handlers.onReady?.(streamMetadata);
    };
    const providerArgs = {
      chatRequest,
      model: resolvedModel,
      onDelta: async (delta) => {
        await ensureClientStreamReady();
        await handlers.onDelta?.(delta);
      },
      systemInstruction,
    };
    let result;

    if (resolvedServiceId === "openai-agent") {
      result = await requestOpenAIAgentResponseStream({
        ...providerArgs,
        apiKey: env.OPENAI_API_KEY,
        database,
        userId: context.userId,
      });
    } else if (resolvedServiceId === "openai-api") {
      result = await requestOpenAIResponseStream({
        ...providerArgs,
        apiKey: env.OPENAI_API_KEY,
      });
    } else if (resolvedServiceId === "gemini-api") {
      result = await requestGeminiResponseStream({
        ...providerArgs,
        apiKey: env.GEMINI_API_KEY,
      });
    } else if (resolvedServiceId === "xai-api") {
      result = await requestXAIResponseStream({
        ...providerArgs,
        apiKey: getXaiApiKey(),
      });
    } else {
      result = await requestHuggingFaceResponseStream({
        ...providerArgs,
        apiKey: getHuggingFaceApiKey(),
      });
    }

    await ensureClientStreamReady();

    return {
      model: result.model,
      reply: result.reply,
      resolvedServiceId,
    };
  }

  async function requestAutomaticReplyStream(chatRequest, context, handlers) {
    const serviceIds = getAutomaticServiceIds();

    if (!serviceIds.length) {
      throw new HttpError(
        503,
        "No backend provider is configured. Add OPENAI_API_KEY, GEMINI_API_KEY, XAI_API_KEY, or HUGGINGFACE_API_KEY (or HF_TOKEN).",
      );
    }

    const failures = [];

    for (const serviceId of serviceIds) {
      let streamStarted = false;

      try {
        return await requestProviderReplyStream(
          chatRequest,
          serviceId,
          context,
          {
            ...handlers,
            onReady: async (metadata) => {
              streamStarted = true;
              await handlers.onReady?.(metadata);
            },
          },
        );
      } catch (error) {
        if (streamStarted) {
          throw error;
        }

        failures.push({ error, serviceId });
      }
    }

    if (failures.length === 1) {
      throw failures[0].error;
    }

    const failureSummary = failures
      .map(({ error, serviceId }) => `${serviceId}: ${error?.message ?? "request failed"}`)
      .join("; ");

    throw new HttpError(
      502,
      `Automatic routing tried every configured provider without success. ${failureSummary}`,
    );
  }

  async function requestReply(payload, context = {}) {
    const chatRequest = validateChatRequest(payload);
    const result =
      chatRequest.serviceId === "backend-services"
        ? await requestAutomaticReply(chatRequest, context)
        : await requestProviderReply(
            chatRequest,
            resolveServiceId(chatRequest.serviceId),
            context,
          );

    return {
      metadata: {
        model: result.model,
        requestedModelId: chatRequest.modelId,
        requestedServiceId: chatRequest.serviceId,
        resolvedServiceId: result.resolvedServiceId,
      },
      reply: result.reply,
    };
  }

  async function generateTitle(payload, context = {}) {
    const titleRequest = validateChatTitleRequest(payload);
    const titleServiceId =
      titleRequest.serviceId === "openai-agent"
        ? "openai-api"
        : titleRequest.serviceId;
    const chatRequest = {
      conversation: {
        ancestorContext: [],
        branchAnchor: null,
        id: "title-generation",
        parentId: null,
        title: "New chat",
      },
      messages: [
        {
          content: titleRequest.prompt,
          createdAt: new Date().toISOString(),
          id: "title-prompt",
          role: "user",
        },
      ],
      modelId: titleRequest.modelId,
      serviceId: titleServiceId,
    };
    const titleInstruction = buildChatTitleInstruction();
    const result =
      titleServiceId === "backend-services"
        ? await requestAutomaticReply(chatRequest, context, titleInstruction)
        : await requestProviderReply(
            chatRequest,
            resolveServiceId(titleServiceId),
            context,
            titleInstruction,
          );
    const title = sanitizeGeneratedChatTitle(result.reply);

    if (!title) {
      throw new HttpError(502, "The model returned an empty chat title.");
    }

    return { title };
  }

  async function requestReplyStream(payload, context = {}, handlers = {}) {
    const chatRequest = validateChatRequest(payload);
    const result =
      chatRequest.serviceId === "backend-services"
        ? await requestAutomaticReplyStream(chatRequest, context, handlers)
        : await requestProviderReplyStream(
            chatRequest,
            resolveServiceId(chatRequest.serviceId),
            context,
            handlers,
          );

    return {
      metadata: {
        model: result.model,
        requestedModelId: chatRequest.modelId,
        requestedServiceId: chatRequest.serviceId,
        resolvedServiceId: result.resolvedServiceId,
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
    generateTitle,
    requestReply,
    requestReplyStream,
  };
}
