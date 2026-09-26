import { expect, test } from "bun:test";
import { createServer as createHttpServer, type RequestListener, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { fileURLToPath } from "node:url";
import { createServer as createViteServer } from "vite";
import viteConfig from "../client/vite.config";

function configuredProxy(target: string, port = "8787", passwordChangeTarget = "") {
  const previous = {
    BACKEND_URL: process.env.BACKEND_URL,
    BACKEND_PORT: process.env.BACKEND_PORT,
    PORT: process.env.PORT,
    PASSWORD_CHANGE_BACKEND_URL: process.env.PASSWORD_CHANGE_BACKEND_URL,
  };
  try {
    // Process variables override env files, so this test never contacts a saved
    // production target or depends on the developer's local backend port.
    process.env.BACKEND_URL = target;
    process.env.BACKEND_PORT = port;
    process.env.PORT = port;
    process.env.PASSWORD_CHANGE_BACKEND_URL = passwordChangeTarget;
    return viteConfig({ command: "serve", mode: "test", isSsrBuild: false, isPreview: false }).server!.proxy!;
  } finally {
    for (const [key, value] of Object.entries(previous)) {
      if (value === undefined) delete process.env[key];
      else process.env[key] = value;
    }
  }
}

async function closeHttpServer(server: Server) {
  server.closeAllConnections();
  if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
}

async function withProxy(
  handler: RequestListener,
  check: (origin: string, upstream: Server, passwordChangeUpstream?: Server) => Promise<void>,
  passwordChangeHandler?: RequestListener,
) {
  const upstream = createHttpServer(handler);
  await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
  const upstreamAddress = upstream.address() as AddressInfo;
  const passwordChangeUpstream = passwordChangeHandler ? createHttpServer(passwordChangeHandler) : undefined;
  if (passwordChangeUpstream) {
    await new Promise<void>((resolve) => passwordChangeUpstream.listen(0, "127.0.0.1", resolve));
  }
  const passwordChangeTarget = passwordChangeUpstream
    ? `http://127.0.0.1:${(passwordChangeUpstream.address() as AddressInfo).port}`
    : "";
  const proxy = await createViteServer({
    configFile: false,
    root: fileURLToPath(new URL("../client", import.meta.url)),
    appType: "custom",
    publicDir: false,
    logLevel: "silent",
    optimizeDeps: { noDiscovery: true, include: [] },
    server: {
      middlewareMode: true, hmr: false,
      proxy: configuredProxy(`http://127.0.0.1:${upstreamAddress.port}`, "8787", passwordChangeTarget),
    },
  });
  const proxyHttp = createHttpServer(proxy.middlewares);
  try {
    await new Promise<void>((resolve) => proxyHttp.listen(0, "127.0.0.1", resolve));
    const address = proxyHttp.address() as AddressInfo;
    await check(`http://127.0.0.1:${address.port}`, upstream, passwordChangeUpstream);
  } finally {
    await closeHttpServer(proxyHttp);
    await proxy.close();
    await closeHttpServer(upstream);
    if (passwordChangeUpstream) await closeHttpServer(passwordChangeUpstream);
  }
}

test("development API proxy forwards authenticated requests and rewrites only the cookie domain", async () => {
  await withProxy(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": "margin_chat_session=fixture-response; Domain=.marginchat.com; Path=/; HttpOnly; SameSite=Lax; Secure",
    });
    response.end(JSON.stringify({
      path: request.url, method: request.method, host: request.headers.host,
      cookie: request.headers.cookie, account: request.headers["x-margin-vault-user"],
      write: request.headers["x-margin-vault-write"], site: request.headers["sec-fetch-site"],
      body: Buffer.concat(chunks).toString("utf8"),
    }));
  }, async (origin, upstream) => {
    const body = JSON.stringify({ topic: "Synthetic topic" });
    const response = await fetch(`${origin}/api/graph/topic?lang=en&depth=2`, {
      method: "POST", body, signal: AbortSignal.timeout(3000),
      headers: { "Content-Type": "application/json", Cookie: "margin_chat_session=fixture-request",
        "X-Margin-Vault-User": "fixture-account", "X-Margin-Vault-Write": "1", "Sec-Fetch-Site": "same-origin" },
    });
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({
      path: "/api/graph/topic?lang=en&depth=2", method: "POST",
      host: `127.0.0.1:${(upstream.address() as AddressInfo).port}`,
      cookie: "margin_chat_session=fixture-request", account: "fixture-account", write: "1", site: "same-origin", body,
    });
    const cookie = response.headers.get("set-cookie")!;
    expect(cookie).toContain("margin_chat_session=fixture-response");
    expect(cookie).not.toMatch(/\bDomain=/i);
    expect(cookie).toContain("Path=/");
    expect(cookie).toContain("HttpOnly");
    expect(cookie).toContain("SameSite=Lax");
    expect(cookie).toContain("Secure");
  });
});

test("development API proxy delivers streamed progress before the upstream completes", async () => {
  let release!: () => void;
  let ended = false;
  const completion = new Promise<void>((resolve) => { release = resolve; });
  try {
    await withProxy(async (_request, response) => {
      response.writeHead(200, { "Content-Type": "application/x-ndjson", "Cache-Control": "no-store" });
      response.write('{"type":"progress"}\n');
      response.flushHeaders();
      await completion;
      ended = true;
      response.end('{"type":"done"}\n');
    }, async (origin) => {
      const response = await fetch(`${origin}/api/graph/url`, { signal: AbortSignal.timeout(3000) });
      const reader = response.body!.getReader();
      try {
        const first = await reader.read();
        expect(first.done).toBe(false);
        expect(new TextDecoder().decode(first.value)).toBe('{"type":"progress"}\n');
        expect(ended).toBe(false);
        release();
        let remainder = "";
        for (;;) {
          const chunk = await reader.read();
          if (chunk.done) break;
          remainder += new TextDecoder().decode(chunk.value);
        }
        expect(remainder).toBe('{"type":"done"}\n');
        expect(ended).toBe(true);
      } finally {
        release();
        await reader.cancel();
      }
    });
  } finally { release(); }
});

test("development API proxy returns its configured-backend error when the upstream is unavailable", async () => {
  await withProxy((_request, response) => response.end(), async (origin, upstream) => {
    await closeHttpServer(upstream);
    const response = await fetch(`${origin}/api/health`, { signal: AbortSignal.timeout(3000) });
    expect(response.status).toBe(503);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ error: "The configured Margin Chat backend is unavailable. Local saving is still active." });
  });
});

test("development API proxy retains the configured local port when no backend URL is supplied", () => {
  expect(configuredProxy("   ", "8129")["/api"]).toMatchObject({ target: "http://127.0.0.1:8129", changeOrigin: true });
});

test("development password-change override forwards authentication and only the exact route to its own backend", async () => {
  await withProxy((request, response) => {
    response.setHeader("Content-Type", "application/json");
    response.end(JSON.stringify({ backend: "global", path: request.url }));
  }, async (origin, _upstream, passwordChangeUpstream) => {
    for (const suffix of ["", "?source=profile&check=1"]) {
      const path = `/api/auth/password/change${suffix}`;
      const body = JSON.stringify({ currentPassword: "synthetic-current", password: "synthetic-new" });
      const response = await fetch(`${origin}${path}`, {
        method: "POST", body, signal: AbortSignal.timeout(3000),
        headers: { "Content-Type": "application/json", Cookie: "margin_chat_session=fixture-request" },
      });
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual({
        backend: "password-change", path, method: "POST", body,
        host: `127.0.0.1:${(passwordChangeUpstream!.address() as AddressInfo).port}`,
        cookie: "margin_chat_session=fixture-request",
      });
      const cookie = response.headers.get("set-cookie")!;
      expect(cookie).toContain("margin_chat_session=fixture-rotated");
      expect(cookie).not.toMatch(/\bDomain=/i);
      expect(cookie).toContain("Path=/");
      expect(cookie).toContain("HttpOnly");
      expect(cookie).toContain("SameSite=Lax");
      expect(cookie).toContain("Secure");
    }

    for (const path of [
      "/api/auth/session", "/api/vault", "/api/auth/password-reset/request",
      "/api/auth/password/change/extra", "/api/auth/password/change-extra", "/api/auth/password/changed?source=profile",
    ]) {
      const response = await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(3000) });
      expect(await response.json()).toEqual({ backend: "global", path });
    }
  }, async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    response.writeHead(200, {
      "Content-Type": "application/json",
      "Set-Cookie": "margin_chat_session=fixture-rotated; Domain=.marginchat.com; Path=/; HttpOnly; SameSite=Lax; Secure",
    });
    response.end(JSON.stringify({
      backend: "password-change", path: request.url, method: request.method,
      host: request.headers.host, cookie: request.headers.cookie, body: Buffer.concat(chunks).toString("utf8"),
    }));
  });
});

test("unavailable password-change override fails without sending the request to the global backend", async () => {
  let globalRequests = 0;
  await withProxy((_request, response) => {
    globalRequests += 1;
    response.end("global backend");
  }, async (origin, _upstream, passwordChangeUpstream) => {
    await closeHttpServer(passwordChangeUpstream!);
    const response = await fetch(`${origin}/api/auth/password/change`, {
      method: "POST", body: "{}", signal: AbortSignal.timeout(3000),
      headers: { "Content-Type": "application/json" },
    });
    expect(response.status).toBe(503);
    expect(await response.json()).toEqual({ error: "The configured Margin Chat backend is unavailable. Local saving is still active." });
    expect(globalRequests).toBe(0);
  }, (_request, response) => response.end());
});

test("password changes use the global backend when no override is configured", async () => {
  expect(Object.keys(configuredProxy("http://127.0.0.1:8129", "8787", "  "))).toEqual(["/api"]);
  await withProxy((request, response) => {
    response.end(request.url);
  }, async (origin) => {
    const response = await fetch(`${origin}/api/auth/password/change`, { method: "POST", signal: AbortSignal.timeout(3000) });
    expect(response.status).toBe(200);
    expect(await response.text()).toBe("/api/auth/password/change");
  });
});
