import { fileURLToPath } from "node:url";
import { defineConfig, loadEnv, type ProxyOptions } from "vite";
import react from "@vitejs/plugin-react";
import { offlineAppShellPlugin } from "./build/offline-service-worker.mjs";

function apiProxy(target: string): ProxyOptions {
  return {
    target,
    changeOrigin: true,
    // Auth stays same-origin on localhost even when the API is hosted.
    cookieDomainRewrite: "",
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
              "The configured Margin Chat backend is unavailable. Local saving is still active.",
          }),
        );
      });
    },
  };
}

export default defineConfig(({ mode }) => {
  const workspaceRoot = fileURLToPath(new URL("..", import.meta.url));
  const env = loadEnv(mode, workspaceRoot, "");
  const backendPort = Number(env.BACKEND_PORT ?? env.PORT ?? 8787);
  const backendTarget = env.BACKEND_URL?.trim() || `http://127.0.0.1:${backendPort}`;
  const passwordChangeTarget = env.PASSWORD_CHANGE_BACKEND_URL?.trim();

  return {
    envDir: "..",
    plugins: [react(), offlineAppShellPlugin()],
    // Workspace links and editor peer dependencies must share the renderer's React instance.
    resolve: { dedupe: ["react", "react-dom"] },
    server: {
      proxy: {
        // Place the exact override first: Vite selects the first matching proxy.
        ...(passwordChangeTarget ? {
          "^/api/auth/password/change(?:\\?|$)": apiProxy(passwordChangeTarget),
        } : {}),
        "/api": apiProxy(backendTarget),
      },
    },
    build: {
      outDir: "../dist",
      emptyOutDir: true,
    },
  };
});
