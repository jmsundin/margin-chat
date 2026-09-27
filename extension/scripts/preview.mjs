import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const result = await Bun.build({ entrypoints: [resolve(root, "preview/preview.ts")], target: "browser", format: "esm" });
if (!result.success) throw new Error(result.logs.join("\n"));
const script = await result.outputs[0].text();
const server = Bun.serve({
  hostname: "127.0.0.1", port: Number(process.env.MARGIN_PREVIEW_PORT || 5194),
  fetch(request) {
    const path = new URL(request.url).pathname;
    if (path === "/preview.js") return new Response(script, { headers: { "Content-Type": "text/javascript" } });
    if (path === "/") return new Response(Bun.file(resolve(root, "preview/index.html")));
    return new Response("Not found", { status: 404 });
  },
});
console.log(`Margin design preview: ${server.url}`);
