import { isBackendModelIdForService } from "../lib/backendModels.mjs";

// Summaries already reviewed for docs/model-catalog.md on 2026-09-19. These
// descriptions are not comparative benchmark results, measured latency, or prices.
const reviewed = {
  "gpt-6-sol": ["Strong reasoning, coding, and professional work at lower per-token cost than Astra.", "general", "https://developers.openai.com/api/docs/models/gpt-6-sol"],
  "gpt-6-luna": ["Efficient focused tasks and high-volume workloads.", "economical", "https://developers.openai.com/api/docs/models/gpt-6-luna"],
  "grok-4.7": ["Frontier coding, agentic tasks, and knowledge work.", "demanding", "https://docs.x.ai/developers/models/grok-4.7"],
  "gpt-6-astra": ["Complex reasoning, coding, and professional work.", "demanding", "https://developers.openai.com/api/docs/models/gpt-6-astra"],
  "gpt-5.6": ["General-purpose reasoning, coding, and professional work; Sol alias.", "general", "https://developers.openai.com/api/docs/models/gpt-5.6-sol"],
  "gpt-5.6-terra": ["Balances capability and cost for everyday production work.", "balanced", "https://developers.openai.com/api/docs/models/gpt-5.6-terra"],
  "gpt-5.6-luna": ["Economical option for responsive, high-volume workloads.", "economical", "https://developers.openai.com/api/docs/models/gpt-5.6-luna"],
  "gemini-3.8-flash": ["Stable Flash option for responsive everyday chat and coding.", "general", "https://ai.google.dev/gemini-api/docs/models"],
  "gemini-3.1-pro-preview": ["Advanced Pro reasoning for complex work; preview availability can change.", "demanding", "https://ai.google.dev/gemini-api/docs/models"],
  "gemini-3.5-flash-lite": ["Stable economical option for quick, high-volume work.", "economical", "https://ai.google.dev/gemini-api/docs/models"],
  "deepseek-ai/DeepSeek-V4.1-Flash": ["Efficient general chat and reasoning; MIT-licensed weights.", "general", "https://huggingface.co/deepseek-ai/DeepSeek-V4.1-Flash"],
  "deepseek-ai/DeepSeek-V4-Pro-0813": ["Flagship reasoning and coding release; MIT-licensed weights.", "demanding", "https://huggingface.co/deepseek-ai/DeepSeek-V4-Pro-0813"],
  "Qwen/Qwen3.8-27B": ["Compact model for responsive everyday tasks; Apache 2.0 weights.", "economical", "https://huggingface.co/Qwen/Qwen3.8-27B"],
  "zai-org/GLM-5.3": ["Coding and agentic model; custom GLM license.", "coding", "https://huggingface.co/zai-org/GLM-5.3"],
  "moonshotai/Kimi-K3": ["Long-context reasoning, coding, and knowledge work; custom Kimi K3 license.", "general", "https://huggingface.co/moonshotai/Kimi-K3"],
  "Qwen/Qwen3.8-2.4T-A95B": ["Large model for research, reasoning, and professional text work; custom Qwen3.8-Max license.", "general", "https://huggingface.co/Qwen/Qwen3.8-2.4T-A95B"],
  "MiniMaxAI/MiniMax-M3": ["Long-context reasoning and general work; custom MiniMax Community license.", "general", "https://huggingface.co/MiniMaxAI/MiniMax-M3"],
  "grok-4.6": ["Flagship general chat, coding, and reasoning option.", "demanding", "https://docs.x.ai/developers/models"],
  "grok-4.3": ["Additional supported Grok model; the app uses it for its fast profile.", "alternative", "https://docs.x.ai/developers/models/grok-4.3"],
};

export function getModelRoutingEvidence(serviceId, model) {
  const entry = isBackendModelIdForService(serviceId, model) ? reviewed[model] : null;
  return entry ? {
    basis: "reviewed-catalog",
    reviewedAt: "2026-09-26",
    summary: entry[0],
    // This is an explicit application preference, never a measured quality rank.
    preference: entry[1],
    source: entry[2],
  } : {
    basis: "configured-only",
    summary: "Configured model with no current reviewed comparison evidence. Preserve the configured preference unless supplied evidence supports a change.",
    preference: "unknown",
  };
}

export const ROUTING_ADAPTER_CAPABILITIES = Object.freeze({
  input: "Text messages and supplied workspace excerpts only.",
  liveWebSearch: false,
  limitation: "These reply routes do not browse the web. Model availability, measured latency, prices, and comparative benchmark scores are not supplied.",
});
