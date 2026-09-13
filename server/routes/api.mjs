import {
  jsonHeaders,
  readMultipartForm,
  readJsonBody,
  readRawBody,
  sendJson,
} from "../http/json.mjs";
import { randomUUID } from "node:crypto";
import { CAPTURE_API_PATH, CONNECTION_API_PATH } from "@margin-chat/capture-contracts";
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
}) {
  const fallbackHost = `${runtimeConfig.host}:${runtimeConfig.port}`;

  function writeChatStreamEvent(response, event) {
    response.write(`${JSON.stringify(event)}\n`);
    response.flush?.();
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

      if (request.method === "GET" && url.pathname === "/api/health") {
        try {
          await database.ready();
        } catch {
          // Health responses should still return the degraded payload.
        }

        sendJson(response, 200, chatService.buildHealthPayload(database.getHealth()));
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/billing/webhook") {
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

      // Capture credentials never authenticate workspace, chat, or account endpoints.
      if ((request.method === "POST" && url.pathname === CAPTURE_API_PATH) ||
          (request.method === "GET" && url.pathname === CONNECTION_API_PATH)) {
        const user = await captureService.connect(request);
        if (request.method === "GET") {
          sendJson(response, 200, { displayName: user.displayName, expiresAt: user.expiresAt }, { "Cache-Control": "no-store" });
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

      if (request.method === "GET" && url.pathname === "/api/auth/session") {
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

      if (request.method === "POST" && url.pathname === "/api/auth/signup") {
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

      if (request.method === "POST" && url.pathname === "/api/auth/login") {
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

      if (
        request.method === "POST" &&
        url.pathname === "/api/auth/password-reset/request"
      ) {
        const result = await authService.requestPasswordReset(await readJsonBody(request));

        sendJson(response, 200, result);
        return;
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/auth/password-reset/confirm"
      ) {
        const result = await authService.resetPassword(await readJsonBody(request));

        sendJson(response, 200, result, {
          "Set-Cookie": authService.buildClearedSessionCookie(),
        });
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/auth/logout") {
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

      if (request.method === "POST" && url.pathname === "/api/billing/checkout") {
        const result = await billingService.createSubscriptionCheckoutSession({
          request,
          user: authContext.user,
        });

        sendJson(response, 200, result);
        return;
      }

      if (url.pathname === "/api/settings/capture-token") {
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

      if (request.method === "GET" && url.pathname === CAPTURE_API_PATH) {
        requireCaptureAccess(authContext.user);
        sendJson(response, 200, await captureService.list(authContext.user.id, url.searchParams.get("cursor")), { "Cache-Control": "no-store" });
        return;
      }
      const captureMatch = url.pathname.match(/^\/api\/v1\/captures\/([0-9a-f-]{36})$/u);
      if (request.method === "GET" && captureMatch) {
        requireCaptureAccess(authContext.user);
        const capture = await database.getCapture({ userId: authContext.user.id, id: captureMatch[1] });
        if (!capture) throw new HttpError(404, "Capture not found.");
        sendJson(response, 200, { capture }, { "Cache-Control": "no-store" });
        return;
      }

      if (
        request.method === "POST" &&
        url.pathname === "/api/billing/checkout/confirm"
      ) {
        const body = await readJsonBody(request);
        const result = await billingService.confirmSubscriptionCheckout({
          sessionId: body?.sessionId,
          user: authContext.user,
        });

        sendJson(response, 200, result);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/billing/portal") {
        const result = await billingService.createBillingPortalSession({
          request,
          user: authContext.user,
        });

        sendJson(response, 200, result);
        return;
      }

      if (request.method === "PUT" && url.pathname === "/api/auth/profile") {
        const body = await readJsonBody(request);
        const user = await authService.updateProfile(authContext.user.id, body);

        sendJson(response, 200, {
          user,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/settings/api-keys") {
        sendJson(response, 200, {
          apiKeys: await apiKeyService.getSummaries(authContext.user.id),
        });
        return;
      }

      if (request.method === "PUT" && url.pathname === "/api/settings/api-keys") {
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
        if (request.method === "GET" && url.pathname === "/api/vault") {
          sendJson(response, 200, await vaultService.status(userId), { "Cache-Control": "private, no-store" });
          return;
        }
        if (request.method === "GET" && url.pathname === "/api/vault/file") {
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
        if (request.method === "PUT" && url.pathname === "/api/vault/file") {
          if (request.headers["x-margin-vault-write"] !== "1" || request.headers["sec-fetch-site"] === "cross-site") {
            throw new HttpError(403, "Upload vault files from Margin Chat.");
          }
          const result = await vaultService.commitBinary(userId, {
            path: url.searchParams.get("path"),
            baseRevision: url.searchParams.get("baseRevision") || null,
            contentType: String(request.headers["content-type"] ?? "application/octet-stream"),
            bytes: await readRawBody(request, 4 * 1024 * 1024),
          });
          sendJson(response, 200, result, { "Cache-Control": "private, no-store" });
          return;
        }
        if (request.method === "POST" && ["/api/vault/commit", "/api/vault/rebuild"].includes(url.pathname)) {
          if (request.headers["sec-fetch-site"] === "cross-site" ||
              !String(request.headers["content-type"] ?? "").toLowerCase().startsWith("application/json")) {
            throw new HttpError(403, "Update your vault from Margin Chat.");
          }
          const body = await readJsonBody(request, 4 * 1024 * 1024);
          const result = url.pathname === "/api/vault/commit"
            ? await vaultService.commit(userId, body?.changes)
            : await vaultService.rebuild(userId);
          sendJson(response, 200, result, { "Cache-Control": "private, no-store" });
          return;
        }
      }

      if (request.method === "GET" && url.pathname === "/api/state") {
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

      if (request.method === "POST" && url.pathname === "/api/documents") {
        const form = await readMultipartForm(request, 4 * 1024 * 1024 + 64 * 1024);
        const file = form.get("file");

        if (!file || typeof file === "string") {
          throw new HttpError(400, "A document file is required.");
        }

        const document = await documentService.upload({
          context: {
            allowHosted: authContext.user.billing.hasAccess,
            apiKeys: await apiKeyService.getDecryptedKeys(authContext.user.id),
          },
          file,
          userId: authContext.user.id,
        });

        sendJson(response, 201, { document });
        return;
      }

      const originalMatch = url.pathname.match(/^\/api\/documents\/([^/]+)\/original$/u);
      if (request.method === "GET" && originalMatch) {
        requireExpectedVaultAccount(request, authContext.user);
        const documentId = decodeURIComponent(originalMatch[1]);
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

      const documentMatch = url.pathname.match(/^\/api\/documents\/([^/]+)$/u);

      if (request.method === "DELETE" && documentMatch) {
        const deleted = await documentService.delete(
          decodeURIComponent(documentMatch[1]),
          authContext.user.id,
        );

        if (!deleted) {
          throw new HttpError(404, "Document not found.");
        }

        sendJson(response, 200, { deleted: true });
        return;
      }

      if (request.method === "PUT" && url.pathname === "/api/state") {
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

      if (request.method === "POST" && url.pathname === "/api/chat") {
        const body = await readJsonBody(request);
        const apiKeys = await apiKeyService.getDecryptedKeys(authContext.user.id);
        const chatContext = {
          allowHosted: authContext.user.billing.hasAccess,
          apiKeys,
          userId: authContext.user.id,
        };
        const plannedCredentialSource = chatService.getPlannedCredentialSource(
          body,
          chatContext,
        );
        if (plannedCredentialSource === "hosted") {
          chatContext.hostedMaxOutputTokens =
            billingService.getHostedUsageLimits(body).maxOutputTokens;
        }
        const requestId = randomUUID();
        const reservation =
          plannedCredentialSource === "hosted" &&
          authContext.user.billing.accessKind === "credits"
            ? await billingService.reserveHostedRequest({
                requestId,
                userId: authContext.user.id,
              })
            : null;
        let providerStarted = false;
        let chatResponse;

        try {
          chatResponse = await chatService.requestReplyStream(
            body,
            chatContext,
            {
              onDelta(delta) {
                writeChatStreamEvent(response, { delta, type: "delta" });
              },
              onReady(metadata) {
                providerStarted = true;

                if (!response.headersSent) {
                  response.writeHead(200, {
                    "Access-Control-Allow-Origin": "*",
                    "Cache-Control": "no-cache, no-transform",
                    "Content-Type": "application/x-ndjson; charset=utf-8",
                    "X-Accel-Buffering": "no",
                  });
                  response.flushHeaders?.();
                }

                writeChatStreamEvent(response, { metadata, type: "metadata" });
              },
            },
          );
        } catch (error) {
          if (reservation && !providerStarted) {
            await billingService.refundHostedRequest({
              amountMicros: reservation.amountMicros,
              requestId,
              userId: authContext.user.id,
            });
          }

          throw error;
        }

        if (
          authContext.user.billing.accessKind === "trial" &&
          chatResponse.metadata.credentialSource === "hosted"
        ) {
          await database.incrementTrialApiCallsUsed(authContext.user.id);
        }

        writeChatStreamEvent(response, {
          metadata: chatResponse.metadata,
          type: "done",
        });
        response.end();
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/chat/title") {
        const body = await readJsonBody(request);
        const titleResponse = await chatService.generateTitle(
          body,
          {
            allowHosted: authContext.user.billing.hasAccess,
            apiKeys: await apiKeyService.getDecryptedKeys(authContext.user.id),
            hostedMaxOutputTokens:
              billingService.getHostedUsageLimits(body).maxOutputTokens,
            userId: authContext.user.id,
          },
        );

        sendJson(response, 200, titleResponse);
        return;
      }

      sendJson(response, 404, {
        error: "Not found",
      });
    } catch (error) {
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
        sendJson(response, error.statusCode, {
          error: error.message,
          ...(Array.isArray(error.conflicts) ? { conflicts: error.conflicts, manifest: error.manifest } : {}),
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
