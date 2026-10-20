import type { BackendServiceId } from "../types";
import { ApiError } from "./apiError";
import { normalizeAIExecution, normalizeAgentStep } from "@margin-chat/workspace-contracts";
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

/** What the agent is doing right now: a model call thinking, a web search, a tool running, or the answer being written. */
export type AgentActivity = "thinking" | "searching" | "tool" | "writing";
const AGENT_ACTIVITIES: AgentActivity[] = ["thinking", "searching", "tool", "writing"];

/**
 * Live agent progress: a finished step (with the run's settled spend so far when
 * it is metered), a piece of the model's thinking as it streams, the model
 * starting to write text, or the text streamed since the last retract being
 * withdrawn because the model went on to call tools instead of answering.
 */
export type AgentEvent =
  | { type: "step"; step: AgentRunStep; spentMicros?: number }
  | { type: "retract" }
  | { type: "documents"; documents: ImportedWebDocument[] }
  | { type: "thinking"; delta: string }
  | { type: "activity"; activity: AgentActivity; label?: string };

/** A page the agent saved with import_webpage, for the browser to create as a document. */
export interface ImportedWebDocument {
  url: string;
  /** The saved page that links to this one; null for the page the user pasted. */
  parentUrl: string | null;
  title: string;
  markdown: string;
}

function importedWebDocuments(input: unknown): ImportedWebDocument[] {
  if (!Array.isArray(input)) return [];
  return input.flatMap((item) => {
    if (!item || typeof item !== "object") return [];
    const { url, parentUrl, title, markdown } = item as Record<string, unknown>;
    if (typeof url !== "string" || !/^https?:\/\//u.test(url) || typeof markdown !== "string") return [];
    return [{ url, parentUrl: typeof parentUrl === "string" ? parentUrl : null,
      title: typeof title === "string" && title.trim() ? title.trim().slice(0, 240) : url, markdown }];
  });
}

interface ChatStreamEvent {
  documents?: unknown;
  delta?: string;
  step?: unknown;
  spentMicros?: unknown;
  activity?: unknown;
  label?: unknown;
  error?: string;
  metadata?: ChatReplyResponse["metadata"];
  statusCode?: number;
  type?: "metadata" | "delta" | "retract" | "step" | "thinking" | "activity" | "documents" | "done" | "error";
}

export async function readChatReplyStream(
  body: ReadableStream<Uint8Array>,
  onDelta?: (delta: string) => void,
  onMetadata?: (metadata: ChatReplyResponse["metadata"]) => void,
  onAgentEvent?: (event: AgentEvent) => void,
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
    if (event.type === "retract") {
      reply = "";
      onAgentEvent?.({ type: "retract" });
    }
    if (event.type === "step") {
      const step = normalizeAgentStep(event.step);
      const spentMicros = Number.isSafeInteger(event.spentMicros) && (event.spentMicros as number) >= 0 ? event.spentMicros as number : undefined;
      if (step) onAgentEvent?.({ type: "step", step, ...(spentMicros === undefined ? {} : { spentMicros }) });
    }
    if (event.type === "thinking" && typeof event.delta === "string" && event.delta) onAgentEvent?.({ type: "thinking", delta: event.delta });
    if (event.type === "activity" && AGENT_ACTIVITIES.includes(event.activity as AgentActivity)) {
      const label = typeof event.label === "string" && event.label.trim() ? event.label.trim().slice(0, 200) : undefined;
      onAgentEvent?.({ type: "activity", activity: event.activity as AgentActivity, ...(label ? { label } : {}) });
    }
    if (event.type === "documents") {
      const documents = importedWebDocuments(event.documents);
      if (documents.length) onAgentEvent?.({ type: "documents", documents });
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
