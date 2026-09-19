const record = (value) => value !== null && typeof value === "object" && !Array.isArray(value);
export const probability = (value) => typeof value === "number" && Number.isFinite(value) && value >= 0 && value <= 1;

export function answerFor(result, id, definition, minimumConfidence = 0.55) {
  const answer = result?.answers?.[id];
  if (!record(answer) || !definition || answer.type !== definition.type) return null;
  // Noul is a yes-probability, NOT a Score and has no confidence property.
  if (definition.type === "noul") return probability(answer.noul) ? answer : null;
  if (!probability(answer.confidence) || answer.confidence < minimumConfidence) return null;
  if (definition.type === "choice") return typeof answer.choice === "string" && record(definition.criteria)
    && Object.hasOwn(definition.criteria, answer.choice) ? answer : null;
  if (definition.type === "score") return Array.isArray(definition.criteria) && definition.criteria.length >= 2
    && typeof answer.score === "number" && Number.isFinite(answer.score)
    && answer.score >= 0 && answer.score <= definition.criteria.length - 1 ? answer : null;
  return null;
}

/** Preserve bounded numeric diagnostics without retaining arbitrary vendor fields. */
export function sanitizeAnswers(data, questions) {
  const answers = Object.create(null);
  for (const [id, definition] of Object.entries(questions)) {
    const answer = answerFor(data, id, definition, 0);
    if (!answer) continue;
    if (definition.type === "noul") { answers[id] = { type: "noul", noul: answer.noul }; continue; }
    const clean = definition.type === "choice"
      ? { type: "choice", choice: answer.choice, confidence: answer.confidence }
      : { type: "score", score: answer.score, confidence: answer.confidence };
    const keys = definition.type === "choice" ? Object.keys(definition.criteria) : definition.criteria.map((_, index) => String(index));
    if (keys.length <= 64 && record(answer.probabilities) && keys.every((key) => probability(answer.probabilities[key]))
      && Math.abs(keys.reduce((sum, key) => sum + answer.probabilities[key], 0) - 1) < 0.001) {
      clean.probabilities = Object.fromEntries(keys.map((key) => [key, answer.probabilities[key]]));
    }
    answers[id] = clean;
  }
  return answers;
}
