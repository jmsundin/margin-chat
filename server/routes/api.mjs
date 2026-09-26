import {
  jsonHeaders,
  readMultipartForm,
  readJsonBody,
  readRawBody,
  sendJson,
} from "../http/json.mjs";
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

function requireExpectedVaultAccount(request, user) {
  const expectedUser = request.headers["x-margin-vault-user"];
  if (expectedUser !== undefined && expectedUser !== String(user.id)) {
    throw new HttpError(409, "The signed-in account changed. Reload Margin Chat before synchronizing this device's vault.");
  }
}

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
}) {
  const fallbackHost = `${runtimeConfig.host}:${runtimeConfig.port}`;

  const executeChatReply = createChatExecutionService({ apiKeyService, billingService, chatService, database });
  const mapUrl = urlMapService ?? createUrlMapService({ executeChatReply });
  const expandTopic = topicExpansionService ?? createTopicExpansionService({ executeChatReply });

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

      if (route?.id === "extensionSession") {
        response.setHeader("Cache-Control", "no-store");
        if (request.method === "POST") {
          const user = await authService.authenticateCredentials(await readJsonBody(request, 16_384));
          const session = await captureService.issueSession(user, runtimeConfig.authSessionTtlMs);
          sendJson(response, 201, session);
        } else {
          await captureService.signOut(request);
          sendJson(response, 200, { ok: true });
        }
        return;
      }

      // Capture credentials never authenticate workspace, chat, or account endpoints.
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

      const authContext = await authService.getAuthContext(request);
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
        const body = await readJsonBody(request);
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
        const body = await readJsonBody(request);
        const result = await authService.login(body);

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
        const result = await authService.requestPasswordReset(await readJsonBody(request));

        sendJson(response, 200, result);
        return;
      }

      if (route?.id === "passwordResetConfirm") {
        const result = await authService.resetPassword(await readJsonBody(request));

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

      if (["documentUpload", "documentDelete", "chat", "chatTitle", "urlMap", "topicExpansion", "jevStatus", "jevWorkspace", "jevSearch"].includes(route?.id)) {
        requireExpectedVaultAccount(request, authContext.user);
      }

      if (route?.id === "passwordChange") {
        const result = await authService.changePassword(
          authContext.user.id,
          authContext.sessionId,
          await readJsonBody(request, 16_384),
        );
        sendJson(response, 200, { ok: true }, {
          "Cache-Control": "no-store",
          "Set-Cookie": result.cookie,
        });
        return;
      }

      if (route?.id === "urlMap") {
        await handleUrlMapRequest({ request, response, user: authContext.user, mapUrl });
        return;
      }

      if (route?.id === "topicExpansion") {
        await handleTopicExpansionRequest({ request, response, user: authContext.user, expandTopic });
        return;
      }

      if (route?.id === "jevStatus") {
        sendJson(response, 200, { configured: Boolean(semanticService?.configured) }, { "Cache-Control": "private, no-store" });
        return;
      }

      if (route?.id === "jevWorkspace" || route?.id === "jevSearch") {
        if (request.headers["sec-fetch-site"] === "cross-site"
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
        const fresh = await authService.getAuthContext(request);
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
        if (route?.id === "vaultFileRead") {
          const file = await vaultService.readFile({ userId, path: url.searchParams.get("path"), revision: url.searchParams.get("revision") });
          response.writeHead(200, {
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
          if (request.headers["x-margin-vault-write"] !== "1" || request.headers["sec-fetch-site"] === "cross-site") {
            throw new HttpError(403, "Upload vault files from Margin Chat.");
          }
          const result = await vaultService.commitBinary(userId, {
            path: url.searchParams.get("path"),
            baseRevision: url.searchParams.get("baseRevision") || null,
            contentType: String(request.headers["content-type"] ?? "application/octet-stream"),
            bytes: await readRawBody(request, 4 * 1024 * 1024),
          });
          await sendStreamingJson(response, 200, result, { "Cache-Control": "private, no-store" });
          return;
        }
        if (route?.id === "vaultCommit" || route?.id === "vaultRebuild") {
          if (request.headers["sec-fetch-site"] === "cross-site" ||
              !String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
            throw new HttpError(403, "Update your vault from Margin Chat.");
          }
          const body = await readJsonBody(request, 4 * 1024 * 1024);
          const result = route.id === "vaultCommit"
            ? await vaultService.commit(userId, body?.changes)
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
        const documentId = decodeURIComponent(route.params.id);
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
        const deleted = await documentService.delete(
          decodeURIComponent(route.params.id),
          authContext.user.id,
        );

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

        const body = await readJsonBody(request);
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
        });
        return;
      }

      console.error(error);
      sendJson(response, 500, {
        error: "Unexpected server error.",
      });
    }
  };
}
