import { createServer } from "node:http";
import path from "node:path";
import { timingSafeEqual } from "node:crypto";
import { createAppContext } from "../app.mjs";

/** The desktop app adds this header to every request it forwards; nothing else on the computer knows the token. */
export const LOCAL_TOKEN_HEADER = "x-margin-local-token";

/** The settings local mode runs with. Hosted keys from the surrounding shell never reach it: AI uses the person's own keys. */
export function localModeEnv({ dataDir, encryptionKey }) {
  if (!dataDir) throw new Error("Local mode needs a folder for its data.");
  if (!encryptionKey) throw new Error("Local mode needs a key to lock saved API keys.");
  return {
    MARGIN_LOCAL_MODE: "1",
    MARGIN_LOCAL_DATA_DIR: dataDir,
    VAULT_STORAGE_DIR: path.join(dataDir, "vault"),
    API_KEY_ENCRYPTION_KEY: encryptionKey,
    HOST: "127.0.0.1",
  };
}

function sameToken(given, expected) {
  if (typeof given !== "string" || given.length !== expected.length) return false;
  return timingSafeEqual(Buffer.from(given), Buffer.from(expected));
}

/**
 * Runs Margin Chat's server inside the desktop app, on a loopback port only this app can use.
 * Resolves once it is listening; the database opens (and migrates) on the first request.
 */
export async function startLocalServer({ dataDir, encryptionKey, token, port = 0 }) {
  if (typeof token !== "string" || token.length < 32) throw new Error("Local mode needs a long random token.");
  const env = localModeEnv({ dataDir, encryptionKey });
  const context = createAppContext(env);
  const server = createServer((request, response) => {
    if (!sameToken(request.headers[LOCAL_TOKEN_HEADER], token)) {
      response.writeHead(403, { "Content-Type": "application/json" });
      response.end(JSON.stringify({ error: "Only the Margin Chat app can use this server." }));
      return;
    }
    context.apiHandler(request, response);
  });
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, "127.0.0.1", () => { server.off("error", reject); resolve(); });
  });
  const address = server.address();
  return {
    url: `http://127.0.0.1:${address.port}`,
    ready: () => context.database.ready(),
    async close() {
      await new Promise((resolve) => server.close(() => resolve()));
      await context.database.close?.();
    },
  };
}
