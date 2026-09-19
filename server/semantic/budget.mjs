// Conservative UTF-8 byte budgets, not a tokenizer estimate. Keep headroom below
// Jev 1.13's 64k total / 32k state + longest-question token limits.
export const EVALUATION_LIMITS = Object.freeze({ stateBytes: 28_000, perQuestionBytes: 30_000, requestBytes: 60_000, questions: 128 });

export function measureEvaluationBudget({ model, state, questions }) {
  const stateBytes = Buffer.byteLength(JSON.stringify(state), "utf8");
  const entries = Object.entries(questions);
  const perQuestionBytes = entries.reduce((maximum, [id, definition]) => Math.max(maximum,
    Buffer.byteLength(JSON.stringify({ model, state, questions: { [id]: definition } }), "utf8")), stateBytes);
  const requestBytes = Buffer.byteLength(JSON.stringify({ model, state, questions }), "utf8");
  return { stateBytes, perQuestionBytes, requestBytes, questionCount: entries.length };
}

export function fitsEvaluationBudget(request) {
  const size = measureEvaluationBudget(request);
  return size.stateBytes <= EVALUATION_LIMITS.stateBytes && size.perQuestionBytes <= EVALUATION_LIMITS.perQuestionBytes
    && size.requestBytes <= EVALUATION_LIMITS.requestBytes && size.questionCount <= EVALUATION_LIMITS.questions;
}
