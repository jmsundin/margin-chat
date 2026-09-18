import { MODEL_PROFILE_VERSION, selectProfileModel, TASK_PROVIDER_PREFERENCES } from "./modelProfiles.mjs";

const PROVIDER_LABELS = { "openai-api": "OpenAI", "openai-agent": "OpenAI Agent", "gemini-api": "Gemini", "huggingface-api": "Hugging Face", "xai-api": "xAI" };
const MODE_TRADEOFFS = {
  fast: "Fast favors the configured fast variant and a smaller context allowance; long or complex requests may need a larger mode.",
  balanced: "Balanced uses the configured default or task variant with a moderate context allowance.",
  thorough: "Thorough allows more context and asks for closer examination of tradeoffs; longer prompts and responses can add time and cost.",
};

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

export function planRoutes(chatRequest, eligibleServiceIds, runtimeConfig) {
  const mode = chatRequest.ai?.mode ?? "balanced";
  const task = classifyTask(chatRequest);
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
      profileVersion: MODEL_PROFILE_VERSION,
      reason: automatic
        ? `Auto selected ${PROVIDER_LABELS[serviceId]} (${model}) for ${task} using ${policy}, limited to permitted providers with available credentials. ${MODE_TRADEOFFS[mode]} This is a heuristic selection.`
        : "Used your selected provider and model.",
    };
  });
}
