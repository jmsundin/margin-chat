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
const handler = createApiHandler({ runtimeConfig: { host: "127.0.0.1", port: 5184 }, authService: { getAuthContext: async () => ({ user: { id: "url-map-preview" } }) }, urlMapService: createUrlMapService({
  readPage: async (url: string, { signal }: { signal: AbortSignal }) => {
    if (url.includes("failure")) throw new HttpError(422, "This fixture page could not be read. Try another URL.");
    await new Promise<void>((resolve, reject) => { const timer = setTimeout(resolve, url.includes("slow") ? 30_000 : 250); signal.addEventListener("abort", () => { clearTimeout(timer); reject(signal.reason); }, { once: true }); });
    return extractPage(urlMapHtml, url);
  }, executeChatReply: async () => ({ reply: urlMapModelReply }),
}) });
createServer(async (request, response) => {
  if (request.url?.startsWith("/api/")) return handler(request, response);
  if (request.url === "/") { response.writeHead(200, { "Content-Type": "text/html" }); response.end(html); return; }
  const asset = assets.get(request.url ?? "");
  if (!asset) { response.writeHead(404); response.end(); return; }
  response.writeHead(200, { "Content-Type": asset.type }); response.end(Buffer.from(await asset.arrayBuffer()));
}).listen(5184, "127.0.0.1", () => console.log("URL map preview: http://127.0.0.1:5184"));
