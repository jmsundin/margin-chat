import { HttpError } from "../lib/errors.mjs";
import { extractConversationMessages } from "./systemPrompt.mjs";
import { parseProviderErrorResponse, parseServerSentEvents, parseStreamJson } from "./streaming.mjs";
import { normalizeProviderUsage, runMeteredProviderOperation } from "../billing/usage.mjs";

const outputLimit = (body) => body.max_output_tokens ?? body.max_tokens ?? body.generationConfig?.maxOutputTokens;
function assertKey(apiKey, provider) {
  if (!apiKey) throw new HttpError(503, `${provider} API is not configured. Add a provider API key first.`);
}

export async function requestProviderJson({ apiKey, body, provider, url, signal, usageMeter, kind = "generation", fallbackError = `${provider} request failed.`, headers = {} }) {
  return runMeteredProviderOperation(usageMeter, {
    provider, model: body.model, body, kind, signal,
    maxOutputTokens: kind === "embedding" ? 0 : outputLimit(body),
  }, async (tracker) => {
    signal?.throwIfAborted();
    tracker.markDispatched();
    const response = await fetch(url, {
      body: JSON.stringify(body), method: "POST", signal,
      headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json", ...headers },
    });
    if (!response.ok) tracker.markRejected();
    const payload = await response.json().catch(() => null);
    if (!response.ok) throw new HttpError(response.status, extractApiErrorMessage(payload) ?? fallbackError);
    tracker.recordUsage(payload);
    return payload;
  });
}

export async function requestResponsesApiStream({ apiKey, body, fallbackError, onDelta, onReady, url, signal, usageMeter }) {
  const provider = new URL(url).hostname === "api.x.ai" ? "xai" : "openai";
  const requestBody = { ...body, stream: true };
  return runMeteredProviderOperation(usageMeter, {
    provider, model: body.model, body: requestBody, maxOutputTokens: outputLimit(body), signal,
  }, async (tracker) => {
    signal?.throwIfAborted();
    tracker.markDispatched();
    const response = await fetch(url, {
      body: JSON.stringify(requestBody), headers: { Authorization: `Bearer ${apiKey}`, "Content-Type": "application/json" }, method: "POST", signal,
    });
    if (!response.ok) {
      tracker.markRejected();
      throw new HttpError(response.status, extractApiErrorMessage(await parseProviderErrorResponse(response)) ?? fallbackError);
    }
    await onReady?.();
    let completedPayload = null;
    let reply = "";
    for await (const data of parseServerSentEvents(response.body, signal)) {
      const event = parseStreamJson(data);
      if (!event) continue;
      if ((event.type === "response.output_text.delta" || event.type === "response.refusal.delta") && typeof event.delta === "string") {
        reply += event.delta;
        await onDelta?.(event.delta);
      } else if (event.type === "response.completed") {
        completedPayload = event.response ?? null;
        tracker.recordUsage(completedPayload);
      } else if (["response.failed", "response.incomplete", "error"].includes(event.type)) {
        tracker.recordUsage(event.response ?? event);
        throw new HttpError(502, extractApiErrorMessage(event.response ?? event) ?? fallbackError);
      }
    }
    if (!completedPayload) throw new HttpError(502, `${provider} stream ended before completion.`);
    return { completedPayload, reply, usage: normalizeProviderUsage(provider, completedPayload) };
  });
}

function responsesBody(args, provider) {
  const messages = extractConversationMessages(args.chatRequest.messages).map(({ role, content }) => ({ role, content }));
  return provider === "openai"
    ? { input: messages, instructions: args.systemInstruction, max_output_tokens: args.maxOutputTokens, model: args.model }
    : { input: [{ content: args.systemInstruction, role: "system" }, ...messages], max_output_tokens: args.maxOutputTokens, model: args.model };
}

async function responsesReply(args, provider, stream) {
  assertKey(args.apiKey, provider);
  const body = responsesBody(args, provider);
  const url = provider === "openai" ? "https://api.openai.com/v1/responses" : "https://api.x.ai/v1/responses";
  const result = stream
    ? await requestResponsesApiStream({ ...args, body, url, fallbackError: `${provider} request failed.` })
    : { completedPayload: await requestProviderJson({ ...args, body, url, provider }) };
  const payload = result.completedPayload;
  const reply = stream ? result.reply : extractOpenAIReply(payload);
  if (!reply?.trim()) throw new HttpError(502, `${provider} returned a response without assistant text.`);
  return { model: typeof payload?.model === "string" && payload.model.trim() ? payload.model : args.model, reply, usage: normalizeProviderUsage(provider, payload) };
}

export const requestOpenAIResponse = (args) => responsesReply(args, "openai", false);
export const requestOpenAIResponseStream = (args) => responsesReply(args, "openai", true);
export const requestXAIResponse = (args) => responsesReply(args, "xai", false);
export const requestXAIResponseStream = (args) => responsesReply(args, "xai", true);
export const requestOpenAIResponsesPayload = (args) => requestProviderJson({ ...args, provider: "openai", url: "https://api.openai.com/v1/responses" });

function geminiBody(args) {
  return {
    contents: extractConversationMessages(args.chatRequest.messages).map((message) => ({ parts: [{ text: message.content }], role: message.role === "assistant" ? "model" : "user" })),
    generationConfig: { maxOutputTokens: args.maxOutputTokens, candidateCount: 1 },
    system_instruction: { parts: [{ text: args.systemInstruction }] },
  };
}
function huggingFaceBody(args, stream) {
  return {
    messages: [{ content: args.systemInstruction, role: "system" }, ...extractConversationMessages(args.chatRequest.messages).map(({ content, role }) => ({ content, role }))],
    model: args.model, max_tokens: args.maxOutputTokens,
    ...(stream ? { stream: true, stream_options: { include_usage: true } } : {}),
  };
}
function streamText(provider, payload) {
  if (provider === "gemini") return (payload.candidates?.[0]?.content?.parts ?? []).filter((part) => !part.thought).map((part) => typeof part.text === "string" ? part.text : "").join("");
  const content = payload.choices?.[0]?.delta?.content;
  return typeof content === "string" ? content : Array.isArray(content) ? content.map((part) => typeof part === "string" ? part : typeof part?.text === "string" ? part.text : "").join("") : "";
}

async function otherProviderReply(args, provider, stream) {
  assertKey(args.apiKey, provider);
  const body = provider === "gemini" ? geminiBody(args) : huggingFaceBody(args, stream);
  const url = provider === "gemini"
    ? `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(args.model)}:${stream ? "streamGenerateContent?alt=sse&" : "generateContent?"}key=${encodeURIComponent(args.apiKey)}`
    : "https://router.huggingface.co/v1/chat/completions";
  const description = { provider, model: args.model, body, maxOutputTokens: args.maxOutputTokens, signal: args.signal };
  return runMeteredProviderOperation(args.usageMeter, description, async (tracker) => {
    args.signal?.throwIfAborted();
    tracker.markDispatched();
    const response = await fetch(url, {
      body: JSON.stringify(body), method: "POST", signal: args.signal,
      headers: { "Content-Type": "application/json", ...(provider === "huggingface" ? { Authorization: `Bearer ${args.apiKey}` } : {}) },
    });
    if (!response.ok) {
      tracker.markRejected();
      throw new HttpError(response.status, extractApiErrorMessage(await parseProviderErrorResponse(response)) ?? `${provider} request failed.`);
    }
    let reply = "";
    let resolvedModel = args.model;
    let usage = null;
    if (stream) {
      await args.onReady?.();
      for await (const data of parseServerSentEvents(response.body, args.signal)) {
        const payload = parseStreamJson(data);
        if (!payload) continue;
        if (payload.error) throw new HttpError(502, extractApiErrorMessage(payload) ?? `${provider} request failed.`);
        const model = provider === "gemini" ? payload.modelVersion : payload.model;
        if (typeof model === "string" && model.trim()) resolvedModel = model;
        const reported = normalizeProviderUsage(provider, payload);
        if (reported) {
          usage = reported;
          const complete = provider === "gemini"
            ? Boolean(payload.candidates?.some((candidate) => candidate.finishReason)) || !payload.candidates?.length
            : !payload.choices?.length || payload.choices.some((choice) => choice.finish_reason);
          tracker.recordUsage(payload, Boolean(complete));
        }
        const delta = streamText(provider, payload);
        if (delta) { reply += delta; await args.onDelta?.(delta); }
      }
    } else {
      const payload = await response.json().catch(() => null);
      tracker.recordUsage(payload);
      usage = normalizeProviderUsage(provider, payload);
      reply = provider === "gemini" ? extractGeminiReply(payload) : extractHuggingFaceReply(payload);
      const model = provider === "gemini" ? payload?.modelVersion : payload?.model;
      if (typeof model === "string" && model.trim()) resolvedModel = model;
    }
    if (!reply.trim()) throw new HttpError(502, `${provider} returned a response without assistant text.`);
    return { model: resolvedModel, reply, usage };
  });
}

export const requestGeminiResponse = (args) => otherProviderReply(args, "gemini", false);
export const requestGeminiResponseStream = (args) => otherProviderReply(args, "gemini", true);
export const requestHuggingFaceResponse = (args) => otherProviderReply(args, "huggingface", false);
export const requestHuggingFaceResponseStream = (args) => otherProviderReply(args, "huggingface", true);

export function extractOpenAIReply(payload) {
  if (
    payload &&
    typeof payload.output_text === "string" &&
    payload.output_text.trim()
  ) {
    return payload.output_text.trim();
  }

  const textChunks = [];

  for (const item of payload?.output ?? []) {
    if (item.type !== "message") {
      continue;
    }

    for (const content of item.content ?? []) {
      if (
        (content.type === "output_text" || content.type === "text") &&
        typeof content.text === "string" &&
        content.text.trim()
      ) {
        textChunks.push(content.text.trim());
      }
    }
  }

  return textChunks.join("\n\n").trim();
}

function extractGeminiReply(payload) {
  const parts =
    payload?.candidates?.[0]?.content?.parts
      ?.filter((part) => !part.thought)
      .map((part) => (typeof part.text === "string" ? part.text.trim() : ""))
      .filter(Boolean) ?? [];

  return parts.join("\n\n").trim();
}

function extractHuggingFaceReply(payload) {
  const content = payload?.choices?.[0]?.message?.content;

  if (typeof content === "string" && content.trim()) {
    return content.trim();
  }

  if (!Array.isArray(content)) {
    return "";
  }

  return content
    .map((part) => {
      if (typeof part === "string") {
        return part.trim();
      }

      if (typeof part?.text === "string") {
        return part.text.trim();
      }

      return "";
    })
    .filter(Boolean)
    .join("\n\n")
    .trim();
}

export function extractApiErrorMessage(payload) {
  if (typeof payload?.error === "string" && payload.error) {
    return payload.error;
  }

  if (
    typeof payload?.error?.message === "string" &&
    payload.error.message
  ) {
    return payload.error.message;
  }

  const nestedErrorMessage = payload?.errors
    ?.map((error) =>
      typeof error?.message === "string" && error.message
        ? error.message
        : "",
    )
    ?.find(Boolean);

  if (nestedErrorMessage) {
    return nestedErrorMessage;
  }

  if (typeof payload?.message === "string" && payload.message) {
    return payload.message;
  }

  return null;
}
