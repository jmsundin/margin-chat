// Dedicated, loopback-only fixture server. It has no app API or auth routes.
import { basename } from "node:path";
const build = await Bun.build({ entrypoints: [new URL("./landscapeHullsPreview.tsx", import.meta.url).pathname], target: "browser", define: { "process.env.NODE_ENV": '"development"' } });
if (!build.success) { for (const l of build.logs) console.error(l); process.exit(1); }
const assets = new Map(build.outputs.map((o) => [`/${basename(o.path)}`, o]));
const html = `<!doctype html><html><head>${[...assets.keys()].filter(p=>p.endsWith(".css")).map(p=>`<link rel="stylesheet" href="${p}">`).join("")}</head><body style="margin:0"><div id="root"></div>${[...assets.keys()].filter(p=>p.endsWith(".js")).map(p=>`<script type="module" src="${p}"></script>`).join("")}</body></html>`;
Bun.serve({ hostname: "127.0.0.1", port: Number(process.env.PORT ?? 5192), fetch(r) { const p = new URL(r.url).pathname; if (p === "/") return new Response(html, { headers: { "Content-Type": "text/html" } }); const a = assets.get(p); return a ? new Response(a) : new Response("nf", { status: 404 }); } });
console.log("Landscape outlines preview: http://127.0.0.1:" + (process.env.PORT ?? 5192));
