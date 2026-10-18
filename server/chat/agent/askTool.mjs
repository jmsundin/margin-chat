/** Agent tool for a clarifying question. Calling it ends the run with the question as the reply and its
 * options on the run's record; the app shows them with a box for the answer, which starts the agent again. */
export const ASK_TOOL_DEFINITION = {
  name: "ask_user",
  description: "Ask the user one short clarifying question, then stop. Use it only when you still can't tell what they want after checking what your tools can find, and a wrong guess would waste the run: which of several documents they mean, which of two quite different tasks they want, or a detail only they know. Never ask about something you could look up, and never ask permission to use your tools. The user's answer arrives as their next message.",
  parameters: { type: "object", properties: {
    question: { type: "string", description: "One short question, in the user's language." },
    options: { type: "array", items: { type: "string" }, description: "Two to four short likely answers the user can pick from, or an empty list when the answer is open-ended." },
  }, required: ["question", "options"], additionalProperties: false },
};

const QUESTION_CHARACTERS = 500;
const OPTION_CHARACTERS = 120;
const MAX_OPTIONS = 4;

const tidy = (value, maximum) => {
  const text = typeof value === "string" ? value.replace(/\s+/gu, " ").trim() : "";
  return text.length <= maximum ? text : `${text.slice(0, maximum - 1)}…`;
};

/** The question and its options as the run's record, or null when the model sent no question. The
 * question is one paragraph, so it stays a single block where the app writes it into a document. */
export function agentQuestion(args = {}) {
  const text = tidy(args.question, QUESTION_CHARACTERS);
  if (!text) return null;
  const options = [...new Set((Array.isArray(args.options) ? args.options : []).map((option) => tidy(option, OPTION_CHARACTERS)).filter(Boolean))].slice(0, MAX_OPTIONS);
  return { text, options };
}
