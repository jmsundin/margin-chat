import { HttpError } from "../lib/errors.mjs";
import { createOpenAIAgentToolExecutor, OPENAI_AGENT_TOOL_DEFINITIONS } from "./agentTools.mjs";
import { extractConversationMessages } from "./systemPrompt.mjs";
import {
  extractOpenAIReply,
  requestResponsesApiStream,
  requestOpenAIResponsesPayload,
} from "./providers.mjs";

const MAX_AGENT_TOOL_ROUNDS = 6;

function assertAgentContextBudget(input, instructions, maximum) {
  if (Number.isSafeInteger(maximum) && JSON.stringify({ input, instructions }).length > maximum) {
    throw new HttpError(413, "Workspace tool history exceeded the allowed context budget. Narrow the selected context and try again.");
  }
}

function getResolvedOpenAIModel(model, payload) {
  return typeof payload?.model === "string" && payload.model.trim()
    ? payload.model
    : model;
}

function parseToolArguments(argumentsText) {
  if (typeof argumentsText !== "string" || !argumentsText.trim()) {
    return {};
  }

  try {
    return JSON.parse(argumentsText);
  } catch {
    throw new HttpError(502, "OpenAI returned invalid JSON tool arguments.");
  }
}

export async function requestOpenAIAgentResponse({
  apiKey,
  chatRequest,
  database,
  maxOutputTokens,
  maxInputCharacters,
  model,
  systemInstruction,
  userId,
  signal,
  usageMeter,
}) {
  if (!apiKey) {
    throw new HttpError(
      503,
      "OpenAI API is not configured. Add OPENAI_API_KEY to your environment.",
    );
  }

  if (!userId) {
    throw new HttpError(400, "A signed-in user is required for OpenAI Agent mode.");
  }

  const executeTool = createOpenAIAgentToolExecutor({
    chatRequest,
    database,
    userId,
  });
  const input = extractConversationMessages(chatRequest.messages).map((message) => ({
    content: message.content,
    role: message.role,
  }));
  const steps = [];
  assertAgentContextBudget(input, systemInstruction, maxInputCharacters);
  let responsePayload = await requestOpenAIResponsesPayload({
    apiKey,
    signal,
    usageMeter,
    body: {
      input,
      instructions: systemInstruction,
      max_output_tokens: maxOutputTokens,
      model,
      tools: OPENAI_AGENT_TOOL_DEFINITIONS,
    },
  });

  for (let round = 0; round < MAX_AGENT_TOOL_ROUNDS; round += 1) {
    signal?.throwIfAborted();
    const toolCalls = (responsePayload?.output ?? []).filter(
      (item) => item?.type === "function_call",
    );

    if (!toolCalls.length) {
      const reply = extractOpenAIReply(responsePayload);

      if (!reply) {
        throw new HttpError(
          502,
          "OpenAI Agent returned a response without assistant text.",
        );
      }

      return {
        model: getResolvedOpenAIModel(model, responsePayload),
        reply,
        steps,
      };
    }

    input.push(...responsePayload.output);

    for (const toolCall of toolCalls) {
      signal?.throwIfAborted();
      const args = parseToolArguments(toolCall.arguments);
      const result = await executeTool(toolCall.name, args);

      steps.push({
        arguments: args,
        output: result,
        toolName: toolCall.name,
      });

      input.push({
        type: "function_call_output",
        call_id: toolCall.call_id,
        output: JSON.stringify(result),
      });
    }

    assertAgentContextBudget(input, systemInstruction, maxInputCharacters);
    // Do not buy a seventh response that the six-round loop would discard.
    if (round === MAX_AGENT_TOOL_ROUNDS - 1) break;
    responsePayload = await requestOpenAIResponsesPayload({
      apiKey,
      signal,
      usageMeter,
      body: {
        input,
        instructions: systemInstruction,
        max_output_tokens: maxOutputTokens,
        model,
        tools: OPENAI_AGENT_TOOL_DEFINITIONS,
      },
    });
  }

  throw new HttpError(
    502,
    "OpenAI Agent exceeded the maximum number of tool rounds.",
  );
}

export async function requestOpenAIAgentResponseStream({
  apiKey,
  chatRequest,
  database,
  maxOutputTokens,
  maxInputCharacters,
  model,
  onDelta,
  onReady,
  systemInstruction,
  userId,
  signal,
  usageMeter,
}) {
  if (!apiKey) {
    throw new HttpError(
      503,
      "OpenAI API is not configured. Add OPENAI_API_KEY to your environment.",
    );
  }

  if (!userId) {
    throw new HttpError(400, "A signed-in user is required for OpenAI Agent mode.");
  }

  const executeTool = createOpenAIAgentToolExecutor({
    chatRequest,
    database,
    userId,
  });
  const input = extractConversationMessages(chatRequest.messages).map((message) => ({
    content: message.content,
    role: message.role,
  }));
  const steps = [];
  let ready = false;
  let fullReply = "";

  for (let round = 0; round < MAX_AGENT_TOOL_ROUNDS; round += 1) {
    signal?.throwIfAborted();
    assertAgentContextBudget(input, systemInstruction, maxInputCharacters);
    const result = await requestResponsesApiStream({
      apiKey,
      signal,
      usageMeter,
      body: {
        input,
        instructions: systemInstruction,
        max_output_tokens: maxOutputTokens,
        model,
        tools: OPENAI_AGENT_TOOL_DEFINITIONS,
      },
      fallbackError: "OpenAI Agent request failed.",
      onDelta: async (delta) => {
        fullReply += delta;
        await onDelta?.(delta);
      },
      onReady: async () => {
        if (ready) {
          return;
        }

        ready = true;
        await onReady?.();
      },
      url: "https://api.openai.com/v1/responses",
    });
    const responsePayload = result.completedPayload;

    if (!responsePayload) {
      throw new HttpError(502, "OpenAI Agent stream ended before completion.");
    }

    const toolCalls = (responsePayload.output ?? []).filter(
      (item) => item?.type === "function_call",
    );

    if (!toolCalls.length) {
      if (!fullReply.trim()) {
        throw new HttpError(
          502,
          "OpenAI Agent returned a response without assistant text.",
        );
      }

      return {
        model: getResolvedOpenAIModel(model, responsePayload),
        reply: fullReply,
        steps,
      };
    }

    input.push(...responsePayload.output);

    for (const toolCall of toolCalls) {
      signal?.throwIfAborted();
      const args = parseToolArguments(toolCall.arguments);
      const toolResult = await executeTool(toolCall.name, args);

      steps.push({
        arguments: args,
        output: toolResult,
        toolName: toolCall.name,
      });

      input.push({
        type: "function_call_output",
        call_id: toolCall.call_id,
        output: JSON.stringify(toolResult),
      });
    }
  }

  throw new HttpError(
    502,
    "OpenAI Agent exceeded the maximum number of tool rounds.",
  );
}
