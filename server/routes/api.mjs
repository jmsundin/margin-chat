import {
  jsonHeaders,
  readMultipartForm,
  readJsonBody,
  readRawBody,
  sendJson,
} from "../http/json.mjs";
import { createRateLimiter, getClientAddress } from "../http/rateLimit.mjs";
import { sendStreamingJson } from "../http/streamingJson.mjs";
import { createChatExecutionService } from "../chat/execution.mjs";
import { validateAIOptions } from "../chat/validation.mjs";
import { createRequestAbortScope, handleChatRequest, writeChatStreamEvent } from "./chat.mjs";
import { matchApiRoute } from "./registry.mjs";
import { createUrlMapService } from "../urlMap/index.mjs";
import { handleUrlMapRequest } from "./urlMap.mjs";
import { createTopicExpansionService } from "../topicExpansion/index.mjs";
import { handleTopicExpansionRequest } from "./topicExpansion.mjs";
import { requireCaptureAccess } from "../captures/index.mjs";
import { HttpError, hasStatusCode } from "../lib/errors.mjs";
import {
  createAppStateFromWorkspaceDocument,
  createWorkspaceDocument,
} from "../db/workspaceDocument.mjs";

export function canUseCloudWorkspaceStorage(user) {
  return (
    user?.role === "admin" || user?.billing?.accessKind === "subscription"
  );
}

const FIFTEEN_MINUTES_MS = 15 * 60 * 1000;
// Failed-login budgets are per client address and per account email; signup and
// reset routes count every attempt per address because each one is expensive.
export const DEFAULT_AUTH_RATE_LIMITS = Object.freeze({
  loginFailuresByAddress: { max: 30, windowMs: FIFTEEN_MINUTES_MS },
  loginFailuresByEmail: { max: 10, windowMs: FIFTEEN_MINUTES_MS },
  signupsByAddress: { max: 20, windowMs: 60 * 60 * 1000 },
  passwordResetsByAddress: { max: 10, windowMs: FIFTEEN_MINUTES_MS },
  passwordChangeFailuresByUser: { max: 10, windowMs: FIFTEEN_MINUTES_MS },
});

const UNSAFE_METHODS = new Set(["POST", "PUT", "PATCH", "DELETE"]);
const AUTH_BODY_LIMIT = 16_384;
// Whole conversations and legacy whole-workspace uploads are the largest JSON bodies.
const LARGE_JSON_BODY_LIMIT = 8 * 1024 * 1024;

function decodePathParameter(value) {
  try {
    return decodeURIComponent(value);
  } catch {
    throw new HttpError(400, "The request path is invalid.");
  }
}

function requireExpectedVaultAccount(request, user) {
  const expectedUser = request.headers["x-margin-vault-user"];
  if (expectedUser !== undefined && expectedUser !== String(user.id)) {
    throw new HttpError(409, "The signed-in account changed. Reload Margin Chat before synchronizing this device's vault.");
  }
}

/** A device that syncs changes only needs the entries it just saved, not the
 * whole vault's file list, back from a commit. */
const acknowledgesChanges = (url) => url.searchParams.get("acknowledge") === "changes";
function acknowledgeVaultCommit(result, paths, url) {
  if (!acknowledgesChanges(url)) return result;
  const files = {};
  for (const path of paths) if (typeof path === "string" && Object.hasOwn(result.manifest.files, path)) files[path] = result.manifest.files[path];
  return { ...result, manifest: { schemaVersion: result.manifest.schemaVersion, revision: result.manifest.revision, files } };
}

// The extension can operate on workspace content, but account administration
// and billing mutations still require the website's cookie session.
const EXTENSION_WORKSPACE_ROUTES = new Set([
  "authSession", "captureList", "captureGet", "stateRead",
  "vaultStatus", "vaultIndex", "vaultChanges", "vaultFileRead", "vaultFileWrite", "vaultCommit", "vaultRebuild",
  "chat", "chatTitle", "documentUpload", "documentOriginal", "documentDelete",
  "urlMap", "topicExpansion", "jevStatus", "jevWorkspace", "jevSearch",
  "billingDashboard", "apiKeysRead",
]);

export function createApiHandler({
  captureService,
  apiKeyService,
  authService,
  billingService,
  chatService,
  database,
  documentService,
  runtimeConfig,
  vaultService,
  semanticService,
  urlMapService,
  topicExpansionService,
  rateLimits,
}) {
  const fallbackHost = `${runtimeConfig.host}:${runtimeConfig.port}`;

  const executeChatReply = createChatExecutionService({ apiKeyService, billingService, chatService, database });
  const mapUrl = urlMapService ?? createUrlMapService({ executeChatReply });
  const expandTopic = topicExpansionService ?? createTopicExpansionService({ executeChatReply });

  const limits = { ...DEFAULT_AUTH_RATE_LIMITS, ...rateLimits };
  const loginByAddress = createRateLimiter(limits.loginFailuresByAddress);
  const loginByEmail = createRateLimiter(limits.loginFailuresByEmail);
  const signupByAddress = createRateLimiter(limits.signupsByAddress);
  const resetByAddress = createRateLimiter(limits.passwordResetsByAddress);
  const passwordChangeByUser = createRateLimiter(limits.passwordChangeFailuresByUser);
  const clientAddress = (request) =>
    getClientAddress(request, { trustProxyHeaders: runtimeConfig.trustProxyHeaders === true });

  // Checks run before the password hash is computed, so a throttled caller
  // costs nothing. Only failed credentials count, and success clears the email.
  async function throttleLogin(request, payload, run) {
    const address = clientAddress(request);
    const email = typeof payload?.email === "string" ? payload.email.trim().toLowerCase().slice(0, 320) : null;
    loginByAddress.check(address);
    if (email) loginByEmail.check(email);
    try {
      const result = await run();
      if (email) loginByEmail.reset(email);
      return result;
    } catch (error) {
      if (error?.statusCode === 401) {
        loginByAddress.record(address);
        if (email) loginByEmail.record(email);
      }
      throw error;
    }
  }

  function throttleAttempt(limiter, request) {
    const address = clientAddress(request);
    limiter.check(address);
    limiter.record(address);
  }

  return async function handleRequest(request, response) {
    try {
      if (request.method === "OPTIONS") {
        response.writeHead(204, jsonHeaders);
        response.end();
        return;
      }

      const url = new URL(
        request.url ?? "/",
        `http://${request.headers.host ?? fallbackHost}`,
      );

      const route = matchApiRoute(request.method, url.pathname);

      if (route?.id === "health") {
        try {
          await database.ready();
        } catch {
          // Health responses should still return the degraded payload.
        }

        const databaseHealth = database.checkHealth
          ? await database.checkHealth()
          : database.getHealth();
        const payload = chatService.buildHealthPayload(databaseHealth);
        payload.storage = { ...payload.storage, vault: {
          configured: Boolean(vaultService?.configured),
          kind: vaultService?.storageKind ?? null,
        } };
        payload.release = process.env.MARGIN_RELEASE_SHA ?? null;
        sendJson(response, databaseHealth.ready ? 200 : 503, payload, { "Cache-Control": "no-store" });
        return;
      }

      if (route?.id === "billingWebhook") {
        const stripeSignature = request.headers["stripe-signature"];
        const signature = Array.isArray(stripeSignature)
          ? stripeSignature[0]
          : stripeSignature;
        const result = await billingService.handleWebhook({
          rawBody: await readRawBody(request),
          signature,
        });

        sendJson(response, 200, result);
        return;
      }

      if (route?.id === "extensionSession" || route?.id === "extensionWorkspaceSession") {
        response.setHeader("Cache-Control", "no-store");
        if (request.method === "POST") {
          const credentials = await readJsonBody(request, AUTH_BODY_LIMIT);
          const user = await throttleLogin(request, credentials, () => authService.authenticateCredentials(credentials));
          const session = route.id === "extensionWorkspaceSession"
            ? await captureService.issueWorkspaceSession(user, runtimeConfig.authSessionTtlMs)
            : await captureService.issueSession(user, runtimeConfig.authSessionTtlMs);
          sendJson(response, 201, session);
        } else {
          await captureService.signOut(request);
          sendJson(response, 200, { ok: true });
        }
        return;
      }

      // Existing capture credentials remain restricted to capture operations.
      if (route?.id === "captureCreate" || route?.id === "captureConnection") {
        const user = await captureService.connect(request);
        if (request.method === "GET") {
          sendJson(response, 200, { userId: user.id, displayName: user.displayName, expiresAt: user.expiresAt }, { "Cache-Control": "no-store" });
        } else {
          const capture = await captureService.save(user.id, await readJsonBody(request, 1_500_000));
          sendJson(response, 201, { capture }, { "Cache-Control": "no-store" });
        }
        return;
      }

      const workspaceCredential = typeof request.headers.authorization === "string"
        && request.headers.authorization.startsWith("Bearer mc_workspace_");
      async function getRequestAuthContext() {
        if (!workspaceCredential) return authService.getAuthContext(request);
        const user = await captureService.authenticateWorkspace(request);
        return {
          user: apiKeyService ? await apiKeyService.decorateUser(user) : user,
          sessionId: null,
          shouldClearSession: false,
        };
      }
      if (workspaceCredential) response.setHeader("Cache-Control", "private, no-store");
      // Cookie sessions are ambient credentials, so a cross-site page must not be
      // able to drive any state-changing route (login and signup included).
      // Bearer credentials are sent deliberately and are exempt.
      if (!workspaceCredential && UNSAFE_METHODS.has(request.method)
        && request.headers["sec-fetch-site"] === "cross-site") {
        throw new HttpError(403, "Use Margin Chat from its own site.");
      }
      const authContext = await getRequestAuthContext();
      if (workspaceCredential && !EXTENSION_WORKSPACE_ROUTES.has(route?.id)) {
        throw new HttpError(403, "Manage account and billing settings on the Margin Chat website.");
      }
      const authHeaders = authContext.shouldClearSession
        ? {
            "Set-Cookie": authService.buildClearedSessionCookie(),
          }
        : undefined;

      if (route?.id === "authSession") {
        sendJson(
          response,
          200,
          {
            user: authContext.user,
          },
          authHeaders,
        );
        return;
      }

      if (route?.id === "authSignup") {
        throttleAttempt(signupByAddress, request);
        const body = await readJsonBody(request, AUTH_BODY_LIMIT);
        const result = await authService.signup(body);

        sendJson(
          response,
          201,
          {
            user: result.user,
          },
          {
            "Set-Cookie": result.cookie,
          },
        );
        return;
      }

      if (route?.id === "authLogin") {
        const body = await readJsonBody(request, AUTH_BODY_LIMIT);
        const result = await throttleLogin(request, body, () => authService.login(body));

        sendJson(
          response,
          200,
          {
            user: result.user,
          },
          {
            "Set-Cookie": result.cookie,
          },
        );
        return;
      }

      if (route?.id === "passwordResetRequest") {
        throttleAttempt(resetByAddress, request);
        const result = await authService.requestPasswordReset(await readJsonBody(request, AUTH_BODY_LIMIT));

        sendJson(response, 200, result);
        return;
      }

      if (route?.id === "passwordResetConfirm") {
        throttleAttempt(resetByAddress, request);
        const result = await authService.resetPassword(await readJsonBody(request, AUTH_BODY_LIMIT));

        sendJson(response, 200, result, {
          "Set-Cookie": authService.buildClearedSessionCookie(),
        });
        return;
      }

      if (route?.id === "authLogout") {
        const result = await authService.logout(request);

        sendJson(
          response,
          200,
          {
            ok: true,
          },
          {
            "Set-Cookie": result.cookie,
          },
        );
        return;
      }

      if (!authContext.user) {
        sendJson(
          response,
          401,
          {
            error: "Sign in to continue.",
          },
          authHeaders,
        );
        return;
      }

      if (["stateRead", "documentUpload", "documentDelete", "chat", "chatTitle", "urlMap", "topicExpansion", "jevStatus", "jevWorkspace", "jevSearch"].includes(route?.id)) {
        requireExpectedVaultAccount(request, authContext.user);
      }

      if (route?.id === "passwordChange") {
        const changeBody = await readJsonBody(request, AUTH_BODY_LIMIT);
        passwordChangeByUser.check(authContext.user.id);
        let result;
        try {
          result = await authService.changePassword(authContext.user.id, authContext.sessionId, changeBody);
          passwordChangeByUser.reset(authContext.user.id);
        } catch (error) {
          if (error?.statusCode === 400) passwordChangeByUser.record(authContext.user.id);
          throw error;
        }
        sendJson(response, 200, { ok: true }, {
          "Cache-Control": "no-store",
          "Set-Cookie": result.cookie,
        });
        return;
      }

      if (route?.id === "urlMap") {
        await handleUrlMapRequest({ request, response, user: authContext.user, mapUrl, workspaceCredential });
        return;
      }

      if (route?.id === "topicExpansion") {
        await handleTopicExpansionRequest({ request, response, user: authContext.user, expandTopic, workspaceCredential });
        return;
      }

      if (route?.id === "jevStatus") {
        sendJson(response, 200, { configured: Boolean(semanticService?.configured) }, { "Cache-Control": "private, no-store" });
        return;
      }

      if (route?.id === "jevWorkspace" || route?.id === "jevSearch") {
        if ((!workspaceCredential && request.headers["sec-fetch-site"] === "cross-site")
          || !String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
          throw new HttpError(403, "Use Jev assistance from your Margin Chat workspace.");
        }
        const scope = createRequestAbortScope(request, response);
        try {
          const payload = await readJsonBody(request, 256 * 1024);
          scope.signal.throwIfAborted();
          const method = route.id === "jevSearch" ? "analyzeSearch" : "analyzeWorkspace";
          const result = semanticService?.[method]
            ? await semanticService[method]({ payload, userId: authContext.user.id, signal: scope.signal })
            : { available: false, ...(route.id === "jevSearch" ? { scores: [], suggestedFacetIds: [] } : { categories: [], related: [] }), warning: "Jev assistance is not configured." };
          scope.signal.throwIfAborted();
          sendJson(response, 200, result, { "Cache-Control": "private, no-store" });
        } finally { scope.dispose(); }
        return;
      }

      if (["billingCheckout", "billingTopUp", "billingDashboard", "billingConfirm", "billingPortal"].includes(route?.id)) {
        const expectedUser = request.headers["x-margin-billing-user"];
        if (expectedUser !== undefined && expectedUser !== String(authContext.user.id)) {
          throw new HttpError(409, "The signed-in account changed. Reload Margin Chat before continuing with billing.");
        }
      }

      if (route?.id === "billingCheckout") {
        const result = await billingService.createSubscriptionCheckoutSession({
          request,
          user: authContext.user,
        });

        sendJson(response, 200, result);
        return;
      }

      if (route?.id === "billingTopUp") {
        const body = await readJsonBody(request, 4096);
        const result = await billingService.createTopUpCheckoutSession({
          request, user: authContext.user, amountCents: body?.amountCents,
        });
        sendJson(response, 200, result, { "Cache-Control": "no-store" });
        return;
      }

      if (route?.id === "billingDashboard") {
        const dashboard = await billingService.getBillingDashboard(authContext.user.id);
        const fresh = await getRequestAuthContext();
        sendJson(response, 200, { ...dashboard, user: fresh.user }, { "Cache-Control": "no-store" });
        return;
      }

      if (route?.id === "captureToken") {
        const userId = authContext.user.id;
        if (request.method === "GET") {
          sendJson(response, 200, { summary: await database.getCaptureToken(userId) }, { "Cache-Control": "no-store" });
          return;
        }
        if (request.method === "POST" || request.method === "DELETE") {
          // A non-simple header plus same-origin fetch metadata prevents form-based CSRF.
          if (request.headers["x-margin-capture-settings"] !== "1" || request.headers["sec-fetch-site"] === "cross-site") {
            throw new HttpError(403, "Manage capture keys from your Margin Chat Cloud Inbox.");
          }
          if (request.method === "POST") {
            requireCaptureAccess(authContext.user);
            sendJson(response, 201, await captureService.issueToken(userId), { "Cache-Control": "no-store" });
          } else {
            await database.deleteCaptureToken(userId);
            sendJson(response, 200, { revoked: true }, { "Cache-Control": "no-store" });
          }
          return;
        }
      }

      if (route?.id === "captureList") {
        requireCaptureAccess(authContext.user);
        sendJson(response, 200, await captureService.list(authContext.user.id, url.searchParams.get("cursor")), { "Cache-Control": "no-store" });
        return;
      }
      if (route?.id === "captureGet") {
        requireCaptureAccess(authContext.user);
        const capture = await database.getCapture({ userId: authContext.user.id, id: route.params.id });
        if (!capture) throw new HttpError(404, "Capture not found.");
        sendJson(response, 200, { capture }, { "Cache-Control": "no-store" });
        return;
      }

      if (route?.id === "billingConfirm") {
        const body = await readJsonBody(request);
        const result = await billingService.confirmCheckout({
          sessionId: body?.sessionId,
          user: authContext.user,
        });

        const fresh = await authService.getAuthContext(request);
        sendJson(response, 200, { ...result, user: fresh.user }, { "Cache-Control": "no-store" });
        return;
      }

      if (route?.id === "billingPortal") {
        const result = await billingService.createBillingPortalSession({
          request,
          user: authContext.user,
        });

        sendJson(response, 200, result);
        return;
      }

      if (route?.id === "authProfile") {
        const body = await readJsonBody(request);
        const user = await authService.updateProfile(authContext.user.id, body);

        sendJson(response, 200, {
          user,
        });
        return;
      }

      if (route?.id === "apiKeysRead") {
        sendJson(response, 200, {
          apiKeys: await apiKeyService.getSummaries(authContext.user.id),
        });
        return;
      }

      if (route?.id === "apiKeysWrite") {
        sendJson(response, 200, {
          apiKeys: await apiKeyService.updateKeys(
            authContext.user.id,
            await readJsonBody(request),
          ),
        });
        return;
      }

      if (url.pathname === "/api/vault" || url.pathname.startsWith("/api/vault/")) {
        requireExpectedVaultAccount(request, authContext.user);
        if (!canUseCloudWorkspaceStorage(authContext.user)) {
          throw new HttpError(403, "Cloud workspace sync requires a paid plan or an admin account.");
        }
        if (!vaultService) throw new HttpError(503, "Cloud Markdown storage is not configured.");
        const userId = authContext.user.id;
        if (route?.id === "vaultStatus") {
          await sendStreamingJson(response, 200, await vaultService.status(userId), { "Cache-Control": "private, no-store" });
          return;
        }
        if (route?.id === "vaultIndex") {
          await sendStreamingJson(response, 200, await vaultService.index(userId), { "Cache-Control": "private, no-store" });
          return;
        }
        if (route?.id === "vaultChanges") {
          const since = url.searchParams.get("since");
          await sendStreamingJson(response, 200, await vaultService.changes(userId, /^\d{1,15}$/u.test(since ?? "") ? Number(since) : -1), { "Cache-Control": "private, no-store" });
          return;
        }
        if (route?.id === "vaultFileRead") {
          const file = await vaultService.readFile({ userId, path: url.searchParams.get("path"), revision: url.searchParams.get("revision") });
          response.writeHead(200, {
            ...jsonHeaders,
            "Cache-Control": "private, no-store",
            "Content-Type": file.contentType,
            "Content-Length": file.bytes.length,
            "Content-Disposition": "attachment",
            "X-Content-Type-Options": "nosniff",
            ETag: `"${file.revision}"`,
          });
          response.end(file.bytes);
          return;
        }
        if (route?.id === "vaultFileWrite") {
          if (request.headers["x-margin-vault-write"] !== "1" || (!workspaceCredential && request.headers["sec-fetch-site"] === "cross-site")) {
            throw new HttpError(403, "Upload vault files from Margin Chat.");
          }
          const result = await vaultService.commitBinary(userId, {
            path: url.searchParams.get("path"),
            baseRevision: url.searchParams.get("baseRevision") || null,
            contentType: String(request.headers["content-type"] ?? "application/octet-stream"),
            bytes: await readRawBody(request, 4 * 1024 * 1024),
          }, { acknowledge: acknowledgesChanges(url) });
          await sendStreamingJson(response, 200, acknowledgeVaultCommit(result, [url.searchParams.get("path")], url), { "Cache-Control": "private, no-store" });
          return;
        }
        if (route?.id === "vaultCommit" || route?.id === "vaultRebuild") {
          if ((!workspaceCredential && request.headers["sec-fetch-site"] === "cross-site") ||
              !String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
            throw new HttpError(403, "Update your vault from Margin Chat.");
          }
          const body = await readJsonBody(request, 4 * 1024 * 1024);
          const result = route.id === "vaultCommit"
            ? acknowledgeVaultCommit(await vaultService.commit(userId, body?.changes, { acknowledge: acknowledgesChanges(url) }), body.changes.map((change) => change.path), url)
            : await vaultService.rebuild(userId);
          await sendStreamingJson(response, 200, result, { "Cache-Control": "private, no-store" });
          return;
        }
      }

      if (route?.id === "stateRead") {
        if (!canUseCloudWorkspaceStorage(authContext.user)) {
          throw new HttpError(
            403,
            "Cloud workspace sync requires a paid plan or an admin account.",
          );
        }

        if (vaultService?.configured) {
          const { manifest } = await vaultService.status(authContext.user.id);
          const state = await vaultService.readWorkspace(authContext.user.id, manifest);
          if (!state) throw new HttpError(404, "No persisted Markdown workspace was found.");
          sendJson(response, 200, { revision: manifest.revision, workspace: createWorkspaceDocument(state) }, { "Cache-Control": "private, no-store" });
          return;
        }

        if ((await database?.getVaultProjectionRevision?.(authContext.user.id)) != null) {
          throw new HttpError(503, "This workspace's Markdown storage is unavailable. Restore its private Blob configuration before reading cloud content.");
        }

        const storedWorkspace = await database.loadWorkspace(authContext.user.id);

        if (!storedWorkspace) {
          sendJson(response, 404, {
            error: "No persisted app state was found.",
          });
          return;
        }

        sendJson(response, 200, {
          revision: storedWorkspace.revision,
          workspace: createWorkspaceDocument(storedWorkspace.state),
        });
        return;
      }

      if (route?.id === "documentUpload") {
        const form = await readMultipartForm(request, 4 * 1024 * 1024 + 64 * 1024);
        const file = form.get("file");

        if (!file || typeof file === "string") {
          throw new HttpError(400, "A document file is required.");
        }
        const aiField = form.get("ai");
        let aiInput;
        if (aiField !== null) {
          if (typeof aiField !== "string") throw new HttpError(400, "Document AI settings must be JSON text.");
          try { aiInput = JSON.parse(aiField); }
          catch { throw new HttpError(400, "Document AI settings must contain valid JSON."); }
        }
        const ai = validateAIOptions(aiInput);

        const scope = createRequestAbortScope(request, response);
        try {
          const context = await executeChatReply.createUsageContext({
            user: authContext.user, signal: scope.signal, operation: "document-upload",
          });
          const document = await documentService.upload({
            context: { ...context, allowedProviders: ai.allowedProviders }, file, userId: authContext.user.id,
          });
          sendJson(response, 201, { document });
        } finally {
          scope.dispose();
        }
        return;
      }

      if (route?.id === "documentOriginal") {
        requireExpectedVaultAccount(request, authContext.user);
        const documentId = decodePathParameter(route.params.id);
        const original = vaultService?.configured
          ? await vaultService.readAttachment({ userId: authContext.user.id, documentId })
          : await database.getVaultAttachment({ userId: authContext.user.id, documentId });
        if (!original) throw new HttpError(404, "Document original not found.");
        if (url.searchParams.get("metadata") === "1") {
          const { bytes: _bytes, ...attachment } = original;
          sendJson(response, 200, { attachment }, { "Cache-Control": "private, no-store" });
          return;
        }
        response.writeHead(200, {
          ...jsonHeaders,
          "Cache-Control": "private, no-store",
          "Content-Type": original.mimeType || "application/octet-stream",
          "Content-Length": original.bytes.length,
          "Content-Disposition": "attachment",
          "X-Content-Type-Options": "nosniff",
        });
        response.end(original.bytes);
        return;
      }

      if (route?.id === "documentDelete") {
        const documentId = decodePathParameter(route.params.id);
        const deleted = await documentService.delete(documentId, authContext.user.id);

        if (!deleted) {
          throw new HttpError(404, "Document not found.");
        }

        sendJson(response, 200, { deleted: true });
        return;
      }

      if (route?.id === "stateWrite") {
        if (!canUseCloudWorkspaceStorage(authContext.user)) {
          throw new HttpError(
            403,
            "Cloud workspace sync requires a paid plan or an admin account.",
          );
        }

        if (vaultService?.configured || (await database?.getVaultProjectionRevision?.(authContext.user.id)) != null) {
          throw new HttpError(409, "This workspace uses Markdown file sync. Reload Margin Chat to update this older client. Whole-workspace uploads are disabled.");
        }

        const body = await readJsonBody(request, LARGE_JSON_BODY_LIMIT);
        const workspaceState = body?.workspace
          ? createAppStateFromWorkspaceDocument(body.workspace)
          : body;

        if (!workspaceState) {
          throw new HttpError(400, "Workspace document is invalid.");
        }

        const persistedWorkspace = await database.saveState(
          authContext.user.id,
          workspaceState,
          {
            expectedRevision:
              Number.isInteger(body?.baseRevision) && body.baseRevision >= 0
                ? body.baseRevision
                : null,
          },
        );

        sendJson(response, 200, {
          revision: persistedWorkspace.revision,
          workspace: createWorkspaceDocument(persistedWorkspace.state),
        });
        return;
      }

      if (route?.id === "chat") {
        await handleChatRequest({ request, response, user: authContext.user, executeChatReply });
        return;
      }

      if (route?.id === "chatTitle") {
        const body = await readJsonBody(request);
        const scope = createRequestAbortScope(request, response);
        try {
          const titleResponse = await executeChatReply({
            payload: body, user: authContext.user, signal: scope.signal, operation: "title",
          });
          sendJson(response, 200, titleResponse);
        } finally {
          scope.dispose();
        }
        return;
      }

      sendJson(response, 404, {
        error: "Not found",
      });
    } catch (error) {
      if (response.destroyed) return;
      if (response.headersSent) {
        if (!response.writableEnded) {
          writeChatStreamEvent(response, {
            error:
              error instanceof HttpError || hasStatusCode(error)
                ? error.message
                : "The model stream ended unexpectedly.",
            statusCode:
              error instanceof HttpError || hasStatusCode(error)
                ? error.statusCode
                : 500,
            type: "error",
          });
          response.end();
        }

        if (!(error instanceof HttpError) && !hasStatusCode(error)) {
          console.error(error);
        }

        return;
      }

      if (error instanceof HttpError || hasStatusCode(error)) {
        if (Array.isArray(error.conflicts)) {
          try {
            await sendStreamingJson(response, error.statusCode, {
              error: error.message, conflicts: error.conflicts, manifest: error.manifest,
            }, { "Cache-Control": "private, no-store" });
          } catch (streamError) {
            if (!response.destroyed) throw streamError;
          }
          return;
        }
        sendJson(response, error.statusCode, {
          error: error.message,
        }, error.headers);
        return;
      }

      console.error(error);
      sendJson(response, 500, {
        error: "Unexpected server error.",
      });
    }
  };
}
