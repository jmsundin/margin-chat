import { HttpError } from "../../lib/errors.mjs";
import { RESPONSES_URLS, anthropicBody, extractOpenAIReply, requestAnthropicMessage, requestResponsesApiStream } from "../providers.mjs";
import { extractConversationMessages } from "../systemPrompt.mjs";
import { parsePartialJson } from "./partialJson.mjs";

/** Providers whose APIs can call tools. Gemini and Hugging Face answer without them. */
export const AGENT_PROVIDERS = Object.freeze(["openai", "xai", "anthropic", "meta"]);

const isRecord = (value) => Boolean(value) && typeof value === "object" && !Array.isArray(value);

/**
 * A tool call's arguments. A call cut off at the output limit arrives as unfinished JSON: it keeps
 * what it finished and is marked `cutOff`, so the run can use that or tell the model to send less.
 */
function parseArguments(text, provider, { incomplete = false } = {}) {
  if (typeof text !== "string" || !text.trim()) return { arguments: {} };
  try {
    const value = JSON.parse(text);
    return { arguments: isRecord(value) ? value : {} };
  } catch {
    if (!incomplete) throw new HttpError(502, `${provider} returned invalid JSON tool arguments.`);
    const partial = parsePartialJson(text);
    return { arguments: isRecord(partial) ? partial : {}, cutOff: true };
  }
}

const withExtra = (instruction, extra) => extra ? `${instruction}\n\n${extra}` : instruction;

/** Muse Wonder always reasons and otherwise picks its own effort, so agent runs set it from the AI mode.
 * Its "auto" reasoning summaries are often empty, so agent runs ask for "detailed" ones to show while it works. */
const META_REASONING_EFFORT = { fast: "low", balanced: "medium", thorough: "high" };
/** How much of each page Meta's web search hands the model, by AI mode. */
const META_SEARCH_CONTEXT = { fast: "low", balanced: "medium", thorough: "high" };

/** Providers whose built-in web search the agent can offer. Searches run on the provider's side, inside a model call. */
export const WEB_SEARCH_PROVIDERS = Object.freeze(["meta", "anthropic", "xai"]);
/** Providers that can search posts on X (Twitter) inside a model call. */
export const X_SEARCH_PROVIDERS = Object.freeze(["xai"]);
/** Grok's built-in tools are capped by rounds of searching, not by searches: each call may search for
 * this many rounds before it answers or calls one of our tools. The usage meter reserves for it. */
export const XAI_SEARCH_TURNS = 2;
/** Claude's searches and page reads per model call. The tool list must stay the same for a whole run
 * (Claude ties its thinking to it), so this is fixed and the run's allowance is kept by the runner. */
export const ANTHROPIC_SEARCHES_PER_CALL = 3;
/** The most of one page Claude's web_fetch puts into the conversation. */
export const ANTHROPIC_FETCH_TOKENS = 20_000;
/** Grok's X searches come back as custom tool calls whose ids start with this. */
const X_SEARCH_CALL = /^xs_/u;

/** Models that refused a reasoning summary request in this process, so later calls don't ask again.
 * OpenAI and Meta are asked; xAI may reject the setting, and reasoning text xAI does return is still shown. */
const summaryRefused = new Set();
const refusesSummary = (error) => [400, 403].includes(error?.statusCode) && /summar/iu.test(error?.message ?? "");

/** Joins reasoning text pieces as paragraphs. */
const paragraphs = (pieces) => pieces.map((piece) => piece.trim()).filter(Boolean).join("\n\n");

/** A Responses reasoning item's readable text: its summary, or reasoning text where a model shares it. */
function reasoningText(output) {
  return paragraphs(output.filter((item) => item?.type === "reasoning").flatMap((item) => [
    ...(Array.isArray(item.summary) ? item.summary : []), ...(Array.isArray(item.content) ? item.content : []),
  ]).filter((part) => ["summary_text", "reasoning_text"].includes(part?.type) && typeof part.text === "string").map((part) => part.text));
}

/** The searches one call's built-in web search ran, by query where the provider reports it. */
function webSearches(output) {
  return output.filter((item) => item?.type === "web_search_call").map((item) => {
    const query = [item.action?.query, ...(Array.isArray(item.action?.queries) ? item.action.queries : [])].find((value) => typeof value === "string" && value.trim());
    return { query: query?.trim() ?? null, ok: item.status !== "failed" };
  });
}

/** X searches Grok ran in one call, by query where it reports one. */
function xSearches(output) {
  return output.filter(isXSearchCall).map((item) => {
    let query = null;
    try { const value = JSON.parse(item.input ?? item.arguments ?? "{}"); query = [value?.query, value?.keywords, value?.name].find((part) => typeof part === "string" && part.trim()) ?? null; } catch { /* no query */ }
    return { kind: "x", query: query?.trim() ?? null, ok: item.status !== "failed" };
  });
}
const isXSearchCall = (item) => item?.type === "custom_tool_call" && X_SEARCH_CALL.test(String(item.call_id ?? ""));
/** Output items xAI ran on its own side. They're dropped from the history sent back, since xAI
 * returns no results for them to pair with. */
const isXAIServerCall = (item) => ["web_search_call", "code_interpreter_call", "file_search_call", "mcp_call"].includes(item?.type) || isXSearchCall(item);

/** Web pages the call's text cites, from its url_citation annotations. */
function citedPages(output) {
  return output.filter((item) => item?.type === "message" && Array.isArray(item.content))
    .flatMap((item) => item.content).flatMap((part) => Array.isArray(part?.annotations) ? part.annotations : [])
    .filter((annotation) => annotation?.type === "url_citation" && typeof annotation.url === "string")
    .map((annotation) => ({ url: annotation.url, title: typeof annotation.title === "string" ? annotation.title : "" }));
}

/** What stands in for a tool result dropped from the history to make room. */
const DROPPED_RESULT = JSON.stringify({ note: "This result was dropped from the history to save room. Work from what you already took from it." });
const CLIPPED_STRING = 120;
/** A tool call's arguments with long strings shortened: the call's shape stays, its prose goes. */
function clipStrings(value) {
  if (typeof value === "string") return value.length > CLIPPED_STRING ? `${value.slice(0, CLIPPED_STRING - 1)}…` : value;
  if (Array.isArray(value)) return value.map(clipStrings);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([key, item]) => [key, clipStrings(item)]));
  return value;
}

/**
 * Shrinks a run's history until `fits()`: first the prose inside tool calls the model already made and had
 * answered (a proposed roadmap's notes, a drafted document), then whole tool results, oldest first.
 * The model's own turns and its reasoning stay, since providers reject a history with those removed.
 */
function makeRoom(fits, calls, results) {
  for (const shorten of calls) { if (fits()) return true; shorten(); }
  for (const drop of results) { if (fits()) return true; drop(); }
  return fits();
}

/**
 * OpenAI, xAI and Meta share the Responses API: function_call items in, function_call_output items back.
 * Each call streams so the model's reasoning summary, or any reasoning text it shares, reaches
 * `live.thinking` and its text reaches `live.text` as they are written. With `args.webSearch`, Meta's
 * calls that may use tools also offer its built-in web_search, capped at `webSearches` searches.
 */
function createResponsesAdapter(provider, args, tools) {
  const messages = extractConversationMessages(args.chatRequest.messages).map(({ role, content }) => ({ role, content }));
  const input = provider === "xai" ? [{ role: "system", content: args.systemInstruction }, ...messages] : messages;
  const definitions = tools.map((tool) => ({ type: "function", strict: true, ...tool }));
  const summaryKey = `${provider}:${args.model}`;
  const asksSummary = provider === "openai" || provider === "meta";
  const effort = provider === "meta" ? META_REASONING_EFFORT[args.chatRequest.ai?.mode] ?? "medium" : null;
  const searchTools = !args.webSearch || !WEB_SEARCH_PROVIDERS.includes(provider) ? null
    : provider === "meta" ? [{ type: "web_search", search_context_size: META_SEARCH_CONTEXT[args.chatRequest.ai?.mode] ?? "medium" }]
    : [{ type: "web_search" }, ...(args.xSearch && X_SEARCH_PROVIDERS.includes(provider) ? [{ type: "x_search" }] : [])];
  return {
    get size() { return JSON.stringify({ input, instructions: args.systemInstruction }).length; },
    async call({ allowTools, extraInstruction, live = {}, webSearches: searchesLeft = 0 }) {
      if (provider === "xai") input[0] = { role: "system", content: withExtra(args.systemInstruction, extraInstruction) };
      const search = allowTools && searchTools && searchesLeft > 0;
      const body = {
        model: args.model,
        input: [...input],
        ...(provider !== "xai" ? { instructions: withExtra(args.systemInstruction, extraInstruction) } : {}),
        max_output_tokens: args.maxOutputTokens,
        // Meta accepts only tool_choice "auto", so its last call goes without tools instead.
        ...(provider === "meta"
          ? allowTools ? { tools: search ? [...definitions, ...searchTools] : definitions, tool_choice: "auto" } : {}
          : { tools: search ? [...definitions, ...searchTools] : definitions, tool_choice: allowTools ? "auto" : "none" }),
        // max_tool_calls counts only built-in tools, so it caps searches and leaves function calls alone.
        // xAI caps rounds of built-in tool use instead.
        ...(search ? provider === "xai" ? { max_turns: XAI_SEARCH_TURNS } : { max_tool_calls: searchesLeft } : {}),
      };
      let thinking = false;
      let writing = false;
      // Tool calls being written, by output item: their arguments stream in as text.
      const drafting = new Map();
      const onEvent = async (event) => {
        if (event.type === "response.function_call_arguments.delta" && typeof event.delta === "string" && drafting.has(event.item_id)) {
          const call = drafting.get(event.item_id);
          call.text += event.delta;
          await live.toolArguments?.(call.name, call.text);
        } else if (["response.reasoning_summary_text.delta", "response.reasoning_text.delta"].includes(event.type) && typeof event.delta === "string") {
          await live.thinking?.(event.delta);
          thinking = true;
        } else if (event.type === "response.reasoning_summary_part.added" && thinking) {
          await live.thinking?.("\n\n");
        } else if (event.type === "response.output_text.delta" && typeof event.delta === "string") {
          if (!writing) await live.writing?.();
          writing = true;
          await live.text?.(event.delta);
        } else if (event.type === "response.output_item.added" && event.item?.type === "function_call" && typeof event.item.name === "string") {
          if (typeof event.item.id === "string") drafting.set(event.item.id, { name: event.item.name, text: "" });
          await live.tool?.(event.item.name);
        } else if (event.type === "response.output_item.done" && event.item?.type === "web_search_call") {
          // The finished search names its query, which the in-progress events don't.
          const query = [event.item.action?.query, ...(Array.isArray(event.item.action?.queries) ? event.item.action.queries : [])].find((value) => typeof value === "string" && value.trim());
          if (!writing) await live.searching?.(query?.trim());
        } else if (event.type === "response.output_item.done" && isXSearchCall(event.item)) {
          if (!writing) await live.searching?.(xSearches([event.item])[0]?.query ?? undefined, "X");
        } else if (typeof event.type === "string" && event.type.startsWith("response.web_search_call.") && !writing) {
          await live.searching?.();
        }
      };
      const request = (withSummary) => requestResponsesApiStream({
        apiKey: args.apiKey, url: RESPONSES_URLS[provider],
        body: withSummary || effort ? { ...body, reasoning: { ...(effort ? { effort } : {}), ...(withSummary ? { summary: provider === "meta" ? "detailed" : "auto" } : {}) } } : body,
        signal: args.signal, usageMeter: args.usageMeter, onEvent, acceptIncomplete: true, fallbackError: `${provider} request failed.`,
      });
      let result;
      try {
        result = await request(asksSummary && !summaryRefused.has(summaryKey));
      } catch (error) {
        // Some models or accounts can't return reasoning summaries; answer without them.
        if (!asksSummary || summaryRefused.has(summaryKey) || !refusesSummary(error)) throw error;
        summaryRefused.add(summaryKey);
        result = await request(false);
      }
      const payload = result.completedPayload;
      const output = Array.isArray(payload?.output) ? payload.output : [];
      // A response that ran out of output tokens can end inside a tool call's arguments.
      const incomplete = payload?.status === "incomplete";
      input.push(...output.filter((item) => provider !== "xai" || !isXAIServerCall(item)).map((item) => {
        if (item?.type !== "function_call" || !incomplete) return item;
        // The history must hold valid JSON for the provider to accept the next call.
        try { JSON.parse(item.arguments); return item; } catch { return { ...item, arguments: JSON.stringify(parseArguments(item.arguments, provider, { incomplete }).arguments) }; }
      }));
      return {
        model: typeof payload?.model === "string" && payload.model.trim() ? payload.model : args.model,
        text: extractOpenAIReply(payload),
        thinking: reasoningText(output),
        searches: [...webSearches(output), ...xSearches(output)],
        sources: citedPages(output),
        toolCalls: output.filter((item) => item?.type === "function_call")
          .map((item) => ({ id: item.call_id, name: item.name, ...parseArguments(item.arguments, provider, { incomplete }) })),
      };
    },
    addToolResults(results) {
      for (const result of results) input.push({ type: "function_call_output", call_id: result.id, output: JSON.stringify(result.output) });
    },
    compact(limit) {
      const answered = new Set(input.filter((item) => item?.type === "function_call_output").map((item) => item.call_id));
      const replace = (item, change) => () => { input[input.indexOf(item)] = { ...item, ...change(item) }; };
      return makeRoom(() => this.size <= limit,
        input.filter((item) => item?.type === "function_call" && answered.has(item.call_id) && item.arguments?.length > CLIPPED_STRING * 2)
          .map((item) => replace(item, () => { try { return { arguments: JSON.stringify(clipStrings(JSON.parse(item.arguments))) }; } catch { return {}; } })),
        input.filter((item) => item?.type === "function_call_output" && item.output.length > DROPPED_RESULT.length)
          .map((item) => replace(item, () => ({ output: DROPPED_RESULT }))));
    },
  };
}

/** Claude's Messages API: tool_use blocks in, tool_result blocks back in the next user turn. The
 * assistant content is replayed unchanged so thinking blocks stay attached to their tool calls.
 * Claude 5 models hide thinking unless asked, so the agent asks for the summarized form and
 * streams it to `live.thinking`; text streams to `live.text`. With `args.webSearch`, every call
 * also offers Claude's own web_search and web_fetch, which run on Anthropic's side. The request
 * asks for prompt caching, so each call pays a tenth of the price for the history it repeats. */
function createAnthropicAdapter(args, tools) {
  const base = { ...anthropicBody(args), thinking: { type: "adaptive", display: "summarized" }, cache_control: { type: "ephemeral" } };
  const messages = [...base.messages];
  const definitions = [
    ...tools.map(({ name, description, parameters }) => ({ name, description, input_schema: parameters })),
    ...(args.webSearch ? [
      { type: "web_search_20260209", name: "web_search", max_uses: ANTHROPIC_SEARCHES_PER_CALL },
      { type: "web_fetch_20260209", name: "web_fetch", max_uses: ANTHROPIC_SEARCHES_PER_CALL, max_content_tokens: ANTHROPIC_FETCH_TOKENS },
    ] : []),
  ];
  return {
    get size() { return JSON.stringify({ messages, system: args.systemInstruction }).length; },
    async call({ allowTools, extraInstruction, live = {} }) {
      let thinking = false;
      let writing = false;
      const drafting = new Map();
      const onEvent = async (event) => {
        if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta" && typeof event.delta.partial_json === "string" && drafting.has(event.index)) {
          const call = drafting.get(event.index);
          call.text += event.delta.partial_json;
          await live.toolArguments?.(call.name, call.text);
        } else if (event.type === "content_block_start" && event.content_block?.type === "thinking" && thinking) {
          await live.thinking?.("\n\n");
        } else if (event.type === "content_block_delta" && event.delta?.type === "thinking_delta" && event.delta.thinking) {
          await live.thinking?.(event.delta.thinking);
          thinking = true;
        } else if (event.type === "content_block_start" && event.content_block?.type === "text" && !writing) {
          writing = true;
          await live.writing?.();
        } else if (event.type === "content_block_start" && event.content_block?.type === "tool_use" && typeof event.content_block.name === "string") {
          drafting.set(event.index, { name: event.content_block.name, text: "" });
          await live.tool?.(event.content_block.name);
        } else if (event.type === "content_block_start" && event.content_block?.type === "server_tool_use") {
          if (event.content_block.name === "web_fetch") await live.reading?.();
          else await live.searching?.();
        } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta" && event.delta.text) {
          await live.text?.(event.delta.text);
        }
      };
      // Claude runs its own searches in a loop on Anthropic's side; a long one pauses the turn, and
      // sending the conversation back as it stands lets it carry on.
      const content = [];
      let message;
      for (let resumed = 0; resumed <= ANTHROPIC_PAUSE_RESUMES; resumed += 1) {
        const body = { ...base, system: withExtra(args.systemInstruction, extraInstruction), messages: [...messages],
          tools: definitions, tool_choice: { type: allowTools ? "auto" : "none" } };
        message = await requestAnthropicMessage({ apiKey: args.apiKey, body, signal: args.signal, usageMeter: args.usageMeter, onEvent });
        const blocks = Array.isArray(message?.content) ? message.content : [];
        content.push(...blocks);
        // A paused turn continues the same assistant message, so its parts are replayed as one.
        const last = messages.at(-1);
        if (resumed > 0 && last?.role === "assistant") last.content = [...last.content, ...blocks];
        else messages.push({ role: "assistant", content: blocks });
        if (message?.stop_reason !== "pause_turn") break;
      }
      return {
        model: typeof message?.model === "string" && message.model.trim() ? message.model : args.model,
        text: content.filter((block) => block.type === "text" && typeof block.text === "string").map((block) => block.text).join("").trim(),
        thinking: paragraphs(content.filter((block) => block.type === "thinking" && typeof block.thinking === "string").map((block) => block.thinking)),
        searches: claudeSearches(content),
        sources: claudeCitations(content),
        toolCalls: content.filter((block) => block.type === "tool_use")
          .map((block) => ({ id: block.id, name: block.name, arguments: block.input && typeof block.input === "object" ? block.input : {} })),
      };
    },
    addToolResults(results) {
      messages.push({ role: "user", content: results.map((result) => ({
        type: "tool_result", tool_use_id: result.id, content: JSON.stringify(result.output),
      })) });
    },
    compact(limit) {
      const blocks = (role, type) => messages.filter((message) => message.role === role && Array.isArray(message.content))
        .flatMap((message) => message.content.map((block, index) => ({ block, index, content: message.content })).filter(({ block }) => block?.type === type));
      const answered = new Set(blocks("user", "tool_result").map(({ block }) => block.tool_use_id));
      return makeRoom(() => this.size <= limit,
        blocks("assistant", "tool_use").filter(({ block }) => answered.has(block.id) && JSON.stringify(block.input ?? {}).length > CLIPPED_STRING * 2)
          .map(({ block, index, content }) => () => { content[index] = { ...block, input: clipStrings(block.input) }; }),
        blocks("user", "tool_result").filter(({ block }) => typeof block.content === "string" && block.content.length > DROPPED_RESULT.length)
          .map(({ block, index, content }) => () => { content[index] = { ...block, content: DROPPED_RESULT }; }));
    },
  };
}

/** How many times one agent call carries on a turn Claude paused in the middle of its own searching. */
const ANTHROPIC_PAUSE_RESUMES = 2;

/** Searches and page reads Claude ran on Anthropic's side in one call. A failed one comes back as a
 * result whose content is an error object instead of a list or a page. */
function claudeSearches(content) {
  const results = new Map(content.filter((block) => ["web_search_tool_result", "web_fetch_tool_result"].includes(block?.type))
    .map((block) => [block.tool_use_id, block.content]));
  return content.filter((block) => block?.type === "server_tool_use" && ["web_search", "web_fetch"].includes(block.name)).map((block) => {
    const result = results.get(block.id);
    const failed = !result || (typeof result === "object" && !Array.isArray(result) && typeof result.error_code === "string");
    const fetched = block.name === "web_fetch";
    const query = fetched ? block.input?.url : block.input?.query;
    return { ...(fetched ? { kind: "fetch" } : {}), query: typeof query === "string" && query.trim() ? query.trim() : null, ok: !failed };
  });
}

/** Web pages Claude's text cites, from its web search citations. */
function claudeCitations(content) {
  return content.filter((block) => block?.type === "text" && Array.isArray(block.citations)).flatMap((block) => block.citations)
    .filter((citation) => ["web_search_result_location", "web_fetch_result_location", "url_citation"].includes(citation?.type) && typeof citation.url === "string")
    .map((citation) => ({ url: citation.url, title: typeof citation.title === "string" ? citation.title : "" }));
}

export function createAgentAdapter(provider, args, tools) {
  if (provider === "openai" || provider === "xai" || provider === "meta") return createResponsesAdapter(provider, args, tools);
  if (provider === "anthropic") return createAnthropicAdapter(args, tools);
  throw new HttpError(400, `Agent mode is not available for ${provider}.`);
}
