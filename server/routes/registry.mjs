import {
  CAPTURE_API_PATH,
  CONNECTION_API_PATH,
  EXTENSION_SESSION_API_PATH,
} from "@margin-chat/capture-contracts";

// Both the local server and the deployed catch-all dispatch this same registry.
// Route IDs let feature handlers evolve without repeating paths or methods.
export const API_ROUTES = Object.freeze([
  { id: "health", methods: ["GET"], path: "/api/health" },
  { id: "billingWebhook", methods: ["POST"], path: "/api/billing/webhook" },
  { id: "extensionSession", methods: ["POST", "DELETE"], path: EXTENSION_SESSION_API_PATH },
  { id: "captureCreate", methods: ["POST"], path: CAPTURE_API_PATH },
  { id: "captureConnection", methods: ["GET"], path: CONNECTION_API_PATH },
  { id: "authSession", methods: ["GET"], path: "/api/auth/session" },
  { id: "authSignup", methods: ["POST"], path: "/api/auth/signup" },
  { id: "authLogin", methods: ["POST"], path: "/api/auth/login" },
  { id: "passwordResetRequest", methods: ["POST"], path: "/api/auth/password-reset/request" },
  { id: "passwordResetConfirm", methods: ["POST"], path: "/api/auth/password-reset/confirm" },
  { id: "authLogout", methods: ["POST"], path: "/api/auth/logout" },
  { id: "billingCheckout", methods: ["POST"], path: "/api/billing/checkout" },
  { id: "billingTopUp", methods: ["POST"], path: "/api/billing/topup" },
  { id: "billingDashboard", methods: ["GET"], path: "/api/billing/dashboard" },
  { id: "captureToken", methods: ["GET", "POST", "DELETE"], path: "/api/settings/capture-token" },
  { id: "captureList", methods: ["GET"], path: CAPTURE_API_PATH },
  { id: "captureGet", methods: ["GET"], path: `${CAPTURE_API_PATH}/:id`, parameters: { id: "[0-9a-f-]{36}" } },
  { id: "billingConfirm", methods: ["POST"], path: "/api/billing/checkout/confirm" },
  { id: "billingPortal", methods: ["POST"], path: "/api/billing/portal" },
  { id: "authProfile", methods: ["PUT"], path: "/api/auth/profile" },
  { id: "apiKeysRead", methods: ["GET"], path: "/api/settings/api-keys" },
  { id: "apiKeysWrite", methods: ["PUT"], path: "/api/settings/api-keys" },
  { id: "vaultStatus", methods: ["GET"], path: "/api/vault" },
  { id: "vaultFileRead", methods: ["GET"], path: "/api/vault/file" },
  { id: "vaultFileWrite", methods: ["PUT"], path: "/api/vault/file" },
  { id: "vaultCommit", methods: ["POST"], path: "/api/vault/commit" },
  { id: "vaultRebuild", methods: ["POST"], path: "/api/vault/rebuild" },
  { id: "stateRead", methods: ["GET"], path: "/api/state" },
  { id: "documentUpload", methods: ["POST"], path: "/api/documents" },
  { id: "documentOriginal", methods: ["GET"], path: "/api/documents/:id/original" },
  { id: "documentDelete", methods: ["DELETE"], path: "/api/documents/:id" },
  { id: "stateWrite", methods: ["PUT"], path: "/api/state" },
  { id: "chat", methods: ["POST"], path: "/api/chat" },
  { id: "chatTitle", methods: ["POST"], path: "/api/chat/title" },
  { id: "jevStatus", methods: ["GET"], path: "/api/jev/status" },
  { id: "jevWorkspace", methods: ["POST"], path: "/api/jev/workspace" },
  { id: "jevSearch", methods: ["POST"], path: "/api/jev/search" },
].map((route) => Object.freeze({ ...route, methods: Object.freeze(route.methods) })));

const compiledRoutes = API_ROUTES.map((route) => {
  const names = [];
  const pattern = route.path.split("/").map((segment) => {
    if (!segment.startsWith(":")) return segment.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
    const name = segment.slice(1);
    names.push(name);
    return `(${route.parameters?.[name] ?? "[^/]+"})`;
  }).join("/");
  return { ...route, names, matcher: new RegExp(`^${pattern}$`, "u") };
});

export function matchApiRoute(method, pathname) {
  for (const route of compiledRoutes) {
    if (!route.methods.includes(method)) continue;
    const match = route.matcher.exec(pathname);
    if (match) {
      return {
        id: route.id,
        params: Object.fromEntries(route.names.map((name, index) => [name, match[index + 1]])),
      };
    }
  }
  return null;
}
