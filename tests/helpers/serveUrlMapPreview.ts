import { basename } from "node:path";
import { createServer } from "node:http";
import { createApiHandler } from "../../server/routes/api.mjs";
import { createUrlMapService } from "../../server/urlMap/index.mjs";
import { extractPage } from "../../server/urlMap/page.mjs";
import { HttpError } from "../../server/lib/errors.mjs";
import { urlMapHtml, urlMapModelReply } from "./urlMapFixture";

const build = await Bun.build({ entrypoints: [new URL("./urlMapPreview.tsx", import.meta.url).pathname], target: "browser", sourcemap: "inline", define: { "process.env.NODE_ENV": '"development"' } });
if (!build.success) { console.error(build.logs); process.exit(1); }
const assets = new Map(build.outputs.map((output) => [`/${basename(output.path)}`, output]));
const html = `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>URL map testing</title>${[...assets.keys()].filter((path) => path.endsWith(".css")).map((path) => `<link rel="stylesheet" href="${path}">`).join("")}</head><body style="margin:0"><div id="root"></div>${[...assets.keys()].filter((path) => path.endsWith(".js")).map((path) => `<script type="module" src="${path}"></script>`).join("")}</body></html>`;
const handler = createApiHandler({ runtimeConfig: { host: "127.0.0.1", port: 5184 }, authService: { getAuthContext: async (request: import("node:http").IncomingMessage) => ({ user: { id: previewUser(request) } }) }, urlMapService: createUrlMapService({
  readPage: async (url: string, { signal }: { signal: AbortSignal }) => {
    if (url.includes("failure")) throw new HttpError(422, "This fixture page could not be read. Try another URL.");
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, url.includes("slow") ? 30_000 : 250); signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); });
    return extractPage(urlMapHtml, url);
  }, executeChatReply: async () => ({ reply: urlMapModelReply }),
}) });
// The preview answers AI questions and keeps its account copy in memory.
// One account per ?user= on the page, so separate preview runs start clean.
function previewUser(request: import("node:http").IncomingMessage) { return new URL(request.headers.referer ?? "http://preview/").searchParams.get("user") ?? "url-map-preview"; }
const accountMaps = new Map<string, unknown>();
async function body(request: import("node:http").IncomingMessage) { let text = ""; for await (const chunk of request) text += chunk; return text ? JSON.parse(text) : null; }
createServer(async (request, response) => {
  if (request.url === "/api/graph/ask") {
    const { question } = await body(request);
    response.writeHead(200, { "Content-Type": "application/x-ndjson" });
    response.write(`${JSON.stringify({ type: "progress", message: "Thinking about your question…" })}\n`);
    await new Promise((resolve) => setTimeout(resolve, 400));
    response.end(`${JSON.stringify({ type: "done", answer: { question, answer: "Signals hold a value and notify what reads them when it changes, so Angular updates only the parts of the page that depend on it. Computed signals derive values; effects run side effects.",
      related: [{ id: "Q28925578", label: "Angular (web framework)", description: "TypeScript-based web framework", relation: "used in" }, { id: "Q1194276", label: "Reactive programming", description: "programming paradigm", relation: "is a form of" }] } })}\n`);
    return;
  }
  if (request.url === "/api/public-map/state") {
    const user = previewUser(request);
    if (request.method === "PUT") { accountMaps.set(user, (await body(request)).state); response.writeHead(200, { "Content-Type": "application/json" }); response.end("{}"); return; }
    response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ state: accountMaps.get(user) ?? null, revision: 1 })); return;
  }
  if (request.url?.startsWith("/api/public-map/answers")) { response.writeHead(200, { "Content-Type": "application/json" }); response.end(JSON.stringify({ answers: [] })); return; }
  if (request.url?.startsWith("/api/")) return handler(request, response);
  if (request.url === "/" || request.url?.startsWith("/?")) { response.writeHead(200, { "Content-Type": "text/html" }); response.end(html); return; }
  const asset = assets.get(request.url ?? "");
  if (!asset) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "Content-Type": asset.type }); response.end(Buffer.from(await asset.arrayBuffer()));
}).listen(5184, "127.0.0.1", () => console.log("URL map preview: http://127.0.0.1:5184"));
