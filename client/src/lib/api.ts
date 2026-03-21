import type {
  AppState,
  AuthenticatedUser,
  BranchAnchor,
  BackendServiceId,
  Message,
} from "../types";

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

interface AuthSessionResponse {
  user: AuthenticatedUser | null;
}

interface AuthSuccessResponse {
  user: AuthenticatedUser;
}

interface RedirectSessionResponse {
  url: string;
}

export class ApiError extends Error {
  statusCode: number;

  constructor(statusCode: number, message: string) {
    super(message);
    this.name = "ApiError";
    this.statusCode = statusCode;
  }
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
  serviceId: BackendServiceId;
}): Promise<ChatReplyResponse> {
  const response = await fetch("/api/chat", {
    body: JSON.stringify(args),
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
    method: "POST",
  });

  const payload = (await readJson(response)) as
    | ChatReplyResponse
    | ErrorPayload
    | null;

  ensureOk(response, payload, "Backend request failed.");

  if (!isChatReplyResponse(payload)) {
    throw new Error("Backend returned an empty assistant reply.");
  }

  return payload;
}

export async function requestStoredState(): Promise<AppState | null> {
  const response = await fetch("/api/state", {
    credentials: "same-origin",
  });

  if (response.status === 404) {
    return null;
  }

  const payload = (await readJson(response)) as AppState | ErrorPayload | null;

  ensureOk(response, payload, "State request failed.");

  if (!payload || typeof payload !== "object" || !("conversations" in payload)) {
    throw new Error("Backend returned an invalid app state payload.");
  }

  return payload;
}

export async function persistStoredState(state: AppState): Promise<void> {
  const response = await fetch("/api/state", {
    body: JSON.stringify(state),
    credentials: "same-origin",
    headers: {
      "Content-Type": "application/json",
    },
    method: "PUT",
  });

  const payload = (await readJson(response)) as AppState | ErrorPayload | null;

  ensureOk(response, payload, "State persistence failed.");
}

export async function requestAuthSession(): Promise<AuthenticatedUser | null> {
  const response = await fetch("/api/auth/session", {
    credentials: "same-origin",
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
