import { HttpError } from "../lib/errors.mjs";
import { requestOpenAIAgentResponse, requestOpenAIAgentResponseStream } from "./openaiAgent.mjs";
import {
  requestGeminiResponse, requestGeminiResponseStream,
  requestHuggingFaceResponse, requestHuggingFaceResponseStream,
  requestOpenAIResponse, requestOpenAIResponseStream,
  requestXAIResponse, requestXAIResponseStream,
} from "./providers.mjs";
import { buildOpenAIAgentInstruction, buildSystemInstruction } from "./systemPrompt.mjs";
import { buildChatTitleInstruction, sanitizeGeneratedChatTitle, validateChatTitleRequest } from "./title.mjs";
import { validateAIOptions, validateChatRequest } from "./validation.mjs";
import { prepareChatContext } from "./context.mjs";
import { applySemanticRouting, createSemanticRouteCandidates, isProviderAllowed, planRoutes, providerName, routingReasonForAttempt } from "./routing.mjs";
import { PROFILE_EVIDENCE } from "./modelProfiles.mjs";
import { createHostedUsageMeter } from "../billing/usage.mjs";

const PROVIDERS = Object.freeze({
  "openai-agent": { reply: requestOpenAIAgentResponse, stream: requestOpenAIAgentResponseStream },
  "openai-api": { reply: requestOpenAIResponse, stream: requestOpenAIResponseStream },
  "gemini-api": { reply: requestGeminiResponse, stream: requestGeminiResponseStream },
  "huggingface-api": { reply: requestHuggingFaceResponse, stream: requestHuggingFaceResponseStream },
  "xai-api": { reply: requestXAIResponse, stream: requestXAIResponseStream },
});
const PREPAID_BALANCE_REQUIRED = "Your prepaid AI balance is empty. Add money in Billing or subscribe for $20/month to use hosted models. You can also use your own provider API key.";
const SEMANTIC_CONTEXT_LIMIT = 24;
const SEMANTIC_EXCERPT_CHARACTERS = 1_200;

function scopedWorkspaceCandidates(chatRequest) {
  const ai = chatRequest.ai;
  if (ai.contextScope === "conversation") return [];
  const selected = new Set(ai.selectedConversationIds);
  const inherited = new Set([chatRequest.conversation.id, ...(chatRequest.conversation.ancestorContext ?? []).map((item) => item.id)]);
  return (chatRequest.workspaceContext ?? []).filter((item) => !inherited.has(item.id) &&
    (ai.contextScope === "workspace" || selected.has(item.id)));
}

function semanticWorkspaceExcerpt(item) {
  const source = { id: item.id, title: item.title.slice(0, 300), updatedAt: item.updatedAt, messages: [] };
  if (item.content !== undefined) return { ...source, content: item.content.slice(0, SEMANTIC_EXCERPT_CHARACTERS) };
  let remaining = SEMANTIC_EXCERPT_CHARACTERS;
  for (const message of [...item.messages].reverse()) {
    if (message.role === "system" || remaining <= 0) continue;
    const content = message.content.slice(0, remaining);
    source.messages.unshift({ id: message.id, role: message.role, content });
    remaining -= content.length;
  }
  return source;
}

export function createChatService({ database, documentService, env, runtimeConfig, semanticService }) {
  const automaticServicePriority = [...new Set([
    runtimeConfig.defaultBackendProvider, "openai-api", "gemini-api", "huggingface-api", "xai-api",
  ])].filter((id) => PROVIDERS[id] && id !== "openai-agent");

  function getHostedApiKey(serviceId) {
    const provider = providerName(serviceId);
    if (provider === "openai") return env.OPENAI_API_KEY;
    if (provider === "gemini") return env.GEMINI_API_KEY;
    if (provider === "huggingface") return env.HUGGINGFACE_API_KEY ?? env.HF_TOKEN;
    if (provider === "xai") return env.XAI_API_KEY;
    return null;
  }

  function getProviderCredential(serviceId, context = {}) {
    const personal = context.apiKeys?.[providerName(serviceId)];
    if (personal) return { apiKey: personal, source: "personal" };
    const hosted = context.allowHosted === false ? null : getHostedApiKey(serviceId);
    return hosted ? { apiKey: hosted, source: "hosted" } : { apiKey: null, source: null };
  }

  function getRoutes(chatRequest, context) {
    if (chatRequest.serviceId !== "backend-services") {
      if (!isProviderAllowed(chatRequest.serviceId, chatRequest.ai)) {
        throw new HttpError(403, "The selected provider is excluded by your AI provider settings.");
      }
      if (!getProviderCredential(chatRequest.serviceId, context).apiKey) {
        if (context.allowHosted === false && getHostedApiKey(chatRequest.serviceId)) {
          throw new HttpError(402, PREPAID_BALANCE_REQUIRED);
        }
        throw new HttpError(context.allowHosted === false ? 402 : 503,
          "The selected provider has no personal key and hosted access is unavailable.");
      }
      return planRoutes(chatRequest, [chatRequest.serviceId], runtimeConfig);
    }
    const allowed = automaticServicePriority.filter((id) => isProviderAllowed(id, chatRequest.ai));
    const personal = allowed.filter((id) => context.apiKeys?.[providerName(id)]);
    // Keep one billing source for the whole execution. A personal request must
    // never fall through to an unreserved paid hosted request.
    const eligible = personal.length ? personal : allowed.filter((id) => getProviderCredential(id, context).apiKey);
    const routes = planRoutes(chatRequest, eligible, runtimeConfig);
    if (!routes.length && context.allowHosted === false && allowed.some((id) => getHostedApiKey(id))) {
      throw new HttpError(402, PREPAID_BALANCE_REQUIRED);
    }
    if (!routes.length) throw new HttpError(context.allowHosted === false ? 402 : 503,
      "No model provider is available within your AI provider settings. Add an allowed provider key or enable hosted access.");
    return routes;
  }

  async function getDocumentContext(chatRequest, context) {
    context.signal?.throwIfAborted();
    if (!chatRequest.conversation.documents.length) return { chunks: [], instruction: null, sources: [] };
    // Enforce the embedding-provider policy here as well as in documentService,
    // so a replacement retrieval adapter cannot silently send data to OpenAI.
    if (chatRequest.ai.allowedProviders && !chatRequest.ai.allowedProviders.includes("openai")) {
      return { chunks: [], instruction: null, sources: [], warnings: ["Document search was skipped because its embedding provider is not allowed."] };
    }
    if (!documentService) throw new HttpError(503, "Document retrieval is not configured.");
    return documentService.retrieveContext({ chatRequest, context, allowedProviders: chatRequest.ai.allowedProviders });
  }

  async function execute(chatRequest, context, handlers = null, instructionOverride = null) {
    context.signal?.throwIfAborted();
    const startedAt = Date.now();
    let routes = getRoutes(chatRequest, context);
    const budgetOptions = { maxInputCharacters: context.hostedMaxInputCharacters };
    // Validate the latest prompt before starting embedding or provider calls.
    const initialContext = prepareChatContext(chatRequest, {}, budgetOptions);
    let orderedRequest = chatRequest;
    const semanticWarnings = [];
    // Titles and credential preflight remain deterministic. A reply has one
    // semantic pass, shared by every eligible provider attempt.
    if (!instructionOverride && chatRequest.ai.jevEnabled === true) {
      const workspaceCandidates = scopedWorkspaceCandidates(chatRequest);
      const semanticRequest = {
        ...initialContext.chatRequest,
        // Rank excerpts before the final first-fit packing, including candidates
        // the original ordering could not fit. Never expand the selected scope.
        workspaceContext: workspaceCandidates.slice(0, SEMANTIC_CONTEXT_LIMIT).map(semanticWorkspaceExcerpt),
      };
      const candidates = createSemanticRouteCandidates(chatRequest, routes, runtimeConfig);
      let analysis = null;
      try {
        analysis = await semanticService?.analyzeChat({
          chatRequest: semanticRequest, routes: candidates, signal: context.signal, userId: context.userId,
        });
      } catch {
        context.signal?.throwIfAborted();
      }
      context.signal?.throwIfAborted();
      if (!analysis) semanticWarnings.push("Jev is unavailable; used standard context ordering and routing.");
      if (Array.isArray(analysis?.warnings)) {
        semanticWarnings.push(...analysis.warnings.filter((warning) => typeof warning === "string").slice(0, 8).map((warning) => warning.slice(0, 500)));
      }
      routes = applySemanticRouting(chatRequest, routes, runtimeConfig, analysis, candidates);
      const permittedIds = new Set(semanticRequest.workspaceContext.map((item) => item.id));
      const ordering = new Map();
      for (const id of Array.isArray(analysis?.contextOrder) ? analysis.contextOrder : []) {
        if (typeof id === "string" && permittedIds.has(id) && !ordering.has(id)) ordering.set(id, ordering.size);
      }
      if (ordering.size) orderedRequest = {
        ...chatRequest,
        workspaceContext: [...workspaceCandidates].sort((a, b) =>
          (ordering.get(a.id) ?? Number.MAX_SAFE_INTEGER) - (ordering.get(b.id) ?? Number.MAX_SAFE_INTEGER)),
      };
      if (analysis && workspaceCandidates.length > SEMANTIC_CONTEXT_LIMIT) {
        semanticWarnings.push(`Jev considered the first ${SEMANTIC_CONTEXT_LIMIT} permitted workspace sources; other sources retained their original order.`);
      }
    }
    const documentContext = await getDocumentContext(initialContext.chatRequest, context);
    context.signal?.throwIfAborted();
    const prepared = orderedRequest !== chatRequest || documentContext.instruction || documentContext.warnings?.length
      ? prepareChatContext(orderedRequest, documentContext, budgetOptions) : initialContext;
    const fallbacks = [];
    const failures = [];
    for (const route of routes) {
      context.signal?.throwIfAborted();
      const credential = getProviderCredential(route.serviceId, context);
      const receipt = {
        schemaVersion: 1,
        status: "streaming",
        model: route.model,
        provider: route.serviceId,
        mode: route.mode,
        task: route.task,
        reason: routingReasonForAttempt(route, fallbacks),
        routing: route.routing,
        profileVersion: route.profileVersion,
        sources: prepared.sources,
        truncated: prepared.truncated,
        fallbacks: [...fallbacks],
        warnings: [...prepared.warnings, ...semanticWarnings, ...(chatRequest.serviceId === "backend-services" ? [PROFILE_EVIDENCE.limitation] : [])],
      };
      const metadata = {
        credentialSource: credential.source,
        model: route.model,
        requestedModelId: chatRequest.modelId,
        requestedServiceId: chatRequest.serviceId,
        resolvedServiceId: route.serviceId,
        execution: receipt,
      };
      let streamStarted = false;
      const ensureReady = async () => {
        context.signal?.throwIfAborted();
        if (streamStarted) return;
        streamStarted = true;
        await handlers?.onReady?.(metadata);
      };
      const args = {
        apiKey: credential.apiKey,
        chatRequest: prepared.chatRequest,
        database,
        maxOutputTokens: credential.source === "hosted" ? context.hostedMaxOutputTokens : undefined,
        maxInputCharacters: prepared.chatRequest.contextCharacterBudget,
        model: route.model,
        signal: context.signal,
        systemInstruction: instructionOverride ?? (route.serviceId === "openai-agent"
          ? buildOpenAIAgentInstruction(prepared.chatRequest)
          : buildSystemInstruction(prepared.chatRequest)),
        userId: context.userId,
        usageMeter: credential.source === "hosted" ? context.usageMeter : null,
      };
      const inputSize = JSON.stringify({
        instructions: args.systemInstruction,
        messages: prepared.chatRequest.messages.map(({ role, content }) => ({ role, content })),
      }).length;
      if (inputSize > args.maxInputCharacters) {
        throw new HttpError(413, "The prepared conversation exceeds the allowed context budget. Shorten the conversation or select less context.");
      }
      try {
        const provider = PROVIDERS[route.serviceId];
        const result = handlers ? await provider.stream({
          ...args,
          // A provider connection opening alone does not expose a client
          // stream. Once any delta is exposed, retries would corrupt a reply.
          onDelta: async (delta) => { await ensureReady(); await handlers.onDelta?.(delta); },
        }) : await provider.reply(args);
        context.signal?.throwIfAborted();
        if (handlers) await ensureReady();
        const toolTruncated = result.steps?.some((step) => step.output?.truncated || step.output?.conversation?.truncated);
        return {
          metadata: {
            ...metadata,
            model: result.model,
            ...(context.usageMeter ? { billing: context.usageMeter.summary() } : {}),
            execution: {
              ...receipt,
              model: result.model,
              status: "complete",
              truncated: receipt.truncated || Boolean(toolTruncated),
              warnings: toolTruncated ? [...receipt.warnings, "Workspace tool results were shortened to fit the context budget."] : receipt.warnings,
              completedAt: new Date().toISOString(),
              durationMs: Date.now() - startedAt,
            },
          },
          reply: result.reply,
        };
      } catch (error) {
        if (context.signal?.aborted || error?.name === "AbortError" || error?.billingFailure || error?.statusCode === 402 || streamStarted || chatRequest.serviceId !== "backend-services") throw error;
        failures.push(error);
        fallbacks.push({ provider: route.serviceId, model: route.model,
          reason: `Provider request failed${error?.statusCode ? ` (HTTP ${error.statusCode})` : ""} before any response text was delivered.` });
      }
    }
    if (failures.length === 1) throw failures[0];
    throw new HttpError(502, "Automatic routing tried every permitted, configured provider without success.");
  }

  function getPlannedCredentialSource(payload, context = {}) {
    const [route] = getRoutes(validateChatRequest(payload), context);
    return getProviderCredential(route.serviceId, context).source;
  }

  function titleChatRequest(payload) {
    const title = validateChatTitleRequest(payload);
    return {
      ai: validateAIOptions(payload.ai),
      workspaceContext: [],
      conversation: { ancestorContext: [], branchAnchor: null, documents: [], id: "title-generation", parentId: null, title: "New chat" },
      messages: [{ content: title.prompt, createdAt: new Date().toISOString(), id: "title-prompt", role: "user" }],
      modelId: title.modelId,
      serviceId: title.serviceId === "openai-agent" ? "openai-api" : title.serviceId,
    };
  }

  async function generateTitle(payload, context = {}) {
    const result = await execute(titleChatRequest(payload), context, null, buildChatTitleInstruction());
    const generated = sanitizeGeneratedChatTitle(result.reply);
    if (!generated) throw new HttpError(502, "The model returned an empty chat title.");
    return { title: generated, ...(context.usageMeter ? { billing: context.usageMeter.summary() } : {}) };
  }

  function buildHealthPayload(databaseHealth) {
    const services = Object.fromEntries(Object.keys(PROVIDERS).map((serviceId) => [serviceId, {
      configured: Boolean(getHostedApiKey(serviceId)),
      model: serviceId.startsWith("openai") ? runtimeConfig.openaiModel
        : serviceId === "gemini-api" ? runtimeConfig.geminiModel
        : serviceId === "huggingface-api" ? runtimeConfig.huggingFaceModel : runtimeConfig.xaiModel,
    }]));
    const aiConfigured = Object.values(services).some((service) => service.configured);
    services["backend-services"] = { configured: aiConfigured };
    return { defaultBackendProvider: runtimeConfig.defaultBackendProvider, services,
      status: aiConfigured && databaseHealth.ready ? "ok" : "degraded", storage: { postgres: databaseHealth } };
  }

  return {
    buildHealthPayload,
    generateTitle,
    createUsageMeter: (options) => createHostedUsageMeter({ env, ...options }),
    getPlannedTitleCredentialSource: (payload, context = {}) => getProviderCredential(getRoutes(titleChatRequest(payload), context)[0].serviceId, context).source,
    getPlannedCredentialSource,
    requestReply: (payload, context = {}) => execute(validateChatRequest(payload), context),
    requestReplyStream: (payload, context = {}, handlers = {}) => execute(validateChatRequest(payload), context, handlers),
  };
}
