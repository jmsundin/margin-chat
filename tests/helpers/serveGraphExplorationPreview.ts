import { basename } from "node:path";

// Dedicated, loopback-only fixture server. It has no app API or auth routes.
const build = await Bun.build({
  entrypoints: [new URL("./graphExplorationPreview.tsx", import.meta.url).pathname],
  target: "browser",
  minify: false,
  sourcemap: "inline",
  define: { "process.env.NODE_ENV": '"development"' },
});
if (!build.success) {
  for (const log of build.logs) console.error(log);
  process.exit(1);
}

const assets = new Map(build.outputs.map((output) => [`/${basename(output.path)}`, output]));
const scripts = [...assets.keys()].filter((path) => path.endsWith(".js"));
const styles = [...assets.keys()].filter((path) => path.endsWith(".css"));
const html = `<!doctype html><html lang="en" data-theme="dark"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Graph exploration preview</title>${styles.map((path) => `<link rel="stylesheet" href="${path}">`).join("")}<style>body{margin:0}button{cursor:pointer}</style></head><body><div id="root"></div>${scripts.map((path) => `<script type="module" src="${path}"></script>`).join("")}</body></html>`;
const server = Bun.serve({
  hostname: "127.0.0.1",
  port: 5178,
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/") return new Response(html, { headers: { "Content-Type": "text/html", "Cache-Control": "no-store" } });
    const asset = assets.get(path);
    if (asset) return new Response(asset, { headers: { "Cache-Control": "no-store" } });
    return new Response("Not found", { status: 404 });
  },
});
console.log(`Synthetic graph preview: ${server.url}`);
