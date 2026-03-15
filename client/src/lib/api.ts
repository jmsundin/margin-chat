import type { AppState, BranchAnchor, BackendServiceId, Message } from "../types";

interface ConversationContext {
  branchAnchor: BranchAnchor | null;
  id: string;
  parentId: string | null;
  title: string;
}

interface ChatReplyResponse {
  metadata: {
    model: string;
    requestedServiceId: BackendServiceId;
    resolvedServiceId: BackendServiceId;
  };
  reply: string;
}

interface ErrorPayload {
  error?: string;
}

function getErrorMessage(
  payload: ChatReplyResponse | ErrorPayload | AppState | null,
  fallback: string,
): string {
  return payload && "error" in payload && payload.error ? payload.error : fallback;
}

function isChatReplyResponse(
  payload: ChatReplyResponse | ErrorPayload | null,
): payload is ChatReplyResponse {
  return Boolean(
    payload &&
      typeof (payload as ChatReplyResponse).reply === "string" &&
      (payload as ChatReplyResponse).reply.trim(),
  );
}

export async function requestChatReply(args: {
  conversation: ConversationContext;
  messages: Message[];
  serviceId: BackendServiceId;
}): Promise<ChatReplyResponse> {
  const response = await fetch("/api/chat", {
    body: JSON.stringify(args),
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  const payload = (await response.json().catch(() => null)) as
    | ChatReplyResponse
    | ErrorPayload
    | null;

  if (!response.ok) {
    throw new Error(getErrorMessage(payload, "Backend request failed."));
  }

  if (!isChatReplyResponse(payload)) {
    throw new Error("Backend returned an empty assistant reply.");
  }

  return payload;
}

export async function requestStoredState(): Promise<AppState | null> {
  const response = await fetch("/api/state");

  if (response.status === 404) {
    return null;
  }

  const payload = (await response.json().catch(() => null)) as AppState | ErrorPayload | null;

  if (!response.ok) {
    throw new Error(getErrorMessage(payload, "State request failed."));
  }

  if (!payload || typeof payload !== "object" || !("conversations" in payload)) {
    throw new Error("Backend returned an invalid app state payload.");
  }

  return payload;
}

export async function persistStoredState(state: AppState): Promise<void> {
  const response = await fetch("/api/state", {
    body: JSON.stringify(state),
    headers: {
      "Content-Type": "application/json",
    },
    method: "PUT",
  });

  const payload = (await response.json().catch(() => null)) as AppState | ErrorPayload | null;

  if (!response.ok) {
    throw new Error(getErrorMessage(payload, "State persistence failed."));
  }
}
