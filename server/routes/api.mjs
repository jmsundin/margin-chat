import {
  jsonHeaders,
  readMultipartForm,
  readJsonBody,
  readRawBody,
  sendJson,
} from "../http/json.mjs";
import { randomUUID } from "node:crypto";
import { HttpError, hasStatusCode } from "../lib/errors.mjs";

export function canUseCloudWorkspaceStorage(user) {
  return (
    user?.role === "admin" || user?.billing?.accessKind === "subscription"
  );
}

export function createApiHandler({
  apiKeyService,
  authService,
  billingService,
  chatService,
  database,
  documentService,
  runtimeConfig,
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

      if (request.method === "GET" && url.pathname === "/api/state") {
        if (!canUseCloudWorkspaceStorage(authContext.user)) {
          throw new HttpError(
            403,
            "Cloud workspace sync requires a paid plan or an admin account.",
          );
        }

        const state = await database.loadState(authContext.user.id);

        if (!state) {
          sendJson(response, 404, {
            error: "No persisted app state was found.",
          });
          return;
        }

        sendJson(response, 200, state);
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

        const body = await readJsonBody(request);
        const persistedState = await database.saveState(authContext.user.id, body);

        sendJson(response, 200, persistedState);
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
