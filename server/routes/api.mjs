import { jsonHeaders, readJsonBody, sendJson } from "../http/json.mjs";
import { HttpError, hasStatusCode } from "../lib/errors.mjs";

export function createApiHandler({
  authService,
  chatService,
  database,
  runtimeConfig,
}) {
  const fallbackHost = `${runtimeConfig.host}:${runtimeConfig.port}`;

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
        sendJson(response, 200, chatService.buildHealthPayload(database.getHealth()));
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

      if (request.method === "PUT" && url.pathname === "/api/auth/profile") {
        const body = await readJsonBody(request);
        const user = await authService.updateProfile(authContext.user.id, body);

        sendJson(response, 200, {
          user,
        });
        return;
      }

      if (request.method === "GET" && url.pathname === "/api/state") {
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

      if (request.method === "PUT" && url.pathname === "/api/state") {
        const body = await readJsonBody(request);
        const persistedState = await database.saveState(authContext.user.id, body);

        sendJson(response, 200, persistedState);
        return;
      }

      if (request.method === "POST" && url.pathname === "/api/chat") {
        const body = await readJsonBody(request);
        const chatResponse = await chatService.requestReply(body);

        sendJson(response, 200, chatResponse);
        return;
      }

      sendJson(response, 404, {
        error: "Not found",
      });
    } catch (error) {
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
