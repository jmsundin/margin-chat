export const AI_MODES = Object.freeze(["balanced", "fast", "thorough"]);
export const AI_PROVIDERS = Object.freeze(["openai", "gemini", "huggingface", "xai"]);
const scopes = new Set(["conversation", "selected", "workspace"]);
const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
const text = (value, limit) => typeof value === "string" ? value.slice(0, limit) : "";

/** Safe defaults apply to old vaults; an explicit empty provider list stays empty. */
export function normalizeAISettings(input) {
  const value = record(input) ? input : {};
  return {
    mode: AI_MODES.includes(value.mode) ? value.mode : "balanced",
    contextScope: scopes.has(value.contextScope) ? value.contextScope : "conversation",
    selectedConversationIds: [...new Set(Array.isArray(value.selectedConversationIds)
      ? value.selectedConversationIds.filter((id) => typeof id === "string" && id.length > 0 && id.length <= 256) : [])].slice(0, 100),
    ...(Array.isArray(value.allowedProviders) ? {
      allowedProviders: [...new Set(value.allowedProviders.filter((provider) => AI_PROVIDERS.includes(provider)))],
    } : {}),
  };
}

/** Receipts are portable data, never credentials, executable instructions, or hidden reasoning. */
export function normalizeAIExecution(input) {
  if (!record(input) || input.schemaVersion !== 1 || !text(input.model, 200) || !text(input.provider, 80)) return undefined;
  const result = {
    schemaVersion: 1,
    model: text(input.model, 200),
    provider: text(input.provider, 80),
    mode: AI_MODES.includes(input.mode) ? input.mode : "balanced",
    task: text(input.task, 80) || "general",
    reason: text(input.reason, 2000),
    profileVersion: text(input.profileVersion, 120),
    sources: (Array.isArray(input.sources) ? input.sources : []).filter((source) => record(source) &&
      ["conversation", "note", "document"].includes(source.kind) && text(source.id, 256)).slice(0, 100).map((source) => ({
        kind: source.kind, id: text(source.id, 256), title: text(source.title, 300),
        ...(text(source.updatedAt, 60) ? { updatedAt: text(source.updatedAt, 60) } : {}),
        ...(text(source.excerpt, 240) ? { excerpt: text(source.excerpt, 240) } : {}),
      })),
    truncated: input.truncated === true,
    fallbacks: (Array.isArray(input.fallbacks) ? input.fallbacks : []).filter(record).slice(0, 12).map((fallback) => ({
      provider: text(fallback.provider, 80), model: text(fallback.model, 200), reason: text(fallback.reason, 500),
    })),
    warnings: (Array.isArray(input.warnings) ? input.warnings : []).filter((warning) => typeof warning === "string").slice(0, 20).map((warning) => warning.slice(0, 1000)),
  };
  if (Number.isFinite(input.durationMs) && input.durationMs >= 0) result.durationMs = Math.round(input.durationMs);
  if (typeof input.completedAt === "string" && Number.isFinite(Date.parse(input.completedAt))) result.completedAt = input.completedAt;
  if (["streaming", "complete", "stopped", "failed"].includes(input.status)) result.status = input.status;
  return result;
}
