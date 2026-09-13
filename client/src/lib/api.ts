import { ApiError } from "./apiError";
import { readChatReplyStream, type ChatReplyResponse } from "./chatStream";
import type { ConversationContext } from "./chatContext";
import type {
  AppState,
  ApiKeyProvider,
  ApiKeySettings,
  AuthenticatedUser,
  BackendServiceId,
  ConversationDocument,
  Message,
} from "../types";
import {
  createAppStateFromWorkspaceDocument,
  createWorkspaceDocument,
  parseWorkspaceDocument,
} from "./workspaceModel";

export { ApiError } from "./apiError";
export type { ChatReplyResponse } from "./chatStream";

interface ErrorPayload {
  error?: string;
}

interface ChatTitleResponse {
  title: string;
}

interface AuthSessionResponse {
  user: AuthenticatedUser | null;
}

interface AuthSuccessResponse {
  user: AuthenticatedUser;
}

export interface PasswordResetRequestResponse {
  ok: boolean;
  resetToken?: string;
}

interface RedirectSessionResponse {
  url: string;
}

interface CheckoutConfirmationResponse {
  confirmed: boolean;
  status: string;
}

interface ApiKeySettingsResponse {
  apiKeys: ApiKeySettings;
}

interface DocumentUploadResponse {
  document: ConversationDocument;
}

export interface StateUploadProgress {
  totalBytes: number;
  uploadedBytes: number;
}

export interface StoredWorkspace {
  revision: number;
  state: AppState;
}

function getErrorMessage(
  payload: unknown,
  fallback: string,
): string {
  if (
    payload &&
    typeof payload === "object" &&
    "error" in payload &&
    typeof payload.error === "string" &&
    payload.error
  ) {
    return payload.error;
  }

  return fallback;
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

function isAuthSuccessResponse(
  payload: AuthSuccessResponse | ErrorPayload | null,
): payload is AuthSuccessResponse {
  return Boolean(
    payload &&
      typeof (payload as AuthSuccessResponse).user?.id === "string" &&
      typeof (payload as AuthSuccessResponse).user?.email === "string",
  );
}

function isRedirectSessionResponse(
  payload: RedirectSessionResponse | ErrorPayload | null,
): payload is RedirectSessionResponse {
  return Boolean(
    payload &&
      typeof (payload as RedirectSessionResponse).url === "string" &&
      (payload as RedirectSessionResponse).url,
  );
}

async function readJson<T>(response: Response): Promise<T | null> {
  return response.json().catch(() => null) as Promise<T | null>;
}

function ensureOk(
  response: Response,
  payload: unknown,
  fallback: string,
) {
  if (!response.ok) {
    throw new ApiError(response.status, getErrorMessage(payload, fallback));
  }
}

export async function requestChatReply(args: {
  conversation: ConversationContext;
  messages: Message[];
  modelId: string;
  onDelta?: (delta: string) => void;
  serviceId: BackendServiceId;
  signal?: AbortSignal;
}): Promise<ChatReplyResponse> {
  const { onDelta, signal, ...requestBody } = args;
  const response = await fetch("/api/chat", {
    body: JSON.stringify(requestBody),
    credentials: "same-origin",
    headers: {
      Accept: "application/x-ndjson",
      "Content-Type": "application/json",
    },
    method: "POST",
    signal,
  });

  if (!response.ok) {
    const payload = (await readJson(response)) as ErrorPayload | null;
    ensureOk(response, payload, "Backend request failed.");
  }

  if (!response.headers.get("content-type")?.includes("application/x-ndjson")) {
    const payload = (await readJson(response)) as
      | ChatReplyResponse
      | ErrorPayload
      | null;

    if (!isChatReplyResponse(payload)) {
      throw new Error("Backend returned an empty assistant reply.");
    }

    onDelta?.(payload.reply);
    return payload;
  }

  if (!response.body) {
    throw new Error("Backend returned an empty assistant stream.");
  }

  return readChatReplyStream(response.body, onDelta);
}

export async function requestChatTitle(args: {
  modelId: string;
  prompt: string;
  serviceId: BackendServiceId;
}): Promise<string> {
  const response = await fetch("/api/chat/title", {
    body: JSON.stringify(args),
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const payload = (await readJson(response)) as ChatTitleResponse | ErrorPayload | null;

  ensureOk(response, payload, "Chat title generation failed.");

  if (
    !payload ||
    typeof payload !== "object" ||
    !("title" in payload) ||
    typeof payload.title !== "string" ||
    !payload.title.trim()
  ) {
    throw new Error("Backend returned an empty chat title.");
  }

  return payload.title.trim();
}

export async function requestUploadDocument(
  file: File,
): Promise<ConversationDocument> {
  const form = new FormData();
  form.set("file", file);
  const response = await fetch("/api/documents", {
    body: form,
    credentials: "same-origin",
    method: "POST",
  });
  const payload = (await readJson(response)) as
    | DocumentUploadResponse
    | ErrorPayload
    | null;

  ensureOk(response, payload, "Document upload failed.");

  if (
    !payload ||
    typeof payload !== "object" ||
    !("document" in payload) ||
    typeof payload.document?.id !== "string"
  ) {
    throw new Error("Backend returned an invalid document.");
  }

  return payload.document;
}

export async function requestDeleteDocument(documentId: string): Promise<void> {
  const response = await fetch(
    `/api/documents/${encodeURIComponent(documentId)}`,
    {
      credentials: "same-origin",
      method: "DELETE",
    },
  );
  const payload = (await readJson(response)) as ErrorPayload | null;

  ensureOk(response, payload, "Document deletion failed.");
}

export async function requestStoredState(): Promise<StoredWorkspace | null> {
  const response = await fetch("/api/state", {
    credentials: "same-origin",
  });

  if (response.status === 404) {
    return null;
  }

  const payload = (await readJson(response)) as
    | { revision?: number; workspace?: unknown }
    | AppState
    | ErrorPayload
    | null;

  ensureOk(response, payload, "State request failed.");

  if (payload && typeof payload === "object" && "workspace" in payload) {
    const document = parseWorkspaceDocument(payload.workspace);
    const state = document
      ? createAppStateFromWorkspaceDocument(document)
      : null;

    if (state) {
      return {
        revision:
          typeof payload.revision === "number" && payload.revision >= 0
            ? payload.revision
            : 0,
        state,
      };
    }
  }

  if (payload && typeof payload === "object" && "conversations" in payload) {
    return { revision: 0, state: payload as AppState };
  }

  throw new Error("Backend returned an invalid app state payload.");
}

export async function persistStoredState(
  state: AppState,
  baseRevision: number | null = null,
): Promise<number> {
  const response = await fetch("/api/state", {
    body: JSON.stringify({
      baseRevision,
      workspace: createWorkspaceDocument(state),
    }),
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
    method: "PUT",
  });

  const payload = (await readJson(response)) as
    | { revision?: number }
    | ErrorPayload
    | null;

  ensureOk(response, payload, "State persistence failed.");

  if (
    !payload ||
    typeof payload !== "object" ||
    !("revision" in payload) ||
    typeof payload.revision !== "number" ||
    payload.revision < 0
  ) {
    throw new Error("Backend returned an invalid workspace revision.");
  }

  return payload.revision;
}

export function persistStoredStateWithProgress(
  state: AppState,
  onProgress: (progress: StateUploadProgress) => void,
  baseRevision: number | null = null,
): Promise<number> {
  const body = JSON.stringify({
    baseRevision,
    workspace: createWorkspaceDocument(state),
  });
  const totalBytes = new TextEncoder().encode(body).byteLength;

  onProgress({ totalBytes, uploadedBytes: 0 });

  return new Promise((resolve, reject) => {
    const request = new XMLHttpRequest();

    request.open("PUT", "/api/state");
    request.withCredentials = true;
    request.setRequestHeader("Content-Type", "application/json");

    request.upload.addEventListener("progress", (event) => {
      onProgress({
        totalBytes,
        uploadedBytes: Math.min(event.loaded, totalBytes),
      });
    });

    request.addEventListener("load", () => {
      let payload: unknown = null;

      try {
        payload = request.responseText
          ? JSON.parse(request.responseText)
          : null;
      } catch {
        payload = null;
      }

      if (request.status >= 200 && request.status < 300) {
        const revision =
          payload &&
          typeof payload === "object" &&
          "revision" in payload &&
          typeof payload.revision === "number"
            ? payload.revision
            : null;

        if (revision === null || revision < 0) {
          reject(new Error("Backend returned an invalid workspace revision."));
          return;
        }

        onProgress({ totalBytes, uploadedBytes: totalBytes });
        resolve(revision);
        return;
      }

      reject(
        new ApiError(
          request.status,
          getErrorMessage(payload, "State persistence failed."),
        ),
      );
    });

    request.addEventListener("error", () => {
      reject(new TypeError("Failed to fetch"));
    });

    request.addEventListener("abort", () => {
      reject(new DOMException("Cloud backup was cancelled.", "AbortError"));
    });

    request.send(body);
  });
}

export async function requestAuthSession(): Promise<AuthenticatedUser | null> {
  const response = await fetch("/api/auth/session", {
    credentials: "same-origin",
    cache: "no-store",
    signal: AbortSignal.timeout(5_000),
  });
  const payload = (await readJson(response)) as AuthSessionResponse | ErrorPayload | null;

  ensureOk(response, payload, "Session check failed.");

  if (!payload || typeof payload !== "object" || !("user" in payload)) {
    throw new Error("Backend returned an invalid auth session payload.");
  }

  return payload.user ?? null;
}

export async function requestLogin(args: {
  email: string;
  password: string;
}): Promise<AuthenticatedUser> {
  const response = await fetch("/api/auth/login", {
    body: JSON.stringify(args),
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const payload = (await readJson(response)) as AuthSuccessResponse | ErrorPayload | null;

  ensureOk(response, payload, "Login failed.");

  if (!isAuthSuccessResponse(payload)) {
    throw new Error("Backend returned an invalid login response.");
  }

  return payload.user;
}

export async function requestSignup(args: {
  displayName: string;
  email: string;
  password: string;
}): Promise<AuthenticatedUser> {
  const response = await fetch("/api/auth/signup", {
    body: JSON.stringify(args),
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const payload = (await readJson(response)) as AuthSuccessResponse | ErrorPayload | null;

  ensureOk(response, payload, "Signup failed.");

  if (!isAuthSuccessResponse(payload)) {
    throw new Error("Backend returned an invalid signup response.");
  }

  return payload.user;
}

export async function requestPasswordReset(args: {
  email: string;
}): Promise<PasswordResetRequestResponse> {
  const response = await fetch("/api/auth/password-reset/request", {
    body: JSON.stringify(args),
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const payload = (await readJson(response)) as PasswordResetRequestResponse | ErrorPayload | null;

  ensureOk(response, payload, "Unable to request a password reset.");

  if (!payload || typeof payload !== "object" || !("ok" in payload) || payload.ok !== true) {
    throw new Error("Backend returned an invalid password reset response.");
  }

  return payload;
}

export async function requestPasswordResetConfirm(args: {
  password: string;
  token: string;
}): Promise<void> {
  const response = await fetch("/api/auth/password-reset/confirm", {
    body: JSON.stringify(args),
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const payload = (await readJson(response)) as { ok?: boolean } | ErrorPayload | null;

  ensureOk(response, payload, "Unable to reset the password.");

  if (!payload || !("ok" in payload) || payload.ok !== true) {
    throw new Error("Backend returned an invalid password reset response.");
  }
}

export async function requestLogout(): Promise<void> {
  const response = await fetch("/api/auth/logout", {
    credentials: "same-origin",
    method: "POST",
  });
  const payload = (await readJson(response)) as { ok?: boolean } | ErrorPayload | null;

  ensureOk(response, payload, "Logout failed.");
}

export async function requestUpdateProfile(args: {
  displayName: string;
  email: string;
}): Promise<AuthenticatedUser> {
  const response = await fetch("/api/auth/profile", {
    body: JSON.stringify(args),
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
    method: "PUT",
  });
  const payload = (await readJson(response)) as AuthSuccessResponse | ErrorPayload | null;

  ensureOk(response, payload, "Profile update failed.");

  if (!isAuthSuccessResponse(payload)) {
    throw new Error("Backend returned an invalid profile response.");
  }

  return payload.user;
}

export async function requestUpdateApiKeys(args: {
  keys: Partial<Record<ApiKeyProvider, string | null>>;
}): Promise<ApiKeySettings> {
  const response = await fetch("/api/settings/api-keys", {
    body: JSON.stringify(args),
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
    method: "PUT",
  });
  const payload = (await readJson(response)) as
    | ApiKeySettingsResponse
    | ErrorPayload
    | null;

  ensureOk(response, payload, "Unable to update personal API keys.");

  if (
    !payload ||
    !("apiKeys" in payload) ||
    !payload.apiKeys ||
    typeof payload.apiKeys.hasAny !== "boolean"
  ) {
    throw new Error("Backend returned invalid API key settings.");
  }

  return payload.apiKeys;
}

export async function requestCreateCheckoutSession(): Promise<string> {
  const response = await fetch("/api/billing/checkout", {
    credentials: "same-origin",
    method: "POST",
  });
  const payload = (await readJson(response)) as RedirectSessionResponse | ErrorPayload | null;

  ensureOk(response, payload, "Unable to create the Stripe checkout session.");

  if (!isRedirectSessionResponse(payload)) {
    throw new Error("Backend returned an invalid Stripe checkout response.");
  }

  return payload.url;
}

export async function requestConfirmCheckoutSession(
  sessionId: string,
): Promise<CheckoutConfirmationResponse> {
  const response = await fetch("/api/billing/checkout/confirm", {
    body: JSON.stringify({ sessionId }),
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });
  const payload = (await readJson(response)) as
    | CheckoutConfirmationResponse
    | ErrorPayload
    | null;

  ensureOk(response, payload, "Unable to confirm the Stripe subscription.");

  if (
    !payload ||
    !("confirmed" in payload) ||
    typeof payload.confirmed !== "boolean" ||
    !("status" in payload) ||
    typeof payload.status !== "string"
  ) {
    throw new Error("Backend returned an invalid subscription confirmation.");
  }

  return payload;
}

export async function requestCreateBillingPortalSession(): Promise<string> {
  const response = await fetch("/api/billing/portal", {
    credentials: "same-origin",
    method: "POST",
  });
  const payload = (await readJson(response)) as RedirectSessionResponse | ErrorPayload | null;

  ensureOk(response, payload, "Unable to create the Stripe billing portal session.");

  if (!isRedirectSessionResponse(payload)) {
    throw new Error("Backend returned an invalid Stripe billing portal response.");
  }

  return payload.url;
}
