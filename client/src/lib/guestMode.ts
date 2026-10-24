import type { AuthenticatedUser } from "../types";
import type { ApiTransport } from "./apiTransport";
import { onDeviceStatus, onDeviceUnavailableMessage, streamOnDevice, type LanguageModelApi } from "./onDeviceAI";

/**
 * The free trial at /try: the real workspace with no account. Documents stay in
 * this browser, and AI runs on Chrome's built-in model on the visitor's computer.
 * Every API call is answered here, so nothing reaches the server: no account,
 * no cloud storage and no paid model can be used from a guest page.
 */
export const GUEST_PATH = "/try";
export const GUEST_USER_ID = "guest";
export const ON_DEVICE_MODEL_LABEL = "Gemini Nano (on this computer)";
export const SIGN_UP_NUDGE = "Sign up to keep your work in the cloud and use AI on any device.";

export function isGuestPath(pathname: string) {
  return (pathname.replace(/\/+$/, "") || "/") === GUEST_PATH;
}

export function createGuestUser(): AuthenticatedUser {
  return {
    id: GUEST_USER_ID, displayName: "Guest", email: "", role: "member",
    apiKeys: { byProvider: {}, hasAny: false } as AuthenticatedUser["apiKeys"],
    billing: {
      accessKind: "none", status: "inactive", cancelAtPeriodEnd: false, creditBalanceMicros: 0, currentPeriodEnd: null,
      hasAccess: false, hasCustomer: false, priceId: null, plan: null, trialCallsLimit: 0, trialCallsRemaining: 0, trialCallsUsed: 0,
    },
  };
}

const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
const needsAccount = () => json(403, { error: `This needs an account. ${SIGN_UP_NUDGE}` });

interface GuestChatMessage { role?: unknown; content?: unknown }
interface GuestChatBody {
  messages?: GuestChatMessage[];
  conversation?: { title?: unknown; branchAnchor?: { quote?: unknown } | null; ancestorContext?: Array<{ title?: unknown; messages?: GuestChatMessage[] }> };
  serviceId?: unknown;
  modelId?: unknown;
}

const text = (value: unknown) => typeof value === "string" ? value.trim() : "";

/** One prompt for the small model: a little earlier context, then the request itself, which already carries the document. */
export function guestChatPrompt(body: GuestChatBody) {
  const messages = (body.messages ?? []).filter((message) => message.role !== "system" && text(message.content));
  const latest = messages.at(-1);
  if (!latest) return "";
  const earlier = messages.slice(0, -1).slice(-4).map((message) => `${message.role === "assistant" ? "Assistant" : "User"}: ${text(message.content)}`);
  const ancestors = (body.conversation?.ancestorContext ?? []).flatMap((ancestor) => {
    const lines = (ancestor.messages ?? []).filter((message) => message.role !== "system" && text(message.content))
      .slice(-2).map((message) => text(message.content));
    return lines.length ? [`From "${text(ancestor.title) || "the parent document"}":\n${lines.join("\n")}`] : [];
  });
  const quote = text(body.conversation?.branchAnchor?.quote);
  return [
    ...(ancestors.length ? ["Background from the documents this one came from:", ...ancestors] : []),
    ...(quote ? [`This document grew from the passage: "${quote}"`] : []),
    ...(earlier.length ? ["Earlier in this conversation:", ...earlier] : []),
    text(latest.content),
  ].join("\n\n");
}

function chatStream(body: GuestChatBody, signal: AbortSignal | undefined, api: LanguageModelApi | null | undefined) {
  const encoder = new TextEncoder();
  const serviceId = typeof body.serviceId === "string" ? body.serviceId : "backend-services";
  const metadata = { model: ON_DEVICE_MODEL_LABEL, requestedServiceId: serviceId, resolvedServiceId: serviceId,
    ...(typeof body.modelId === "string" ? { requestedModelId: body.modelId } : {}) };
  const line = (event: unknown) => encoder.encode(`${JSON.stringify(event)}\n`);
  return new ReadableStream<Uint8Array>({
    async start(controller) {
      try {
        const status = await onDeviceStatus(api ?? undefined);
        if (status === "unsupported" || status === "unavailable") throw Object.assign(new Error(onDeviceUnavailableMessage(status)), { statusCode: 501 });
        controller.enqueue(line({ type: "metadata", metadata }));
        for await (const delta of streamOnDevice(guestChatPrompt(body), { signal, api })) controller.enqueue(line({ type: "delta", delta }));
        controller.enqueue(line({ type: "done", metadata }));
      } catch (error) {
        if (signal?.aborted) { controller.error(signal.reason); return; }
        const message = error instanceof Error && error.message ? error.message : "Chrome’s built-in model stopped before it finished.";
        // Chrome needs a click before it downloads the model.
        const needsClick = error instanceof Error && error.name === "NotAllowedError";
        controller.enqueue(line({ type: "error", statusCode: (error as { statusCode?: number }).statusCode ?? 503,
          error: needsClick ? "Chrome needs one click to download its built-in AI model. Press “Set up AI” at the top of the page, then try again." : message }));
      }
      controller.close();
    },
  });
}

/** Answers the workspace's API calls inside the browser. `api` is Chrome's LanguageModel, or a stand-in in tests. */
export function createGuestTransport({ api }: { api?: LanguageModelApi | null } = {}): ApiTransport {
  return {
    async fetch(input, init) {
      const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url, "https://guest.invalid");
      const method = (init?.method ?? "GET").toUpperCase();
      const path = url.pathname.replace(/\/+$/, "");
      if (path === "/api/auth/session") return json(200, { user: createGuestUser() });
      if (path === "/api/chat" && method === "POST") {
        const body = JSON.parse(typeof init?.body === "string" ? init.body : "{}") as GuestChatBody;
        return new Response(chatStream(body, init?.signal ?? undefined, api), { status: 200, headers: { "Content-Type": "application/x-ndjson" } });
      }
      // A reply runs in this tab, so there is never a saved one to pick up, and Stop needs nothing more.
      if (path.startsWith("/api/chat/runs/")) return method === "DELETE" ? json(200, { stopped: true }) : json(404, { error: "No saved reply." });
      if (path === "/api/billing/plans") return json(200, { plans: [] });
      return needsAccount();
    },
  };
}
