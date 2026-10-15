// Loopback-only static fixture for the Live Preview document editor. No app API, account, or vault access.
import { basename } from "node:path";
const build = await Bun.build({ entrypoints: [new URL("./liveDocumentPreview.tsx", import.meta.url).pathname], target: "browser", define: { "process.env.NODE_ENV": '"development"' } });
if (!build.success) { for (const log of build.logs) console.error(log); process.exit(1); }
const assets = new Map(build.outputs.map((o) => [`/${basename(o.path)}`, o]));
const theme = process.env.THEME ?? "dark";
const html = `<!doctype html><html lang="en" data-theme="${theme}"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">${[...assets.keys()].filter((p) => p.endsWith(".css")).map((p) => `<link rel="stylesheet" href="${p}">`).join("")}<style>body{margin:0;background:var(--bg)}</style></head><body><div id="root"></div>${[...assets.keys()].filter((p) => p.endsWith(".js")).map((p) => `<script type="module" src="${p}"></script>`).join("")}</body></html>`;
const server = Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT ?? 5190), fetch(r) { const p = new URL(r.url).pathname; if (p === "/") return new Response(html, { headers: { "Content-Type": "text/html" } }); const a = assets.get(p); return a ? new Response(a) : new Response("nf", { status: 404 }); } });
console.log(server.url.href);
