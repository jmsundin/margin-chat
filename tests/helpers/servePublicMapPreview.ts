import { basename } from "node:path";

const build = await Bun.build({ entrypoints: [new URL("./publicMapPreview.tsx", import.meta.url).pathname], target: "browser", sourcemap: "inline", define: { "process.env.NODE_ENV": '"development"' } });
if (!build.success) { console.error(build.logs); process.exit(1); }
const assets = new Map(build.outputs.map((output) => [`/${basename(output.path)}`, output]));
const html = `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Public map preview</title>${[...assets.keys()].filter((path) => path.endsWith(".css")).map((path) => `<link rel="stylesheet" href="${path}">`).join("")}</head><body style="margin:0"><div id="root"></div>${[...assets.keys()].filter((path) => path.endsWith(".js")).map((path) => `<script type="module" src="${path}"></script>`).join("")}</body></html>`;
const server = Bun.serve({ hostname: "127.0.0.1", port: 5182, async fetch(request) {
  const path = new URL(request.url).pathname;
  if (path === "/api/graph/topic" && request.method === "POST") {
    // Synthetic drafts only: this fixture never calls a paid AI provider.
    await new Promise((resolve) => setTimeout(resolve, 700));
    return new Response(JSON.stringify({ type: "done", expansion: { nodes: [
      { id: "structure", parentId: null, title: "Structure and relationships", content: "Describe the parts of the system and how they affect one another." },
      { id: "feedback", parentId: null, title: "Feedback loops", content: "Explore how a change can feed back into the process that caused it." },
      { id: "reinforcing", parentId: "feedback", title: "Reinforcing feedback", content: "A reinforcing loop amplifies an initial change. Look for examples and limits." },
    ] } }) + "\n", { headers: { "Content-Type": "application/x-ndjson" } });
  }
  if (path === "/") return new Response(html, { headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } });
  const asset = assets.get(path); return asset ? new Response(asset) : new Response("Not found", { status: 404 });
} });
console.log(`Public map preview: ${server.url}`);
