import { createSearchAnalyzer } from "./search.mjs";
import { createChatAnalyzer } from "./chatAnalysis.mjs";
import { createWorkspaceAnalyzer } from "./workspaceAnalysis.mjs";
import { createSemanticEvaluator } from "./evaluator.mjs";
import { answerFor } from "./answers.mjs";

export { validateWorkspaceAnalysis } from "./workspaceAnalysis.mjs";
export const SEMANTIC_PROMPT_VERSION = "margin-jev-3-parallel";

export function createSemanticService({ env = {}, fetchImpl = (...args) => globalThis.fetch(...args),
  onUsage = (event) => console.info(JSON.stringify(event)), now = Date.now } = {}) {
  const { configured, model, evaluate, emitMetric } = createSemanticEvaluator({
    env, fetchImpl, onUsage, now, promptVersion: SEMANTIC_PROMPT_VERSION,
  });
  return {
    configured,
    analyzeChat: createChatAnalyzer({ evaluate, answerFor, onMetric: emitMetric }),
    analyzeWorkspace: createWorkspaceAnalyzer({
      evaluate, answerFor, configured, now, model, promptVersion: SEMANTIC_PROMPT_VERSION, onMetric: emitMetric,
    }),
    analyzeSearch: createSearchAnalyzer({ evaluate, answerFor, configured }),
  };
}
