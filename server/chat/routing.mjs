import { MODEL_PROFILE_VERSION, selectProfileModel, TASK_PROVIDER_PREFERENCES } from "./modelProfiles.mjs";
import { getModelRoutingEvidence } from "./modelRoutingEvidence.mjs";

const PROVIDER_LABELS = { "openai-api": "OpenAI", "openai-agent": "OpenAI Agent", "gemini-api": "Gemini", "huggingface-api": "Hugging Face", "xai-api": "xAI" };
const MODE_TRADEOFFS = {
  fast: "Fast mode favors the configured fast variant and a smaller context allowance.",
  balanced: "Balanced mode uses the configured default or task profile.",
  thorough: "Thorough mode allows more context and asks for closer examination of tradeoffs.",
};
export const TASK_CATEGORIES = Object.freeze(["general", "coding", "reasoning", "research", "writing", "summary"]);

export function providerName(serviceId) {
  return serviceId === "openai-agent" ? "openai" : serviceId.replace(/-api$/, "");
}

export function isProviderAllowed(serviceId, ai) {
  return ai?.allowedProviders === undefined || ai.allowedProviders.includes(providerName(serviceId));
}

export function classifyTask(chatRequest) {
  const text = [...chatRequest.messages].reverse().find((message) => message.role === "user")?.content ?? "";
  if (/\b(summarize|summarise|summary|tl;?dr|condense)\b/i.test(text)) return "summary";
  if (/```|\b(code|coding|debug|refactor|javascript|typescript|python|compiler|stacktrace|sql|unit tests?)\b/i.test(text)) return "coding";
  if (/\b(prove|proof|derive|equation|mathematical|calculate|solve|logic puzzle)\b/i.test(text)) return "reasoning";
  if (/\b(research|sources?|citations?|compare|investigate|literature)\b/i.test(text)) return "research";
  if (/\b(write|rewrite|draft|email|story|copywriting|edit|polish)\b/i.test(text)) return "writing";
  return "general";
}

export function planRoutes(chatRequest, eligibleServiceIds, runtimeConfig, { task: requestedTask } = {}) {
  const mode = chatRequest.ai?.mode ?? "balanced";
  const task = TASK_CATEGORIES.includes(requestedTask) ? requestedTask : classifyTask(chatRequest);
  const automatic = chatRequest.serviceId === "backend-services";
  const preferences = TASK_PROVIDER_PREFERENCES[task] ?? eligibleServiceIds;
  const serviceIds = automatic
    ? [...eligibleServiceIds].sort((a, b) => preferences.indexOf(a) - preferences.indexOf(b))
    : [chatRequest.serviceId];
  return serviceIds.filter((serviceId) => isProviderAllowed(serviceId, chatRequest.ai)).map((serviceId) => {
    const model = automatic ? selectProfileModel(serviceId, { mode, task }, runtimeConfig) : chatRequest.modelId;
    const policy = task === "general" ? "the configured provider priority" : `the ${task} provider preference order`;
    return {
      serviceId,
      model,
      mode,
      task,
      routing: { method: automatic ? "rules" : "manual", selectedModel: model },
      profileVersion: MODEL_PROFILE_VERSION,
      reason: automatic
        ? `Routing rules selected ${PROVIDER_LABELS[serviceId]} (${model}) for ${task} using ${policy}. ${MODE_TRADEOFFS[mode]} These heuristic preferences consider only allowed providers with an available key.`
        : "Used your selected provider and model.",
    };
  });
}

/** Semantic routing can only choose models from the already eligible credential pool. */
export function createSemanticRouteCandidates(chatRequest, routes, runtimeConfig) {
  if (chatRequest.serviceId !== "backend-services") return [];
  const candidates = new Map();
  for (const route of routes) {
    for (const task of TASK_CATEGORIES) {
      const model = selectProfileModel(route.serviceId, { mode: route.mode, task }, runtimeConfig);
      const key = `${route.serviceId}:${model}`;
      if (!candidates.has(key)) candidates.set(key, {
        key, serviceId: route.serviceId, model, mode: route.mode, tasks: [],
        description: `${PROVIDER_LABELS[route.serviceId]} ${model}; ${getModelRoutingEvidence(route.serviceId, model).summary} Configured ${route.mode} mode. Task associations are application preferences, not measured quality rankings.`,
        evidence: getModelRoutingEvidence(route.serviceId, model),
      });
      candidates.get(key).tasks.push(task);
    }
  }
  return [...candidates.values()];
}

export function applySemanticRouting(chatRequest, routes, runtimeConfig, analysis, candidates, router = { label: "Jev", method: "jev", version: "jev-v1" }) {
  const classifiedTask = TASK_CATEGORIES.includes(analysis?.task) ? analysis.task : null;
  const automatic = chatRequest.serviceId === "backend-services";
  const selected = automatic ? candidates.find((candidate) => candidate.key === analysis?.routeKey
    && routes.some((route) => route.serviceId === candidate.serviceId)) : null;
  const finish = (planned) => automatic ? applyIndependentSignals(planned, candidates, analysis?.signals, !selected, router) : planned;
  if (!classifiedTask && !selected) {
    if (!automatic) return routes;
    const outcome = analysis?.keepDefault === true ? `${router.label} kept the configured routing preference.`
      : analysis ? `${router.label} did not provide a usable routing decision.` : `${router.label} was unavailable.`;
    return finish(routes.map((route) => ({ ...route, reason: `${outcome} ${route.reason}` })));
  }
  const task = classifiedTask ?? routes[0].task;
  const planned = planRoutes(chatRequest, routes.map((route) => route.serviceId), runtimeConfig, { task });
  const classified = planned.map((route) => ({
    ...route,
    routing: { ...route.routing, method: automatic && classifiedTask ? `${router.method}-task` : route.routing.method },
    profileVersion: classifiedTask ? `${route.profileVersion}+${router.version}` : route.profileVersion,
    reason: classifiedTask ? `${router.label} classified this request as ${task}. ${route.reason}` : route.reason,
  }));
  if (!selected) return finish(classified);
  const first = classified.find((route) => route.serviceId === selected.serviceId);
  if (!first) return finish(classified);
  const taskExplanation = classifiedTask
    ? `${router.label} classified the request as ${task}.`
    : `Routing rules classified the request as ${task}.`;
  const profileExplanation = selected.tasks.includes(task)
    ? `The app's ${first.mode} profile assigns this model to ${task} tasks.`
    : `The model is a configured candidate in ${first.mode} mode.`;
  return finish([{
    ...first,
    model: selected.model,
    routing: { method: router.method, selectedModel: selected.model },
    profileVersion: `${MODEL_PROFILE_VERSION}+${router.version}`,
    reason: `${router.label} selected ${PROVIDER_LABELS[selected.serviceId]} (${selected.model}). ${taskExplanation} ${profileExplanation} Only allowed providers with an available key were considered.`,
  }, ...classified.filter((route) => route.serviceId !== selected.serviceId)]);
}

function applyIndependentSignals(routes, candidates, signals, allowPreference, router) {
  const complexity = signals?.complexity;
  const demanding = Number.isFinite(complexity?.score) && complexity.score >= 2.25 && complexity.score <= 3
    && Number.isFinite(complexity.confidence) && complexity.confidence >= 0.7 && complexity.confidence <= 1;
  const freshness = signals?.needsCurrentInformation;
  const needsCurrentInformation = Number.isFinite(freshness) && freshness >= 0.8 && freshness <= 1;
  if (!demanding && !needsCurrentInformation) return routes;
  // Thresholds are explicit, provisional application policy. A freshness signal
  // never grants browsing or expands credentials; a model choice stays authoritative.
  return routes.map((route) => {
    let next = route;
    const evidence = getModelRoutingEvidence(route.serviceId, route.model);
    const preferred = allowPreference && demanding && route.mode !== "fast"
      && !["demanding", "coding", "unknown"].includes(evidence.preference)
      ? candidates.find((candidate) => candidate.serviceId === route.serviceId
        && getModelRoutingEvidence(candidate.serviceId, candidate.model).preference === "demanding") : null;
    if (preferred && preferred.model !== route.model) {
      const classification = route.routing?.method === `${router.method}-task` ? `${router.label} classified this request as ${route.task}. ` : "";
      next = {
        ...route,
        model: preferred.model,
        routing: { ...route.routing, selectedModel: preferred.model },
        reason: `${classification}Routing rules selected ${PROVIDER_LABELS[route.serviceId]} (${preferred.model}) for ${route.task} using the app's complex-work preference after ${router.label} assessed demanding work. ${MODE_TRADEOFFS[route.mode]} This is an application heuristic, not a comparative benchmark result.`,
      };
    } else if (demanding) {
      next = { ...next, reason: `${next.reason} ${router.label} assessed demanding work; the existing model and speed preference were retained.` };
    }
    if (needsCurrentInformation) next = { ...next,
      reason: `${next.reason} This request likely needs current external information; this route does not perform live web search. Verify current facts against up-to-date sources.`,
    };
    return { ...next, profileVersion: `${next.profileVersion}+${router.method}-signals-v1` };
  });
}

export function routingReasonForAttempt(route, fallbacks) {
  if (!fallbacks.length) return route.reason;
  const previous = fallbacks.at(-1);
  return `The earlier ${PROVIDER_LABELS[previous.provider] ?? previous.provider} (${previous.model}) request failed. ${route.reason}`;
}
