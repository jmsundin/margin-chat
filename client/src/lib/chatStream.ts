import type { BackendServiceId } from "../types";
import { ApiError } from "./apiError";
import { normalizeAIExecution } from "@margin-chat/workspace-contracts";
import { normalizeAgentStep } from "@margin-chat/workspace-contracts";
import type { AgentRunStep, AIExecutionRecord } from "../types";

export interface ChatReplyResponse {
  metadata: {
    credentialSource?: "hosted" | "personal";
    model: string;
    requestedModelId?: string;
    requestedServiceId: BackendServiceId;
    resolvedServiceId: BackendServiceId;
    execution?: AIExecutionRecord;
  };
  reply: string;
}

/** One live agent step, with the run's settled spend so far when it is metered. */
export interface AgentStepEvent {
  step: AgentRunStep;
  spentMicros?: number;
}

interface ChatStreamEvent {
  delta?: string;
  step?: unknown;
  spentMicros?: unknown;
  error?: string;
  metadata?: ChatReplyResponse["metadata"];
  statusCode?: number;
  type?: "metadata" | "delta" | "step" | "done" | "error";
}

export async function readChatReplyStream(
  body: ReadableStream<Uint8Array>,
  onDelta?: (delta: string) => void,
  onMetadata?: (metadata: ChatReplyResponse["metadata"]) => void,
  onStep?: (event: AgentStepEvent) => void,
): Promise<ChatReplyResponse> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  let metadata: ChatReplyResponse["metadata"] | null = null;
  let reply = "";
  let completed = false;

  const handleLine = (line: string) => {
    if (!line.trim()) {
      return;
    }

    let event: ChatStreamEvent;

    try {
      event = JSON.parse(line) as ChatStreamEvent;
    } catch {
      throw new Error("Backend returned an invalid assistant stream event.");
    }

    if (event.type === "error") {
      throw new ApiError(
        typeof event.statusCode === "number" ? event.statusCode : 502,
        event.error || "The model stream ended unexpectedly.",
      );
    }

    if (event.metadata) {
      metadata = { ...event.metadata, execution: normalizeAIExecution(event.metadata.execution) };
      onMetadata?.(metadata);
    }

    if (event.type === "delta" && typeof event.delta === "string") {
      reply += event.delta;
      onDelta?.(event.delta);
    }
    if (event.type === "step") {
      const step = normalizeAgentStep(event.step);
      const spentMicros = Number.isSafeInteger(event.spentMicros) && (event.spentMicros as number) >= 0 ? event.spentMicros as number : undefined;
      if (step) onStep?.({ step, ...(spentMicros === undefined ? {} : { spentMicros }) });
    }
    if (event.type === "done") completed = true;
  };

  try {
    while (true) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value, { stream: !done });
      const lines = buffer.split("\n");
      buffer = lines.pop() ?? "";

      for (const line of lines) {
        handleLine(line);
      }

      if (done) {
        break;
      }
    }

    if (buffer.trim()) {
      handleLine(buffer);
    }

    if (!metadata || !reply.trim()) {
      throw new Error("Backend returned an empty assistant reply.");
    }
    if (!completed) {
      throw new Error("The assistant stream ended before the reply was complete.");
    }

    return { metadata, reply };
  } catch (error) {
    // Stop consuming the response without replacing the original failure.
    await reader.cancel(error).catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}
