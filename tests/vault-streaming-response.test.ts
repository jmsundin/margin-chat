import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { Readable, Writable } from "node:stream";
import { config as deploymentConfig } from "../api/handler.mjs";
import { sendStreamingJson } from "../server/http/streamingJson.mjs";
import { createApiHandler } from "../server/routes/api.mjs";
import { createDeploymentHandler } from "../server/routes/deployment.mjs";
import { VaultConflictError } from "../server/vault/index.mjs";

const manifest = {
  schemaVersion: 1, revision: 42,
  files: Object.fromEntries(Array.from({ length: 9_000 }, (_, index) => [
    `Notes/${"界".repeat(65)}/${"a".repeat(190)}/${index}.md`,
    { revision: "a".repeat(64), deleted: false, encoding: "utf8", contentType: "text/markdown; charset=utf-8", size: 1 },
  ])),
};
const payload = { configured: true, manifest, projection: { status: "ready", revision: manifest.revision } };
const user = { id: "vault-owner", role: "admin" };

function api(vaultService: any) {
  return createApiHandler({
    runtimeConfig: { host: "localhost", port: 8787 },
    authService: { getAuthContext: async () => ({ user }) },
    vaultService: { configured: true, ...vaultService },
  });
}

describe("existing large vault responses", () => {
  let server: Server;
  let baseUrl: string;
  let writes: number[] = [];
  const conflicts = Object.keys(manifest.files).slice(0, 1_000);

  beforeAll(async () => {
    const handler = createDeploymentHandler(() => api({
      status: async () => payload,
      commit: async (_userId: string, changes: unknown[]) => {
        if (changes.length) throw new VaultConflictError(conflicts, manifest);
        return payload;
      },
      commitBinary: async () => payload,
      rebuild: async () => payload,
    }));
    server = createServer((request, response) => {
      const write = response.write.bind(response);
      response.write = ((chunk: any, ...args: any[]) => {
        writes.push(Buffer.byteLength(chunk));
        return (write as any)(chunk, ...args);
      }) as typeof response.write;
      void handler(request, response);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(async () => {
    server?.closeAllConnections();
    if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  test("the deployment explicitly supports response streaming", () => {
    expect(deploymentConfig.supportsResponseStreaming).toBe(true);
    expect(Buffer.byteLength(JSON.stringify(payload))).toBeGreaterThan(4.5 * 1024 * 1024);
  });

  test("status preserves the existing JSON contract above the buffered cloud limit", async () => {
    writes = [];
    const response = await fetch(`${baseUrl}/api/handler?__margin_api_path=vault`);
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    expect(response.headers.get("content-length")).toBeNull();
    expect(await response.json()).toEqual(payload);
    expect(writes.length).toBeGreaterThan(1);
    expect(Math.max(...writes)).toBeLessThanOrEqual(64 * 1024);
  });

  test("existing oversized manifests remain readable after no-op commits, raw writes, and rebuilds", async () => {
    for (const request of [
      { path: "/api/vault/commit", method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ changes: [] }) },
      { path: "/api/vault/rebuild", method: "POST", headers: { "content-type": "application/json" }, body: "{}" },
      { path: "/api/vault/file?path=Attachments/original.bin", method: "PUT", headers: { "content-type": "application/octet-stream", "x-margin-vault-write": "1" }, body: "bytes" },
    ]) {
      const response = await fetch(`${baseUrl}${request.path}`, request);
      expect(response.status).toBe(200);
      expect(await response.json()).toEqual(payload);
    }
  });

  test("conflicts stream both the complete old manifest and conflicting paths without changing status", async () => {
    const response = await fetch(`${baseUrl}/api/vault/commit`, {
      method: "POST", headers: { "content-type": "application/json" },
      body: JSON.stringify({ changes: [{ path: conflicts[0], content: "edit", baseRevision: null }] }),
    });
    expect(response.status).toBe(409);
    expect(response.headers.get("cache-control")).toBe("private, no-store");
    const result = await response.json();
    expect(result.conflicts).toEqual(conflicts);
    expect(result.manifest).toEqual(manifest);
    expect(typeof result.error).toBe("string");
  });

  test("account mismatch is still rejected before any manifest is sent", async () => {
    const response = await fetch(`${baseUrl}/api/vault`, { headers: { "x-margin-vault-user": "another-user" } });
    expect(response.status).toBe(409);
    expect((await response.json()).manifest).toBeUndefined();
  });

  test("JSON streaming honors a slow destination and retains UTF-8 bytes", async () => {
    const value = { text: "界🌱".repeat(60_000) };
    const chunks: Buffer[] = [];
    let maxQueuedBytes = 0;
    const destination = Object.assign(new Writable({
      highWaterMark: 16 * 1024,
      write(chunk, _encoding, done) {
        maxQueuedBytes = Math.max(maxQueuedBytes, this.writableLength);
        chunks.push(Buffer.from(chunk));
        setTimeout(done, 1);
      },
    }), { writeHead() {} });
    await sendStreamingJson(destination, 200, value);
    expect(JSON.parse(Buffer.concat(chunks).toString("utf8"))).toEqual(value);
    expect(maxQueuedBytes).toBeLessThanOrEqual(64 * 1024);
  });

  test("a disconnected JSON response does not receive a trailing chat error event", async () => {
    let writes = 0;
    const destination = Object.assign(new Writable({
      write(_chunk, _encoding, done) { writes += 1; done(new Error("client disconnected")); },
    }), { headersSent: false, writeHead() { this.headersSent = true; } });
    const request = Object.assign(Readable.from([]), { method: "GET", url: "/api/vault", headers: { host: "localhost" } });
    await api({ status: async () => payload })(request, destination);
    expect(destination.destroyed).toBe(true);
    expect(writes).toBe(1);
  });
});
