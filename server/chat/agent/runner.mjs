import { DEFAULT_AGENT_BUDGET_MICROS } from "@margin-chat/workspace-contracts";
import { HttpError } from "../../lib/errors.mjs";
import { createAgentAdapter } from "./adapters.mjs";
import { agentToolDefinitions, createAgentToolExecutor, describeAgentStep } from "./tools.mjs";

/** Model calls per run, the last of which must answer without tools. */
export const AGENT_MAX_MODEL_CALLS = 12;
/** Wall-clock time after which a run stops calling tools, leaving room for the answer
 * inside the 300-second function limit in vercel.json. */
export const AGENT_TIME_LIMIT_MS = 240_000;
const MAX_STEPS = 40;

const WRAP_UP = {
  budget: "This run has reached its spending budget. Do not call any more tools. Answer now from what you have already found, and say briefly that you stopped early because of the budget.",
  "round-limit": "This run has reached its limit of tool rounds. Do not call any more tools. Answer now from what you have already found, and say briefly what you could not check.",
  "time-limit": "This run has used its time limit. Do not call any more tools. Answer now from what you have already found, and say briefly what you could not check.",
};

const clip = (text, maximum) => text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;

/**
 * The agent loop: call the model with tools, run the tools it asks for, feed the
 * results back, and stop when it answers. Every model call is metered on its own
 * through `usageMeter`. The budget is checked against settled spend before each
 * call, so a run can go over by at most the call that crosses it plus the
 * tool-free answer that follows. `workspace` (`{ userId, vault, database }`) adds
 * the saved-vault tools when the request's AI context allows them.
 */
export async function runAgent({ provider, apiKey, chatRequest, model, systemInstruction, maxOutputTokens, maxInputCharacters,
  signal, usageMeter, workspace = null, budgetMicros = DEFAULT_AGENT_BUDGET_MICROS, timeLimitMs = AGENT_TIME_LIMIT_MS, now = Date.now, onDelta, onStep }) {
  if (!apiKey) throw new HttpError(503, `${provider} API is not configured. Add a provider API key first.`);
  const adapter = createAgentAdapter(provider, { apiKey, chatRequest, model, systemInstruction, maxOutputTokens, signal, usageMeter },
    agentToolDefinitions(chatRequest, workspace));
  const executeTool = createAgentToolExecutor({ chatRequest, workspace });
  const startedAt = now();
  // The meter may already carry this request's routing call; count only the run.
  const startingSpend = usageMeter?.summary().amountMicros ?? 0;
  const spent = () => usageMeter ? usageMeter.summary().amountMicros - startingSpend : null;
  const metered = Boolean(usageMeter) && Number.isSafeInteger(budgetMicros) && budgetMicros > 0;
  const steps = [];
  let toolTruncated = false;
  const record = async (step) => {
    if (steps.length < MAX_STEPS) steps.push(step);
    await onStep?.({ step, ...(usageMeter ? { spentMicros: spent() } : {}) });
  };

  for (let call = 1; call <= AGENT_MAX_MODEL_CALLS; call += 1) {
    signal?.throwIfAborted();
    if (Number.isSafeInteger(maxInputCharacters) && adapter.size > maxInputCharacters) {
      throw new HttpError(413, "Workspace tool history exceeded the allowed context budget. Narrow the selected context and try again.");
    }
    const stopReason = metered && spent() >= budgetMicros ? "budget"
      : now() - startedAt >= timeLimitMs ? "time-limit"
      : call === AGENT_MAX_MODEL_CALLS ? "round-limit" : null;
    const result = await adapter.call({ allowTools: !stopReason, extraInstruction: stopReason ? WRAP_UP[stopReason] : null });
    signal?.throwIfAborted();
    if (!result.toolCalls.length || stopReason) {
      if (!result.text.trim()) throw new HttpError(502, `${provider} returned a response without assistant text.`);
      await onDelta?.(result.text);
      return {
        model: result.model,
        reply: result.text,
        steps,
        toolTruncated,
        agent: {
          steps, stopReason: stopReason ?? "answered", modelCalls: call,
          ...(usageMeter ? { spentMicros: spent() } : {}), ...(metered ? { budgetMicros } : {}),
        },
      };
    }
    // Text written alongside tool calls is the model narrating its plan, not the answer.
    if (result.text.trim()) await record({ kind: "note", label: clip(result.text.trim().replace(/\s+/g, " "), 300), ok: true });
    const outputs = [];
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
