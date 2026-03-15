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

export const DEFAULT_BACKEND_SERVICE_ID: BackendServiceId = "backend-services";

export const BACKEND_SERVICE_OPTIONS: BackendServiceOption[] = [
  {
    id: "backend-services",
    label: "Backend services",
    description: "Use the app's default backend orchestration.",
    iconLabel: "DF",
    keywords: ["default", "automatic", "orchestration", "fallback", "backend"],
    modeLabel: "Auto",
    models: [
      {
        description:
          "Let Margin Chat choose the best configured backend for the conversation.",
        featured: true,
        id: "smart-routing",
        label: "Smart routing",
      },
    ],
    provider: "Core",
  },
  {
    id: "openai-api",
    label: "OpenAI API",
    description: "Route the conversation through OpenAI.",
    iconLabel: "OA",
    keywords: ["openai", "gpt", "responses"],
    modeLabel: "Direct",
    models: [
      {
        badgeLabel: "NEW",
        description: "Balanced speed, strong reasoning, and the clearest default for OpenAI.",
        featured: true,
        id: "gpt-5-mini",
        label: "GPT-5 mini",
      },
      {
        description: "Flagship OpenAI quality when you want the fullest answer shape.",
        id: "gpt-5",
        label: "GPT-5",
      },
      {
        description: "Reliable structured output and everyday prompt-following.",
        id: "gpt-4.1",
        label: "GPT-4.1",
      },
    ],
    provider: "OpenAI",
  },
  {
    id: "gemini-api",
    label: "Gemini API",
    description: "Route the conversation through Gemini.",
    iconLabel: "G",
    keywords: ["gemini", "google", "generative language"],
    modeLabel: "Direct",
    models: [
      {
        badgeLabel: "NEW",
        description: "Fast multimodal-style responses and the best speed/quality balance in Gemini.",
        featured: true,
        id: "gemini-2.5-flash",
        label: "Gemini 2.5 Flash",
      },
      {
        description: "Stronger depth for harder prompts when you want a more deliberate answer.",
        id: "gemini-2.5-pro",
        label: "Gemini 2.5 Pro",
      },
      {
        description: "Quick, lightweight Gemini responses for shorter interactions.",
        id: "gemini-2.0-flash",
        label: "Gemini 2.0 Flash",
      },
    ],
    provider: "Google",
  },
  {
    id: "huggingface-api",
    label: "Hugging Face API",
    description: "Route the conversation through Hugging Face.",
    iconLabel: "HF",
    keywords: ["hugging face", "huggingface", "hf", "inference"],
    modeLabel: "Direct",
    models: [
      {
        badgeLabel: "NEW",
        description: "A sharp open model default with strong general chat and coding quality.",
        featured: true,
        id: "qwen-2.5-7b-instruct",
        label: "Qwen 2.5 7B Instruct",
      },
      {
        description: "A dependable open-weight assistant with broad ecosystem support.",
        id: "llama-3.1-8b-instruct",
        label: "Llama 3.1 8B Instruct",
      },
      {
        description: "Compact open reasoning with crisp responses and a smaller footprint.",
        id: "mistral-small-3.1",
        label: "Mistral Small 3.1",
      },
    ],
    provider: "Hugging Face",
  },
];

export function isBackendServiceId(
  value: unknown,
): value is BackendServiceId {
  return BACKEND_SERVICE_OPTIONS.some((service) => service.id === value);
}

export function getBackendServiceLabel(serviceId: BackendServiceId): string {
  return (
    getBackendServiceOption(serviceId)?.label ??
    "Backend services"
  );
}

export function getBackendServiceOption(
  serviceId: BackendServiceId,
): BackendServiceOption | undefined {
  return BACKEND_SERVICE_OPTIONS.find((service) => service.id === serviceId);
}
