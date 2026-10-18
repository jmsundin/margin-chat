export const AI_MODES = Object.freeze(["balanced", "fast", "thorough"]);
export const AI_PROVIDERS = Object.freeze(["openai", "anthropic", "gemini", "huggingface", "xai", "meta"]);
const scopes = new Set(["conversation", "selected", "workspace"]);
/** Agent run budgets offered in the composer, in micro-dollars. */
export const AGENT_BUDGET_CHOICES_MICROS = Object.freeze([250_000, 500_000, 1_000_000, 2_000_000]);
export const DEFAULT_AGENT_BUDGET_MICROS = 1_000_000;
const agentStopReasons = new Set(["answered", "budget", "round-limit", "time-limit", "question"]);
const routingMethods = new Set(["astra", "astra-task", "jev", "jev-task", "rules", "manual"]);
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
    ...(value.jevEnabled === true ? { jevEnabled: true } : {}),
    ...(value.agent === true ? { agent: true } : {}),
    ...(AGENT_BUDGET_CHOICES_MICROS.includes(value.agentBudgetMicros) ? { agentBudgetMicros: value.agentBudgetMicros } : {}),
    ...(scopes.has(value.agentScope) ? { agentScope: value.agentScope } : {}),
    // On unless switched off: Agent mode starts by itself when a prompt needs looking things up.
    ...(value.agentAuto === false ? { agentAuto: false } : {}),
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
  const routing = record(input.routing) ? input.routing : null;
  const selectedModel = typeof routing?.selectedModel === "string" ? routing.selectedModel.trim().slice(0, 200) : "";
  if (routingMethods.has(routing?.method) && selectedModel) {
    result.routing = { method: routing.method, selectedModel };
  }
  if (typeof input.completedAt === "string" && Number.isFinite(Date.parse(input.completedAt))) result.completedAt = input.completedAt;
  if (["streaming", "complete", "stopped", "failed"].includes(input.status)) result.status = input.status;
  const agent = normalizeAgentRun(input.agent);
  if (agent) result.agent = agent;
  const retrieval = normalizeRetrieval(input.retrieval);
  if (retrieval) result.retrieval = retrieval;
  return result;
}

const retrievalStatuses = new Set(["used", "none-found", "not-searched", "failed"]);
const passageKinds = new Set(["document", "note", "chat", "file"]);
const passageMatches = new Set(["both", "keyword", "meaning"]);

function normalizeRetrievalPassage(input) {
  if (!record(input) || !text(input.id, 256) || !passageKinds.has(input.kind) || !passageMatches.has(input.matched)) return undefined;
  const similarity = Number.isFinite(input.similarity) ? Math.round(Math.min(1, Math.max(-1, input.similarity)) * 100) / 100 : undefined;
  return {
    ...(text(input.label, 20) ? { label: text(input.label, 20) } : {}),
    id: text(input.id, 256), kind: input.kind, title: text(input.title, 300),
    ...(text(input.heading, 300) ? { heading: text(input.heading, 300) } : {}),
    matched: input.matched,
    ...(similarity !== undefined ? { similarity } : {}),
    ...(text(input.excerpt, 240) ? { excerpt: text(input.excerpt, 240) } : {}),
    ...(text(input.blockId, 256) ? { blockId: text(input.blockId, 256) } : {}),
    ...(text(input.openId, 256) ? { openId: text(input.openId, 256) } : {}),
    ...(input.cited === true ? { cited: true } : {}),
  };
}

/** What the vault search contributed to a reply: found passages and how they matched, never their full text. */
function normalizeRetrieval(input) {
  if (!record(input) || !retrievalStatuses.has(input.status)) return undefined;
  const alreadyIncluded = micros(input.alreadyIncluded);
  const queries = (Array.isArray(input.queries) ? input.queries : []).map((query) => text(query, 200)).filter(Boolean).slice(0, 12);
  return {
    status: input.status,
    ...(input.agent === true ? { agent: true } : {}),
    ...(queries.length ? { queries } : {}),
    meaning: input.meaning === true,
    ...(text(input.note, 300) ? { note: text(input.note, 300) } : {}),
    ...(alreadyIncluded ? { alreadyIncluded } : {}),
    passages: (Array.isArray(input.passages) ? input.passages : []).map(normalizeRetrievalPassage).filter(Boolean).slice(0, 20),
  };
}

const micros = (value) => Number.isSafeInteger(value) && value >= 0 ? value : undefined;

/** Characters kept from one model call's thinking in a saved run log. */
export const AGENT_THINKING_CHARACTERS = 4_000;

/**
 * One line of an agent's run log. Labels are written by the server, never tool
 * output; a thinking step's label is the model's own summary of its reasoning.
 */
export function normalizeAgentStep(input) {
  if (!record(input) || !["tool", "note", "thinking"].includes(input.kind)) return undefined;
  const limit = input.kind === "thinking" ? AGENT_THINKING_CHARACTERS : 300;
  if (!text(input.label, limit).trim()) return undefined;
  return {
    kind: input.kind,
    label: text(input.label, limit),
    ...(input.kind === "tool" && text(input.tool, 80) ? { tool: text(input.tool, 80) } : {}),
    ...(text(input.detail, 200) ? { detail: text(input.detail, 200) } : {}),
    ok: input.ok !== false,
  };
}

function normalizeAgentRun(input) {
  if (!record(input)) return undefined;
  const spentMicros = micros(input.spentMicros);
  const budgetMicros = micros(input.budgetMicros);
  const modelCalls = micros(input.modelCalls);
  return {
    steps: (Array.isArray(input.steps) ? input.steps : []).map(normalizeAgentStep).filter(Boolean).slice(0, 60),
    stopReason: agentStopReasons.has(input.stopReason) ? input.stopReason : "answered",
    ...(["shared", "not-shared"].includes(input.reasoning) ? { reasoning: input.reasoning } : {}),
    ...(modelCalls !== undefined ? { modelCalls } : {}),
    ...(spentMicros !== undefined ? { spentMicros } : {}),
    ...(budgetMicros !== undefined ? { budgetMicros } : {}),
    // Why Agent mode turned itself on for this reply, written by the server.
    ...(text(input.automatic, 200).trim() ? { automatic: text(input.automatic, 200) } : {}),
    ...webSourcesOf(input.webSources),
    ...questionOf(input),
    ...proposalsOf(input.proposals),
  };
}

const proposalStatuses = new Set(["approved", "dismissed"]);
const idText = (value) => text(value, 256).trim();

/** Changes an agent drafted for the user to approve, with what the user decided. A new document's
 * `createdId` is the document approving it made. */
function proposalsOf(input) {
  const proposals = (Array.isArray(input) ? input : []).filter(record).flatMap((proposal) => {
    const base = { id: text(proposal.id, 40), summary: text(proposal.summary, 300),
      ...(proposalStatuses.has(proposal.status) ? { status: proposal.status } : {}) };
    if (!base.id) return [];
    if (proposal.kind === "edit" && idText(proposal.documentId) && typeof proposal.find === "string" && typeof proposal.replace === "string"
        && proposal.find.length <= 4_000 && proposal.replace.length <= 20_000 && proposal.find !== proposal.replace) {
      return [{ ...base, kind: "edit", documentId: idText(proposal.documentId), documentTitle: text(proposal.documentTitle, 300), find: proposal.find, replace: proposal.replace }];
    }
    if (proposal.kind === "create" && idText(proposal.parentId) && text(proposal.title, 200).trim() && typeof proposal.content === "string" && proposal.content.length <= 40_000) {
      return [{ ...base, kind: "create", parentId: idText(proposal.parentId), parentTitle: text(proposal.parentTitle, 300), title: text(proposal.title, 200),
        content: proposal.content, ...(idText(proposal.createdId) ? { createdId: idText(proposal.createdId) } : {}) }];
    }
    return [];
  }).slice(0, 8);
  return proposals.length ? { proposals } : {};
}

/** The clarifying question a run ended with, so the next message can resume the agent. */
function questionOf(input) {
  if (input.stopReason !== "question" || !record(input.question) || !text(input.question.text, 500).trim()) return {};
  const options = (Array.isArray(input.question.options) ? input.question.options : []).map((option) => text(option, 120).trim()).filter(Boolean).slice(0, 4);
  return { question: { text: text(input.question.text, 500), options } };
}

/** Web pages an agent's answer cites: plain http(s) links and their titles, never page text. */
function webSourcesOf(input) {
  const seen = new Set();
  const sources = (Array.isArray(input) ? input : []).filter(record).flatMap((source) => {
    let url;
    try { url = new URL(text(source.url, 2000)); } catch { return []; }
    if (!["http:", "https:"].includes(url.protocol) || url.username || url.password || seen.has(url.href)) return [];
    seen.add(url.href);
    return [{ url: url.href, title: text(source.title, 200) }];
  }).slice(0, 20);
  return sources.length ? { webSources: sources } : {};
}
