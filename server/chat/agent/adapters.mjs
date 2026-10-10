import { HttpError } from "../../lib/errors.mjs";
import { anthropicBody, extractOpenAIReply, requestAnthropicMessage, requestProviderJson } from "../providers.mjs";
import { extractConversationMessages } from "../systemPrompt.mjs";

/** Providers whose APIs can call tools. Gemini and Hugging Face answer without them. */
export const AGENT_PROVIDERS = Object.freeze(["openai", "xai", "anthropic"]);

const RESPONSES_URLS = { openai: "https://api.openai.com/v1/responses", xai: "https://api.x.ai/v1/responses" };

function parseArguments(text, provider) {
  if (typeof text !== "string" || !text.trim()) return {};
  try {
    const value = JSON.parse(text);
    return value && typeof value === "object" && !Array.isArray(value) ? value : {};
  } catch {
    throw new HttpError(502, `${provider} returned invalid JSON tool arguments.`);
  }
}

const withExtra = (instruction, extra) => extra ? `${instruction}\n\n${extra}` : instruction;

/** OpenAI and xAI share the Responses API: function_call items in, function_call_output items back. */
function createResponsesAdapter(provider, args, tools) {
  const messages = extractConversationMessages(args.chatRequest.messages).map(({ role, content }) => ({ role, content }));
  const input = provider === "openai" ? messages : [{ role: "system", content: args.systemInstruction }, ...messages];
  const definitions = tools.map((tool) => ({ type: "function", strict: true, ...tool }));
  return {
    get size() { return JSON.stringify({ input, instructions: args.systemInstruction }).length; },
    async call({ allowTools, extraInstruction }) {
      if (provider === "xai") input[0] = { role: "system", content: withExtra(args.systemInstruction, extraInstruction) };
      const body = {
        model: args.model,
        input: [...input],
        ...(provider === "openai" ? { instructions: withExtra(args.systemInstruction, extraInstruction) } : {}),
        max_output_tokens: args.maxOutputTokens,
        tools: definitions,
        tool_choice: allowTools ? "auto" : "none",
      };
      const payload = await requestProviderJson({ apiKey: args.apiKey, body, provider, url: RESPONSES_URLS[provider], signal: args.signal, usageMeter: args.usageMeter });
      const output = Array.isArray(payload?.output) ? payload.output : [];
      input.push(...output);
      return {
        model: typeof payload?.model === "string" && payload.model.trim() ? payload.model : args.model,
        text: extractOpenAIReply(payload),
        toolCalls: output.filter((item) => item?.type === "function_call")
          .map((item) => ({ id: item.call_id, name: item.name, arguments: parseArguments(item.arguments, provider) })),
      };
    },
    addToolResults(results) {
      for (const result of results) input.push({ type: "function_call_output", call_id: result.id, output: JSON.stringify(result.output) });
    },
  };
}

/** Claude's Messages API: tool_use blocks in, tool_result blocks back in the next user turn. The
 * assistant content is replayed unchanged so thinking blocks stay attached to their tool calls. */
function createAnthropicAdapter(args, tools) {
  const base = anthropicBody(args);
  const messages = [...base.messages];
  const definitions = tools.map(({ name, description, parameters }) => ({ name, description, input_schema: parameters }));
  return {
    get size() { return JSON.stringify({ messages, system: args.systemInstruction }).length; },
    async call({ allowTools, extraInstruction }) {
      const body = { ...base, system: withExtra(args.systemInstruction, extraInstruction), messages: [...messages],
        tools: definitions, tool_choice: { type: allowTools ? "auto" : "none" } };
      const message = await requestAnthropicMessage({ apiKey: args.apiKey, body, signal: args.signal, usageMeter: args.usageMeter });
      const content = Array.isArray(message?.content) ? message.content : [];
      messages.push({ role: "assistant", content });
      return {
        model: typeof message?.model === "string" && message.model.trim() ? message.model : args.model,
        text: content.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("").trim(),
        toolCalls: content.filter((block) => block.type === "tool_use")
          .map((block) => ({ id: block.id, name: block.name, arguments: block.input && typeof block.input === "object" ? block.input : {} })),
      };
    },
    addToolResults(results) {
      messages.push({ role: "user", content: results.map((result) => ({
        type: "tool_result", tool_use_id: result.id, content: JSON.stringify(result.output),
      })) });
    },
  };
}

export function createAgentAdapter(provider, args, tools) {
  if (provider === "openai" || provider === "xai") return createResponsesAdapter(provider, args, tools);
  if (provider === "anthropic") return createAnthropicAdapter(args, tools);
  throw new HttpError(400, `Agent mode is not available for ${provider}.`);
}
