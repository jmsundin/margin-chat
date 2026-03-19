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
    badgeLabel: "NEW",
    description:
      "Current default OpenAI flagship for general-purpose work, coding, and tool-heavy tasks.",
    featured: true,
    id: "gpt-5.4",
    label: "GPT-5.4",
  },
  {
    badgeLabel: "BEST",
    description:
      "Higher-compute GPT-5.4 variant for the hardest problems and deeper reasoning.",
    id: "gpt-5.4-pro",
    label: "GPT-5.4 Pro",
  },
  {
    badgeLabel: "CHATGPT",
    description:
      "Alias for the model currently powering ChatGPT when you want the freshest ChatGPT behavior.",
    featured: true,
    id: "gpt-5-chat-latest",
    label: "GPT-5 Chat Latest",
  },
  {
    badgeLabel: "FAST",
    description:
      "Smaller faster GPT-5.4 variant for high-volume coding and agent workflows.",
    featured: true,
    id: "gpt-5.4-mini",
    label: "GPT-5.4 mini",
  },
  {
    badgeLabel: "NANO",
    description: "Fastest low-cost GPT-5.4 variant for simple high-throughput tasks.",
    id: "gpt-5.4-nano",
    label: "GPT-5.4 nano",
  },
];

export const BACKEND_SERVICE_OPTIONS: BackendServiceOption[] = [
  {
    id: "backend-services",
    label: "Automatic",
    description: "Let Margin Chat pick the best configured backend for the conversation.",
    iconLabel: "MC",
    keywords: ["automatic", "smart routing", "default", "orchestration", "backend"],
    modeLabel: "Auto",
    models: [
      {
        description:
          "Let Margin Chat choose the best configured backend for the conversation.",
        id: "smart-routing",
        label: "Smart routing",
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
        badgeLabel: "NEW",
        description: "Best for complex tasks that need broad world knowledge and advanced reasoning across modalities.",
        featured: true,
        id: "gemini-3.1-pro-preview",
        label: "Gemini 3.1 Pro",
      },
      {
        badgeLabel: "POPULAR",
        description: "Google's latest 3-series chat model with Pro-level intelligence at Flash speed and pricing.",
        featured: true,
        id: "gemini-3-flash-preview",
        label: "Gemini 3 Flash",
      },
      {
        badgeLabel: "FAST",
        description: "Cost-efficient workhorse for high-volume chat and lightweight reasoning tasks.",
        id: "gemini-3.1-flash-lite-preview",
        label: "Gemini 3.1 Flash-Lite",
      },
    ],
    provider: "Google",
  },
  {
    id: "huggingface-api",
    label: "Hugging Face",
    description: "Route the conversation through Hugging Face's OpenAI-compatible inference router.",
    iconLabel: "HF",
    keywords: ["hugging face", "huggingface", "hf", "inference", "open models"],
    modeLabel: "Direct",
    models: [
      {
        badgeLabel: "POPULAR",
        description: "Top open-weight general model choice through the Hugging Face router.",
        featured: true,
        id: "openai/gpt-oss-120b",
        label: "gpt-oss-120b",
      },
      {
        badgeLabel: "REASONING",
        description: "DeepSeek's strongest reasoning-focused open model for harder analytical work.",
        featured: true,
        id: "deepseek-ai/DeepSeek-R1",
        label: "DeepSeek R1",
      },
      {
        badgeLabel: "CODING",
        description: "Large open coding specialist with strong code generation and repo assistance.",
        id: "Qwen/Qwen3-Coder-480B-A35B-Instruct",
        label: "Qwen3 Coder 480B",
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
        badgeLabel: "NEW",
        description: "xAI's getting-started default and the newest Grok 4.20 beta chat path.",
        featured: true,
        id: "grok-4.20-beta-latest-non-reasoning",
        label: "Grok 4.20 Beta",
      },
      {
        badgeLabel: "FLAGSHIP",
        description: "Stable Grok 4 flagship for stronger reasoning and general-purpose work.",
        featured: true,
        id: "grok-4",
        label: "Grok 4",
      },
      {
        badgeLabel: "FAST",
        description: "Fast Grok 4 variant for coding, chat, and document-heavy workflows.",
        featured: true,
        id: "grok-4-fast",
        label: "Grok 4 Fast",
      },
      {
        badgeLabel: "FAST",
        description: "Low-latency non-reasoning Grok 4 Fast variant for quick responses.",
        id: "grok-4-fast-non-reasoning",
        label: "Grok 4 Fast Non-Reasoning",
      },
      {
        badgeLabel: "TOOLS",
        description: "Fast reasoning Grok model used across xAI's current tool and search guides.",
        id: "grok-4-1-fast-reasoning",
        label: "Grok 4.1 Fast Reasoning",
      },
      {
        badgeLabel: "TOOLS",
        description: "Fast non-reasoning Grok 4.1 variant for structured outputs and lighter workflows.",
        id: "grok-4-1-fast-non-reasoning",
        label: "Grok 4.1 Fast Non-Reasoning",
      },
    ],
    provider: "xAI",
  },
];

const FALLBACK_MODEL_LABEL = "Smart routing";

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
  return getBackendServiceOption(serviceId)?.models.find((model) => model.id === modelId);
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
