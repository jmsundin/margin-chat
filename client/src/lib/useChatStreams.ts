import { useEffect, useRef, useState } from "react";
import { ChatExecutions } from "./chatExecution";
import type { AgentActivity, AgentEvent } from "./chatStream";
import type { AgentRunStep } from "../types";

/** Live agent progress for a running request; cleared when the request ends. */
export interface AgentProgress {
  steps: AgentRunStep[];
  spentMicros?: number;
  /** The current model call's thinking so far, until the call ends and it arrives as a step. */
  thinking?: string;
  /** What the agent is doing right now, and the server's words for it ("Searching your vault for “pricing”"). */
  activity?: AgentActivity;
  label?: string;
  /** When the current activity began, for how long it has been going. */
  since?: number;
}

const LIVE_STEPS = 60;
const LIVE_THINKING_CHARACTERS = 20_000;
/** Thinking streams in small pieces; they are shown in batches so the workspace doesn't re-render for each one. */
const THINKING_FLUSH_MS = 100;

type ExecutionEvents = ConstructorParameters<typeof ChatExecutions>[0];

export function useChatStreams(onDelta: ExecutionEvents["onDelta"], onExecution?: ExecutionEvents["onExecution"], onRetract?: ExecutionEvents["onRetract"]) {
  const latestDelta = useRef(onDelta);
  latestDelta.current = onDelta;
  const latestRetract = useRef(onRetract);
  latestRetract.current = onRetract;
  const latestExecution = useRef(onExecution);
  latestExecution.current = onExecution;
  const pendingThinking = useRef(new Map<string, string>());
  const thinkingTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const [pendingConversationIds, setPending] = useState<Record<string, boolean>>({});
  const [agentProgress, setAgentProgress] = useState<Record<string, AgentProgress>>({});
  const [executions] = useState(() => {
    const flushThinking = () => {
      clearTimeout(thinkingTimer.current);
      thinkingTimer.current = undefined;
      if (!pendingThinking.current.size) return;
      const pending = [...pendingThinking.current];
      pendingThinking.current.clear();
      setAgentProgress((current) => {
        const next = { ...current };
        for (const [id, text] of pending) {
          const previous = next[id] ?? { steps: [] };
          const continuing = previous.activity === "thinking";
          next[id] = { ...previous, activity: "thinking", label: continuing ? previous.label : undefined, since: continuing ? previous.since : Date.now(),
            thinking: `${previous.thinking ?? ""}${text}`.slice(-LIVE_THINKING_CHARACTERS) };
        }
        return next;
      });
    };
    return new ChatExecutions({
      onDelta: (...args) => latestDelta.current(...args),
      onRetract: (...args) => latestRetract.current?.(...args),
      onExecution: (...args) => latestExecution.current?.(...args),
      onAgentEvent(id, event: AgentEvent) {
        // Saved pages are created by whoever started the request, and retracted text is
        // handled with the reply; neither is progress.
        if (event.type === "documents" || event.type === "retract") return;
        if (event.type === "thinking") {
          pendingThinking.current.set(id, `${pendingThinking.current.get(id) ?? ""}${event.delta}`);
          thinkingTimer.current ??= setTimeout(flushThinking, THINKING_FLUSH_MS);
          return;
        }
        // Thinking that arrived before this event is shown first, in order.
        flushThinking();
        setAgentProgress((current) => {
          const previous = current[id] ?? { steps: [] };
          if (event.type === "activity") {
            const same = previous.activity === event.activity && previous.label === event.label;
            return { ...current, [id]: { ...previous, activity: event.activity, label: event.label, since: same ? previous.since : Date.now() } };
          }
          // A step means its model call or tool has ended; that call's thinking is now in the steps.
          return { ...current, [id]: { steps: [...previous.steps, event.step].slice(-LIVE_STEPS), spentMicros: event.spentMicros ?? previous.spentMicros, since: Date.now() } };
        });
      },
      onPending(id, pending) {
        pendingThinking.current.delete(id);
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
    });
  });
  useEffect(() => () => { clearTimeout(thinkingTimer.current); executions.abortAll(false); }, [executions]);
  return { executions, pendingConversationIds, agentProgress };
}
