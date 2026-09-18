/** Real application + persistent isolated database; only the explicit env file is loaded. */
import { createServer } from "node:http";
import { readFile, stat } from "node:fs/promises";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createAppContext } from "../server/app.mjs";
import { loadStripeTestEnv, STRIPE_TEST_ORIGIN } from "./stripe-test-config.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const env = loadStripeTestEnv(process.argv[2]);
await stat(join(dist, "index.html")).catch(() => { throw new Error("Build the client first with bun run build."); });
const { apiHandler, database } = createAppContext(env);
await database.ready();
const mime = { ".html": "text/html; charset=utf-8", ".js": "text/javascript; charset=utf-8", ".css": "text/css; charset=utf-8", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json", ".png": "image/png", ".ico": "image/x-icon", ".woff2": "font/woff2" };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, STRIPE_TEST_ORIGIN);
    if (url.pathname === "/api" || url.pathname.startsWith("/api/")) {
      return await apiHandler(request, response);
    }
    if (!["GET", "HEAD"].includes(request.method)) {
      response.writeHead(405, { Allow: "GET, HEAD" }); response.end(); return;
    }
    const path = resolve(dist, `.${decodeURIComponent(url.pathname)}`);
    if (path !== dist && !path.startsWith(`${dist}${sep}`)) {
      response.writeHead(400); response.end("Invalid path"); return;
    }
    let filename = path;
    try { if (!(await stat(filename)).isFile()) filename = join(dist, "index.html"); }
    catch { filename = join(dist, "index.html"); }
    const bytes = await readFile(filename);
    response.writeHead(200, { "Content-Type": mime[extname(filename)] ?? "application/octet-stream", "Content-Length": bytes.length, "Cache-Control": "no-store", "X-Content-Type-Options": "nosniff" });
    response.end(request.method === "HEAD" ? undefined : bytes);
  } catch (error) {
    if (!response.headersSent) response.writeHead(error.statusCode ?? 500, { "Content-Type": "application/json", "Cache-Control": "no-store" });
    response.end(JSON.stringify({ error: "Local Stripe test request failed." }));
    // Errors may contain provider request details; print no credentials or raw payloads.
    console.error(`Local request failed (${error.name ?? "Error"}).`);
  }
});
server.on("error", async () => { console.error("Unable to bind the isolated test server; check port 4175."); await database.close(); process.exitCode = 1; });
server.listen(4175, "127.0.0.1", () => {
  console.log(`Isolated Stripe test app: ${STRIPE_TEST_ORIGIN}`);
  console.log(`Database ready; Stripe test key ${env.STRIPE_SECRET_KEY ? "configured" : "not yet configured"}; webhook ${env.STRIPE_WEBHOOK_SECRET ? "configured" : "not yet configured"}.`);
});
let stopping = false;
async function stop() {
  if (stopping) return; stopping = true;
  const timeout = setTimeout(() => process.exit(0), 5000); timeout.unref();
  server.close(async () => { await database.close(); clearTimeout(timeout); process.exit(0); });
  server.closeIdleConnections();
}
process.on("SIGTERM", stop);
process.on("SIGINT", stop);
