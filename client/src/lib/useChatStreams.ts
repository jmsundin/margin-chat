import { useEffect, useRef, useState } from "react";
import { ChatExecutions } from "./chatExecution";

export function useChatStreams(onDelta: ConstructorParameters<typeof ChatExecutions>[0]["onDelta"], onExecution?: ConstructorParameters<typeof ChatExecutions>[0]["onExecution"]) {
  const latestDelta = useRef(onDelta);
  latestDelta.current = onDelta;
  const latestExecution = useRef(onExecution);
  latestExecution.current = onExecution;
  const [pendingConversationIds, setPending] = useState<Record<string, boolean>>({});
  const [executions] = useState(() => new ChatExecutions({
    onDelta: (...args) => latestDelta.current(...args),
    onExecution: (...args) => latestExecution.current?.(...args),
    onPending(id, pending) {
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
  return { executions, pendingConversationIds };
}
