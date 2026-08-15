import { resolve } from "node:path";
import { defineConfig, loadEnv } from "vite";
import react from "@vitejs/plugin-react";

export default defineConfig(({ mode }) => {
  const workspaceRoot = resolve(process.cwd(), "..");
  const env = loadEnv(mode, workspaceRoot, "");
  const backendPort = Number(env.BACKEND_PORT ?? env.PORT ?? 8787);

  return {
    envDir: "..",
    plugins: [react()],
    server: {
      proxy: {
        "/api": {
          target: `http://127.0.0.1:${backendPort}`,
          changeOrigin: true,
          configure(proxy) {
            proxy.on("error", (_error, _request, response) => {
              if (
                !("writeHead" in response) ||
                response.headersSent ||
                response.writableEnded
              ) {
                return;
              }

              response.writeHead(503, {
                "Content-Type": "application/json; charset=utf-8",
              });
              response.end(
                JSON.stringify({
                  error:
                    "The local Margin Chat backend is unavailable. Local saving is still active.",
                }),
              );
            });
          },
        },
      },
    },
    build: {
      outDir: "../dist",
      emptyOutDir: true,
    },
  };
});
