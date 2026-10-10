import { useEffect, useRef, useState } from "react";
import { ChatExecutions } from "./chatExecution";
import type { AgentStepEvent } from "./chatStream";
import type { AgentRunStep } from "../types";

/** Live agent progress for a running request; cleared when the request ends. */
export interface AgentProgress {
  steps: AgentRunStep[];
  spentMicros?: number;
}

export function useChatStreams(onDelta: ConstructorParameters<typeof ChatExecutions>[0]["onDelta"], onExecution?: ConstructorParameters<typeof ChatExecutions>[0]["onExecution"]) {
  const latestDelta = useRef(onDelta);
  latestDelta.current = onDelta;
  const latestExecution = useRef(onExecution);
  latestExecution.current = onExecution;
  const [pendingConversationIds, setPending] = useState<Record<string, boolean>>({});
  const [agentProgress, setAgentProgress] = useState<Record<string, AgentProgress>>({});
  const [executions] = useState(() => new ChatExecutions({
    onDelta: (...args) => latestDelta.current(...args),
    onExecution: (...args) => latestExecution.current?.(...args),
    onAgentStep(id, event: AgentStepEvent) {
      setAgentProgress((current) => {
        const previous = current[id];
        return { ...current, [id]: { steps: [...(previous?.steps ?? []), event.step].slice(-40), spentMicros: event.spentMicros ?? previous?.spentMicros } };
      });
    },
    onPending(id, pending) {
      setAgentProgress((current) => {
        if (!current[id]) return current;
        const next = { ...current };
        delete next[id];
        return next;
      });
      setPending((current) => {
        if (pending) return { ...current, [id]: true };
        if (!current[id]) return current;
        const next = { ...current };
        delete next[id];
        return next;
      });
    },
  }));
  useEffect(() => () => executions.abortAll(false), [executions]);
  return { executions, pendingConversationIds, agentProgress };
}
