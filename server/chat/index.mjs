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

  function getPersonalApiKey(serviceId, context = {}) {
    if (serviceId === "openai-api" || serviceId === "openai-agent") {
      return context.apiKeys?.openai ?? null;
    }

    if (serviceId === "gemini-api") {
      return context.apiKeys?.gemini ?? null;
    }

    if (serviceId === "huggingface-api") {
      return context.apiKeys?.huggingface ?? null;
    }

    if (serviceId === "xai-api") {
      return context.apiKeys?.xai ?? null;
    }

    return null;
  }

  function getHostedApiKey(serviceId) {
    if (serviceId === "openai-api" || serviceId === "openai-agent") {
      return env.OPENAI_API_KEY ?? null;
    }

    if (serviceId === "gemini-api") {
      return env.GEMINI_API_KEY ?? null;
    }

    if (serviceId === "huggingface-api") {
      return getHuggingFaceApiKey();
    }

    if (serviceId === "xai-api") {
      return getXaiApiKey();
    }

    return null;
  }

  function getProviderCredential(serviceId, context = {}) {
    const personalApiKey = getPersonalApiKey(serviceId, context);

    if (personalApiKey) {
      return { apiKey: personalApiKey, source: "personal" };
    }

    const hostedApiKey =
      context.allowHosted === false ? null : getHostedApiKey(serviceId);

    return hostedApiKey
      ? { apiKey: hostedApiKey, source: "hosted" }
      : { apiKey: null, source: null };
  }

  function isServiceConfigured(serviceId, context = {}) {
    return Boolean(getProviderCredential(serviceId, context).apiKey);
  }

  function getAutomaticServiceIds(context = {}) {
    const serviceIds = [...new Set(automaticServicePriority)];
    const personalServiceIds = serviceIds.filter((serviceId) =>
      Boolean(getPersonalApiKey(serviceId, context)),
    );

    if (personalServiceIds.length) {
      return personalServiceIds;
    }

    return serviceIds.filter((serviceId) =>
      isServiceConfigured(serviceId, context),
    );
  }

  function resolveServiceId(requestedServiceId, context = {}) {
    if (
      requestedServiceId !== "backend-services" &&
      !isServiceConfigured(requestedServiceId, context)
    ) {
      const providerLabel =
        requestedServiceId === "openai-agent"
          ? "OpenAI Agent"
          : requestedServiceId === "openai-api"
            ? "OpenAI"
            : requestedServiceId === "gemini-api"
              ? "Gemini"
              : requestedServiceId === "huggingface-api"
                ? "Hugging Face"
                : "xAI";

      throw new HttpError(
        context.allowHosted === false ? 402 : 503,
        `${providerLabel} is selected, but no personal key is saved and hosted access is unavailable.`,
      );
    }

    if (requestedServiceId !== "backend-services") {
      return requestedServiceId;
    }

    return getAutomaticServiceIds(context)[0] ?? null;
  }

  async function requestProviderReply(
    chatRequest,
    resolvedServiceId,
    context,
    systemInstructionOverride = null,
  ) {
    const credential = getProviderCredential(resolvedServiceId, context);
    const maxOutputTokens =
      credential.source === "hosted" ? context.hostedMaxOutputTokens : undefined;
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
        apiKey: credential.apiKey,
        chatRequest,
        database,
        maxOutputTokens,
        model: resolvedModel,
        systemInstruction,
        userId: context.userId,
      });
    } else if (resolvedServiceId === "openai-api") {
      result = await requestOpenAIResponse({
        apiKey: credential.apiKey,
        chatRequest,
        maxOutputTokens,
        model: resolvedModel,
        systemInstruction,
      });
    } else if (resolvedServiceId === "gemini-api") {
      result = await requestGeminiResponse({
        apiKey: credential.apiKey,
        chatRequest,
        maxOutputTokens,
        model: resolvedModel,
        systemInstruction,
      });
    } else if (resolvedServiceId === "xai-api") {
      result = await requestXAIResponse({
        apiKey: credential.apiKey,
        chatRequest,
        maxOutputTokens,
        model: resolvedModel,
        systemInstruction,
      });
    } else {
      result = await requestHuggingFaceResponse({
        apiKey: credential.apiKey,
        chatRequest,
        maxOutputTokens,
        model: resolvedModel,
        systemInstruction,
      });
    }

    return {
      model: result.model,
      reply: result.reply,
      resolvedServiceId,
      credentialSource: credential.source,
    };
  }

  async function requestAutomaticReply(
    chatRequest,
    context,
    systemInstructionOverride = null,
  ) {
    const serviceIds = getAutomaticServiceIds(context);

    if (!serviceIds.length) {
      throw new HttpError(
        context.allowHosted === false ? 402 : 503,
        context.allowHosted === false
          ? "Hosted access is unavailable. Add a personal API key in Profile settings or use Stripe billing."
          : "No backend provider is configured. Add a provider API key.",
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
    const credential = getProviderCredential(resolvedServiceId, context);
    const maxOutputTokens =
      credential.source === "hosted" ? context.hostedMaxOutputTokens : undefined;
    const resolvedModel =
      chatRequest.serviceId === resolvedServiceId
        ? chatRequest.modelId
        : getRuntimeDefaultModelForService(runtimeConfig, resolvedServiceId);
    const systemInstruction =
      resolvedServiceId === "openai-agent"
        ? buildOpenAIAgentInstruction(chatRequest)
        : buildSystemInstruction(chatRequest);
    const streamMetadata = {
      credentialSource: credential.source,
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
      maxOutputTokens,
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
        apiKey: credential.apiKey,
        database,
        userId: context.userId,
      });
    } else if (resolvedServiceId === "openai-api") {
      result = await requestOpenAIResponseStream({
        ...providerArgs,
        apiKey: credential.apiKey,
      });
    } else if (resolvedServiceId === "gemini-api") {
      result = await requestGeminiResponseStream({
        ...providerArgs,
        apiKey: credential.apiKey,
      });
    } else if (resolvedServiceId === "xai-api") {
      result = await requestXAIResponseStream({
        ...providerArgs,
        apiKey: credential.apiKey,
      });
    } else {
      result = await requestHuggingFaceResponseStream({
        ...providerArgs,
        apiKey: credential.apiKey,
      });
    }

    await ensureClientStreamReady();

    return {
      model: result.model,
      reply: result.reply,
      resolvedServiceId,
      credentialSource: credential.source,
    };
  }

  async function requestAutomaticReplyStream(chatRequest, context, handlers) {
    const serviceIds = getAutomaticServiceIds(context);

    if (!serviceIds.length) {
      throw new HttpError(
        context.allowHosted === false ? 402 : 503,
        context.allowHosted === false
          ? "Hosted access is unavailable. Add a personal API key in Profile settings or use Stripe billing."
          : "No backend provider is configured. Add a provider API key.",
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
            resolveServiceId(chatRequest.serviceId, context),
            context,
          );

    return {
      metadata: {
        credentialSource: result.credentialSource,
        model: result.model,
        requestedModelId: chatRequest.modelId,
        requestedServiceId: chatRequest.serviceId,
        resolvedServiceId: result.resolvedServiceId,
      },
      reply: result.reply,
    };
  }

  function getPlannedCredentialSource(payload, context = {}) {
    const chatRequest = validateChatRequest(payload);
    const resolvedServiceId =
      chatRequest.serviceId === "backend-services"
        ? getAutomaticServiceIds(context)[0] ?? null
        : resolveServiceId(chatRequest.serviceId, context);

    if (!resolvedServiceId) {
      throw new HttpError(
        context.allowHosted === false ? 402 : 503,
        "No model provider is available for this request.",
      );
    }

    return getProviderCredential(resolvedServiceId, context).source;
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
            resolveServiceId(titleServiceId, context),
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
            resolveServiceId(chatRequest.serviceId, context),
            context,
            handlers,
          );

    return {
      metadata: {
        credentialSource: result.credentialSource,
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
    getPlannedCredentialSource,
    requestReply,
    requestReplyStream,
  };
}
