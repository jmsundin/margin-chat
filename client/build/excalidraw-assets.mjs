import { createRequire } from "node:module";
import { dirname, join, relative } from "node:path";
import { readdirSync, readFileSync } from "node:fs";
const require = createRequire(import.meta.url);

/** Keep drawing fonts on the same origin in development and production. */
export function excalidrawAssetsPlugin() {
  const root = join(dirname(require.resolve("@excalidraw/excalidraw")), "fonts");
  const files = new Map();
  function walk(directory) {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) walk(path);
      else if (entry.name.endsWith(".woff2")) files.set(`/excalidraw/fonts/${relative(root, path).split("\\").join("/")}`, path);
    }
  }
  walk(root);
  return {
    name: "marginchat-excalidraw-assets",
    configureServer(server) {
      server.middlewares.use((request, response, next) => {
        const path = files.get((request.url ?? "").split("?")[0]);
        if (!path) return next();
        response.setHeader("Content-Type", "font/woff2");
        response.end(readFileSync(path));
      });
    },
    generateBundle() {
      for (const [url, path] of files) this.emitFile({ type: "asset", fileName: url.slice(1), source: readFileSync(path) });
    },
  };
}
