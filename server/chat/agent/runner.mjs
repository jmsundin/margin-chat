import { AGENT_THINKING_CHARACTERS, DEFAULT_AGENT_BUDGET_MICROS } from "@margin-chat/workspace-contracts";
import { HttpError } from "../../lib/errors.mjs";
import { createAgentAdapter } from "./adapters.mjs";
import { agentToolDefinitions, createAgentToolExecutor, describeAgentStep } from "./tools.mjs";

/** Model calls per run, the last of which must answer without tools. */
export const AGENT_MAX_MODEL_CALLS = 12;
/** Wall-clock time after which a run stops calling tools, leaving room for the answer
 * inside the 300-second function limit in vercel.json. */
export const AGENT_TIME_LIMIT_MS = 240_000;
const MAX_STEPS = 60;
/** Thinking kept on a saved run across all its model calls; the live view shows all of it. */
const THINKING_SAVED_CHARACTERS = 16_000;
/** Built-in web searches one run may make, by AI mode. Each costs a fraction of a cent on top of tokens. */
export const AGENT_WEB_SEARCHES = Object.freeze({ fast: 3, balanced: 6, thorough: 10 });
/** Cited web pages kept on a saved run. */
const MAX_SOURCES = 20;

const WRAP_UP = {
  budget: "This run has reached its spending budget. Do not call any more tools. Answer now from what you have already found, and say briefly that you stopped early because of the budget.",
  "round-limit": "This run has reached its limit of tool rounds. Do not call any more tools. Answer now from what you have already found, and say briefly what you could not check.",
  "time-limit": "This run has used its time limit. Do not call any more tools. Answer now from what you have already found, and say briefly what you could not check.",
};

const clip = (text, maximum) => text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
const quote = (text) => `\u201c${clip(text.replace(/\s+/g, " "), 80)}\u201d`;
/** A cited page's address when it's a plain http(s) link. */
function webAddress(value) {
  try {
    const url = new URL(value);
    return ["http:", "https:"].includes(url.protocol) && !url.username && !url.password && url.href.length <= 2000 ? url.href : null;
  } catch { return null; }
}

/**
 * The agent loop: call the model with tools, run the tools it asks for, feed the
 * results back, and stop when it answers. Every model call is metered on its own
 * through `usageMeter`. The budget is checked against settled spend before each
 * call, so a run can go over by at most the call that crosses it plus the
 * tool-free answer that follows. `workspace` (`{ userId, vault, database }`) adds
 * the saved-vault tools when the request's AI context allows them.
 *
 * While a model call runs, `onThinking` receives its reasoning as the provider
 * streams it and `onActivity("writing")` marks when it starts writing text. Once
 * the call ends, that reasoning is recorded as a thinking step before the call's
 * note and tool steps.
 *
 * Text streams to `onDelta` as it is written, since a call that ends without tool
 * calls is the answer. When a call's text turns out to be followed by tool calls,
 * `onRetract` withdraws what was streamed and the text is kept as a note step.
 *
 * With `webSearch`, providers with built-in web search (Meta) may search the web
 * inside their calls, up to AGENT_WEB_SEARCHES per run; each search is a step, and
 * the pages the answer cites are kept as the run's `sources`.
 */
export async function runAgent({ provider, apiKey, chatRequest, model, systemInstruction, maxOutputTokens, maxInputCharacters,
  signal, usageMeter, workspace = null, webSearch = false, budgetMicros = DEFAULT_AGENT_BUDGET_MICROS, timeLimitMs = AGENT_TIME_LIMIT_MS, now = Date.now, readPage, importSection, onDocuments, onDelta, onRetract, onStep, onThinking, onActivity }) {
  if (!apiKey) throw new HttpError(503, `${provider} API is not configured. Add a provider API key first.`);
  const adapter = createAgentAdapter(provider, { apiKey, chatRequest, model, systemInstruction, maxOutputTokens, signal, usageMeter, webSearch },
    agentToolDefinitions(chatRequest, workspace, { documents: Boolean(onDocuments) }));
  let searchesLeft = webSearch ? AGENT_WEB_SEARCHES[chatRequest.ai?.mode] ?? AGENT_WEB_SEARCHES.balanced : 0;
  const cited = new Map();
  // Tool results of the round in progress; they join the adapter's history once the round ends.
  let outputs = [];
  const room = () => Number.isSafeInteger(maxInputCharacters)
    ? maxInputCharacters - adapter.size - JSON.stringify(outputs).length : Number.POSITIVE_INFINITY;
  const executeTool = createAgentToolExecutor({ chatRequest, workspace, signal, room, readPage, importSection, onDocuments: onDocuments ?? null });
  const startedAt = now();
  // The meter may already carry this request's routing call; count only the run.
  const startingSpend = usageMeter?.summary().amountMicros ?? 0;
  const spent = () => usageMeter ? usageMeter.summary().amountMicros - startingSpend : null;
  const metered = Boolean(usageMeter) && Number.isSafeInteger(budgetMicros) && budgetMicros > 0;
  const steps = [];
  let toolTruncated = false;
  let thinkingSaved = 0;
  let reasoningShared = false;
  const record = async (step) => {
    if (steps.length < MAX_STEPS) steps.push(step);
    await onStep?.({ step, ...(usageMeter ? { spentMicros: spent() } : {}) });
  };
  // The current call's text sent to onDelta so far.
  let streamed = "";
  const live = {
    thinking: async (delta) => { await onThinking?.(delta); },
    writing: async () => { await onActivity?.("writing"); },
    searching: async () => { await onActivity?.("searching"); },
    text: async (delta) => {
      const piece = streamed ? delta : delta.trimStart();
      if (!piece || !onDelta) return;
      streamed += piece;
      await onDelta(piece);
    },
  };
  const recordThinking = async (text) => {
    const thought = text?.trim();
    if (!thought) return;
    reasoningShared = true;
    const room = Math.min(AGENT_THINKING_CHARACTERS, THINKING_SAVED_CHARACTERS - thinkingSaved);
    if (room < 200) return;
    const label = clip(thought, room);
    thinkingSaved += label.length;
    await record({ kind: "thinking", label, ok: true });
  };

  for (let call = 1; call <= AGENT_MAX_MODEL_CALLS; call += 1) {
    signal?.throwIfAborted();
    if (Number.isSafeInteger(maxInputCharacters) && adapter.size > maxInputCharacters) {
      throw new HttpError(413, "Workspace tool history exceeded the allowed context budget. Narrow the selected context and try again.");
    }
    const stopReason = metered && spent() >= budgetMicros ? "budget"
      : now() - startedAt >= timeLimitMs ? "time-limit"
      : call === AGENT_MAX_MODEL_CALLS ? "round-limit" : null;
    streamed = "";
    const result = await adapter.call({ allowTools: !stopReason, extraInstruction: stopReason ? WRAP_UP[stopReason] : null, live, webSearches: searchesLeft });
    signal?.throwIfAborted();
    const answered = !result.toolCalls.length || stopReason;
    if (!answered && streamed) {
      streamed = "";
      await onRetract?.();
    }
    await recordThinking(result.thinking);
    for (const search of result.searches ?? []) {
      searchesLeft = Math.max(0, searchesLeft - 1);
      await record({ kind: "tool", tool: "web_search", label: search.query ? `Searched the web for ${quote(search.query)}` : "Searched the web", ok: search.ok });
    }
    for (const page of result.sources ?? []) {
      const url = webAddress(page.url);
      if (url && !cited.has(url) && cited.size < MAX_SOURCES) cited.set(url, { url, title: clip(page.title.trim(), 200) });
    }
    if (answered) {
      if (!result.text.trim()) throw new HttpError(502, `${provider} returned a response without assistant text.`);
      if (!streamed) await onDelta?.(result.text);
      return {
        model: result.model,
        reply: result.text,
        steps,
        toolTruncated,
        agent: {
          steps, stopReason: stopReason ?? "answered", reasoning: reasoningShared ? "shared" : "not-shared", modelCalls: call,
          ...(usageMeter ? { spentMicros: spent() } : {}), ...(metered ? { budgetMicros } : {}),
          ...(cited.size ? { webSources: [...cited.values()] } : {}),
        },
      };
    }
    // Text written alongside tool calls is the model narrating its plan, not the answer.
    if (result.text.trim()) await record({ kind: "note", label: clip(result.text.trim().replace(/\s+/g, " "), 300), ok: true });
    outputs = [];
    for (const toolCall of result.toolCalls) {
      signal?.throwIfAborted();
      const output = await executeTool(toolCall.name, toolCall.arguments);
      outputs.push({ id: toolCall.id, output });
      if (output?.truncated || output?.conversation?.truncated) toolTruncated = true;
      await record(describeAgentStep(toolCall.name, toolCall.arguments, output));
    }
    adapter.addToolResults(outputs);
  }
  // Unreachable: the last call never offers tools.
  throw new HttpError(502, "The agent exceeded its maximum number of model calls.");
}
