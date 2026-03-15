import { jsonHeaders, readJsonBody, sendJson } from "../http/json.mjs";
import { HttpError, hasStatusCode } from "../lib/errors.mjs";

export function createApiHandler({ chatService, database, runtimeConfig }) {
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

      if (request.method === "GET" && url.pathname === "/api/state") {
        const state = await database.loadState();

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
        const persistedState = await database.saveState(body);

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
