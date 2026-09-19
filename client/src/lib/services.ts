import type { BackendServiceId } from "../types";

export interface BackendServiceModel {
  badgeLabel?: string;
  description: string;
  featured?: boolean;
  id: string;
  label: string;
}

export interface BackendServiceOption {
  id: BackendServiceId;
  label: string;
  description: string;
  iconLabel: string;
  keywords: string[];
  modeLabel: string;
  models: BackendServiceModel[];
  provider: string;
}

export interface RecentBackendServiceSelection {
  modelId: string;
  serviceId: BackendServiceId;
}

export const DEFAULT_BACKEND_SERVICE_ID: BackendServiceId = "backend-services";
export const MAX_RECENT_BACKEND_SERVICE_SELECTIONS = 5;

const OPENAI_MODELS: BackendServiceModel[] = [
  {
    badgeLabel: "FLAGSHIP",
    description:
      "OpenAI's most capable model for demanding reasoning, coding, and professional work.",
    featured: true,
    id: "gpt-6-astra",
    label: "GPT-6 Astra",
  },
  {
    badgeLabel: "VERSATILE",
    description:
      "Strong general-purpose reasoning and coding with lower per-token cost than Astra.",
    featured: true,
    id: "gpt-5.6",
    label: "GPT-5.6 Sol",
  },
  {
    badgeLabel: "BALANCED",
    description:
      "GPT-5.6 model balancing frontier intelligence with lower cost for everyday production use.",
    featured: true,
    id: "gpt-5.6-terra",
    label: "GPT-5.6 Terra",
  },
  {
    badgeLabel: "FAST",
    description:
      "Cost-sensitive GPT-5.6 model for responsive, high-volume workloads.",
    id: "gpt-5.6-luna",
    label: "GPT-5.6 Luna",
  },
];

export const BACKEND_SERVICE_OPTIONS: BackendServiceOption[] = [
  {
    id: "backend-services",
    label: "Automatic",
    description: "Choose a model for the task, your context, and your speed preference. Each answer explains the selection.",
    iconLabel: "MC",
    keywords: ["automatic", "smart routing", "default", "orchestration", "backend"],
    modeLabel: "Auto",
    models: [
      {
        description:
          "Match the task to an available model, with saved selection and context details for every answer.",
        id: "smart-routing",
        label: "Auto",
      },
    ],
    provider: "Margin Chat",
  },
  {
    id: "openai-api",
    label: "OpenAI",
    description: "Route the conversation directly through OpenAI's latest GPT models.",
    iconLabel: "OA",
    keywords: ["openai", "gpt", "responses", "reasoning", "chatgpt"],
    modeLabel: "Direct",
    models: OPENAI_MODELS,
    provider: "OpenAI",
  },
  {
    id: "openai-agent",
    label: "OpenAI Agent",
    description:
      "Use OpenAI with Margin Chat's workspace tools so the model can inspect your saved threads and branches before answering.",
    iconLabel: "AG",
    keywords: [
      "openai",
      "agent",
      "tools",
      "workspace memory",
      "threads",
      "branches",
    ],
    modeLabel: "Agent",
    models: OPENAI_MODELS.map((model) => ({
      ...model,
      featured: false,
    })),
    provider: "OpenAI Agent",
  },
  {
    id: "gemini-api",
    label: "Google Gemini",
    description: "Route the conversation through Google's strongest Gemini API models.",
    iconLabel: "G",
    keywords: ["gemini", "google", "generative language", "multimodal", "flash"],
    modeLabel: "Direct",
    models: [
      {
        badgeLabel: "STABLE",
        description: "Google's latest stable Flash model for capable, responsive everyday chat and coding.",
        featured: true,
        id: "gemini-3.8-flash",
        label: "Gemini 3.8 Flash",
      },
      {
        badgeLabel: "PREVIEW",
        description: "Advanced Pro reasoning for complex tasks. Preview release with potentially changing availability and behavior.",
        featured: true,
        id: "gemini-3.1-pro-preview",
        label: "Gemini 3.1 Pro Preview",
      },
      {
        badgeLabel: "FAST",
        description: "Stable, economical Gemini model for quick responses and high-volume work.",
        id: "gemini-3.5-flash-lite",
        label: "Gemini 3.5 Flash-Lite",
      },
    ],
    provider: "Google",
  },
  {
    id: "huggingface-api",
    label: "Hugging Face",
    description: "Open-source and custom-license open-weight models served through Hugging Face. License details appear on each choice.",
    iconLabel: "HF",
    keywords: [
      "hugging face",
      "huggingface",
      "hf",
      "inference",
      "open models",
      "open source",
      "open weight",
      "deepseek",
      "qwen",
      "glm",
      "minimax",
      "kimi",
      "moonshot",
    ],
    modeLabel: "Direct",
    models: [
      {
        badgeLabel: "MIT",
        description: "Efficient general chat and reasoning from DeepSeek's latest Flash release. MIT-licensed weights.",
        featured: true,
        id: "deepseek-ai/DeepSeek-V4.1-Flash",
        label: "DeepSeek V4.1 Flash",
      },
      {
        badgeLabel: "MIT",
        description: "DeepSeek's flagship reasoning and coding release. MIT-licensed weights.",
        featured: true,
        id: "deepseek-ai/DeepSeek-V4-Pro-0813",
        label: "DeepSeek V4 Pro",
      },
      {
        badgeLabel: "APACHE 2.0",
        description: "Compact, capable Qwen model for responsive everyday tasks. Apache 2.0-licensed weights.",
        id: "Qwen/Qwen3.8-27B",
        label: "Qwen3.8 27B",
      },
      {
        badgeLabel: "OPEN-WEIGHT",
        description: "Z.ai's flagship coding and agentic model. Custom GLM license; review terms before commercial use.",
        featured: true,
        id: "zai-org/GLM-5.3",
        label: "GLM 5.3",
      },
      {
        badgeLabel: "OPEN-WEIGHT",
        description:
          "Moonshot AI's flagship for long-context reasoning, coding, and knowledge work. Custom Kimi K3 license.",
        featured: true,
        id: "moonshotai/Kimi-K3",
        label: "Kimi K3",
      },
      {
        badgeLabel: "OPEN-WEIGHT",
        description: "Large Qwen flagship for research, reasoning, and professional text work. Custom Qwen3.8-Max license.",
        id: "Qwen/Qwen3.8-2.4T-A95B",
        label: "Qwen3.8 2.4T",
      },
      {
        badgeLabel: "OPEN-WEIGHT",
        description: "Efficient long-context reasoning and general work. Custom MiniMax Community license.",
        id: "MiniMaxAI/MiniMax-M3",
        label: "MiniMax M3",
      },
    ],
    provider: "Hugging Face",
  },
  {
    id: "xai-api",
    label: "xAI Grok",
    description: "Route the conversation through xAI's Grok Responses API.",
    iconLabel: "XI",
    keywords: ["xai", "x.ai", "grok", "responses", "reasoning", "fast"],
    modeLabel: "Direct",
    models: [
      {
        badgeLabel: "FLAGSHIP",
        description: "xAI's flagship model for code, agentic tool use, configurable reasoning, and general chat.",
        featured: true,
        id: "grok-4.6",
        label: "Grok 4.6",
      },
      {
        badgeLabel: "BALANCED",
        description: "Current stable Grok model with configurable reasoning and a large context window.",
        featured: true,
        id: "grok-4.3",
        label: "Grok 4.3",
      },
    ],
    provider: "xAI",
  },
];

// Keep saved chats and recent selections intact without promoting older models
// in the fresh model catalog. Provider availability may still change over time.
const LEGACY_MODELS: Partial<Record<BackendServiceId, BackendServiceModel[]>> = {
  "gemini-api": [
    { id: "gemini-3.5-flash", label: "Gemini 3.5 Flash", description: "Previous Flash release, retained for saved chats." },
    { id: "gemini-3.1-flash-lite", label: "Gemini 3.1 Flash-Lite", description: "Previous Flash-Lite release, retained for saved chats." },
  ],
  "huggingface-api": [
    { id: "openai/gpt-oss-120b", label: "gpt-oss-120b", description: "Previous open-weight selection, retained for saved chats." },
    { id: "deepseek-ai/DeepSeek-R1", label: "DeepSeek R1", description: "Previous reasoning selection, retained for saved chats." },
    { id: "Qwen/Qwen3-Coder-480B-A35B-Instruct", label: "Qwen3 Coder 480B", description: "Previous coding selection, retained for saved chats." },
  ],
  "xai-api": [
    { id: "grok-4.5", label: "Grok 4.5", description: "Previous Grok flagship, retained for saved chats." },
  ],
};

const FALLBACK_MODEL_LABEL = "Auto";

const BACKEND_SERVICE_OPTIONS_BY_ID = new Map(
  BACKEND_SERVICE_OPTIONS.map((service) => [service.id, service]),
);

export function isBackendServiceId(
  value: unknown,
): value is BackendServiceId {
  return BACKEND_SERVICE_OPTIONS.some((service) => service.id === value);
}

export function getBackendServiceLabel(serviceId: BackendServiceId): string {
  return (
    getBackendServiceOption(serviceId)?.label ??
    "Automatic"
  );
}

export function getBackendServiceOption(
  serviceId: BackendServiceId,
): BackendServiceOption | undefined {
  return BACKEND_SERVICE_OPTIONS_BY_ID.get(serviceId);
}

export function getBackendServiceModel(
  serviceId: BackendServiceId,
  modelId: string,
): BackendServiceModel | undefined {
  return getBackendServiceOption(serviceId)?.models.find((model) => model.id === modelId)
    ?? LEGACY_MODELS[serviceId]?.find((model) => model.id === modelId);
}

export function isBackendServiceModelId(
  serviceId: BackendServiceId,
  modelId: string,
): boolean {
  return Boolean(getBackendServiceModel(serviceId, modelId));
}

export function getDefaultModelIdForService(
  serviceId: BackendServiceId,
): string {
  return (
    getBackendServiceOption(serviceId)?.models[0]?.id ??
    BACKEND_SERVICE_OPTIONS[0]?.models[0]?.id ??
    "smart-routing"
  );
}

export function resolveBackendServiceModelId(
  serviceId: BackendServiceId,
  modelId: unknown,
): string {
  return typeof modelId === "string" && isBackendServiceModelId(serviceId, modelId)
    ? modelId
    : getDefaultModelIdForService(serviceId);
}

export function sanitizeRecentBackendServiceSelections(
  input: unknown,
): RecentBackendServiceSelection[] {
  if (!Array.isArray(input)) {
    return [];
  }

  const recentSelections: RecentBackendServiceSelection[] = [];
  const seen = new Set<string>();

  for (const selection of input) {
    if (!selection || typeof selection !== "object" || Array.isArray(selection)) {
      continue;
    }

    const { modelId, serviceId } = selection as {
      modelId?: unknown;
      serviceId?: unknown;
    };

    if (
      !isBackendServiceId(serviceId) ||
      typeof modelId !== "string" ||
      !isBackendServiceModelId(serviceId, modelId)
    ) {
      continue;
    }

    const selectionKey = `${serviceId}:${modelId}`;

    if (seen.has(selectionKey)) {
      continue;
    }

    seen.add(selectionKey);
    recentSelections.push({
      modelId,
      serviceId,
    });

    if (recentSelections.length >= MAX_RECENT_BACKEND_SERVICE_SELECTIONS) {
      break;
    }
  }

  return recentSelections;
}

export function upsertRecentBackendServiceSelection(
  selections: RecentBackendServiceSelection[],
  selection: RecentBackendServiceSelection,
): RecentBackendServiceSelection[] {
  const normalizedSelection = {
    modelId: resolveBackendServiceModelId(selection.serviceId, selection.modelId),
    serviceId: selection.serviceId,
  };

  return [
    normalizedSelection,
    ...selections.filter(
      (currentSelection) =>
        !(
          currentSelection.serviceId === normalizedSelection.serviceId &&
          currentSelection.modelId === normalizedSelection.modelId
        ),
    ),
  ].slice(0, MAX_RECENT_BACKEND_SERVICE_SELECTIONS);
}

export function getBackendServiceModelLabel(
  serviceId: BackendServiceId,
  modelId: string,
): string {
  return (
    getBackendServiceModel(serviceId, modelId)?.label ??
    getBackendServiceModel(
      serviceId,
      getDefaultModelIdForService(serviceId),
    )?.label ??
    FALLBACK_MODEL_LABEL
  );
}

export function getBackendServiceSelectionLabel(
  serviceId: BackendServiceId,
  modelId: string,
): string {
  const service = getBackendServiceOption(serviceId);
  const modelLabel = getBackendServiceModelLabel(serviceId, modelId);

  if (!service || service.id === "backend-services") {
    return modelLabel;
  }

  return `${service.label} / ${modelLabel}`;
}
