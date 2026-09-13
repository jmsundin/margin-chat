import { describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { renderOfflineServiceWorker } from "../client/build/offline-service-worker.mjs";

function worker() {
  const handlers = new Map<string, (event: any) => void>();
  const entries = new Map<string, string>([
    ["/index.html", "matching build HTML"], ["/assets/app-hash.js", "matching build JS"],
  ]);
  const cached = ["marginchat-app-shell-older", "marginchat-app-shell-current", "another-app"];
  const deleted: string[] = [];
  const installed: string[] = [];
  let networkRequests = 0;
  let forcedActivation = false;
  const cache = {
    match: async (path: string) => entries.get(path),
    addAll: async (requests: Array<{ url: string }>) => { installed.push(...requests.map((r) => r.url)); },
    put: async (path: string, response: Response) => { entries.set(path, await response.text()); },
  };
  runInNewContext(renderOfflineServiceWorker({
    version: "current", files: ["/index.html", "/assets/app-hash.js", "/manifest.webmanifest"], html: "embedded matching HTML",
  }), {
    URL,
    Response,
    Request: class { url: string; constructor(path: string) { this.url = path; } },
    caches: {
      open: async () => cache,
      keys: async () => cached,
      delete: async (name: string) => { deleted.push(name); return true; },
    },
    fetch: async () => { networkRequests++; throw new Error("offline"); },
    self: {
      location: { origin: "https://margin.test" },
      clients: { claim: async () => undefined },
      addEventListener: (name: string, callback: (event: any) => void) => handlers.set(name, callback),
      skipWaiting: () => { forcedActivation = true; },
    },
  });
  function request(path: string, fields: Record<string, string> = {}) {
    let response: Promise<string> | undefined;
    handlers.get("fetch")!({
      request: { url: `https://margin.test${path}`, method: "GET", mode: "cors", ...fields },
      respondWith: (pending: Promise<string>) => { response = pending; },
    });
    return response;
  }
  return { handlers, request, deleted, installed,
    get networkRequests() { return networkRequests; },
    get forcedActivation() { return forcedActivation; },
  };
}

describe("offline application shell", () => {
  test("offline navigation and assets use the same complete build", async () => {
    const sw = worker();
    expect(await sw.request("/", { mode: "navigate" })).toBe("matching build HTML");
    expect(await sw.request("/assets/app-hash.js")).toBe("matching build JS");
    expect(sw.networkRequests).toBe(0);
  });
  test("never intercepts API data, writes, external resources or unknown files", () => {
    const sw = worker();
    for (const path of ["/api", "/api/vault", "/api/state", "/private-file.md"]) {
      expect(sw.request(path)).toBeUndefined();
      if (path.startsWith("/api")) expect(sw.request(path, { mode: "navigate" })).toBeUndefined();
    }
    expect(sw.request("/assets/app-hash.js", { method: "POST" })).toBeUndefined();
    expect(sw.request("/", { url: "https://other.test/index.html", mode: "navigate" })).toBeUndefined();
  });
  test("installs all assets, waits for existing tabs, and deletes only its own old cache", async () => {
    const sw = worker();
    let pending: Promise<unknown> | undefined;
    const event = { waitUntil: (promise: Promise<unknown>) => { pending = promise; } };
    sw.handlers.get("install")!(event);
    await pending;
    expect(sw.installed).toEqual(["/assets/app-hash.js", "/manifest.webmanifest"]);
    expect(await sw.request("/", { mode: "navigate" })).toBe("embedded matching HTML");
    expect(sw.forcedActivation).toBe(false);
    sw.handlers.get("activate")!(event);
    await pending;
    expect(sw.deleted).toEqual(["marginchat-app-shell-older"]);
  });
});
