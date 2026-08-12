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
      "OpenAI's flagship GPT-5.6 model for complex reasoning, coding, and professional work.",
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
        badgeLabel: "STABLE",
        description: "Google's stable frontier model for sustained agentic, coding, and long-horizon work at Flash speed.",
        featured: true,
        id: "gemini-3.5-flash",
        label: "Gemini 3.5 Flash",
      },
      {
        badgeLabel: "FAST",
        description: "Stable high-volume Gemini 3 model optimized for latency and cost efficiency.",
        id: "gemini-3.1-flash-lite",
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
    keywords: [
      "hugging face",
      "huggingface",
      "hf",
      "inference",
      "open models",
      "kimi",
      "moonshot",
    ],
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
        badgeLabel: "NEW",
        description:
          "Moonshot AI's native multimodal agentic model for long-context reasoning, coding, and knowledge work.",
        featured: true,
        id: "moonshotai/Kimi-K3",
        label: "Kimi K3",
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
        badgeLabel: "FLAGSHIP",
        description: "xAI's flagship model for code, agentic tool use, configurable reasoning, and general chat.",
        featured: true,
        id: "grok-4.5",
        label: "Grok 4.5",
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
