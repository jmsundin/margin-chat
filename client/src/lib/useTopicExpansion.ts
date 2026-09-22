import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { AppState } from "../types";
import { normalizeAISettings } from "@margin-chat/workspace-contracts";
import { getStandaloneNote } from "./standaloneNotes";
import { requestTopicExpansion } from "./topicExpansion";
import { applyTopicExpansion } from "./graphWorkspaceEdits";
import { ApiError } from "./apiError";

interface Options {
  state: AppState;
  setState: Dispatch<SetStateAction<AppState>>;
  userId: string;
  onReady: (conversationId: string) => void;
  onAuthExpired: () => void;
  onBillingRefresh: () => void;
}

/** Only a complete, validated response can add notes. Cancellation leaves the map intact. */
export function useTopicExpansion(options: Options) {
  const latest = useRef(options);
  latest.current = options;
  const active = useRef<{ controller: AbortController; conversationId: string; userId: string } | null>(null);
  const [pendingId, setPendingId] = useState<string | null>(null);
  const [progress, setProgress] = useState("");
  const [error, setError] = useState<{ conversationId: string; message: string } | null>(null);

  useEffect(() => {
    setPendingId(null); setError(null); setProgress("");
    return () => { active.current?.controller.abort(); active.current = null; };
  }, [options.userId]);

  useEffect(() => {
    if (active.current && !options.state.conversations[active.current.conversationId]) {
      active.current.controller.abort(); active.current = null; setPendingId(null); setProgress("");
    }
  }, [options.state.conversations]);

  function cancel() {
    active.current?.controller.abort(); active.current = null;
    setPendingId(null); setProgress("");
  }

  async function expand(conversationId: string) {
    if (active.current) return;
    const { state, userId } = latest.current;
    const conversation = state.conversations[conversationId];
    if (!conversation?.publicTopic) return;
    const controller = new AbortController();
    const operation = { controller, conversationId, userId };
    active.current = operation;
    const requestId = crypto.randomUUID();
    setPendingId(conversationId); setError(null); setProgress("Building an AI subgraph…");
    try {
      const graph = await requestTopicExpansion({
        expectedUserId: userId, signal: controller.signal,
        topic: { id: conversation.publicTopic.id, label: conversation.title.slice(0, 200), description: conversation.publicTopic.description.slice(0, 2000), wikidataUrl: conversation.publicTopic.wikidataUrl },
        noteContent: (getStandaloneNote(conversation)?.content ?? "").slice(0, 6000),
        existingTitles: conversation.childIds.flatMap((id) => state.conversations[id] ? [state.conversations[id].title.slice(0, 160)] : []).slice(0, 40),
        serviceId: conversation.serviceId, modelId: conversation.modelId,
        ai: { ...normalizeAISettings(conversation.ai), contextScope: "conversation", selectedConversationIds: [] },
        onProgress: (message) => { if (active.current === operation) setProgress(message); },
      });
      if (controller.signal.aborted || active.current !== operation || latest.current.userId !== userId || !latest.current.state.conversations[conversationId]) return;
      const createdAt = new Date().toISOString();
      latest.current.setState((current) => applyTopicExpansion(current, conversationId, graph, { requestId, createdAt }));
      latest.current.onReady(conversationId);
    } catch (cause) {
      if (controller.signal.aborted || active.current !== operation || latest.current.userId !== userId) return;
      if (cause instanceof ApiError && cause.statusCode === 401) latest.current.onAuthExpired();
      setError({ conversationId, message: cause instanceof Error ? cause.message : "The subgraph could not be created. Try again." });
    } finally {
      if (active.current === operation) {
        active.current = null; setPendingId(null); setProgress("");
        latest.current.onBillingRefresh();
      }
    }
  }

  return { expand, cancel, pendingId, progress, error, dismissError: () => setError(null) };
}
