import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { excalidrawAssetsPlugin } from "../client/build/excalidraw-assets.mjs";

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  publicDir: false,
  plugins: [react(), excalidrawAssetsPlugin()],
  define: { "process.env.IS_PREACT": "false" },
  resolve: { dedupe: ["react", "react-dom"] },
  build: {
    outDir: "dist", emptyOutDir: false,
    rollupOptions: { input: fileURLToPath(new URL("workspace.html", import.meta.url)) },
  },
});
