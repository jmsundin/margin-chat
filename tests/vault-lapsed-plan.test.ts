import { afterAll, beforeAll, expect, test } from "bun:test";
import { createServer, type Server } from "node:http";
import { createApiHandler } from "../server/routes/api.mjs";

// A member whose subscription ended: nothing in the cloud may be locked away from them.
const user = { id: "lapsed-member", role: "member", billing: { accessKind: "none", status: "canceled", hasAccess: false } };
const manifest = { schemaVersion: 1, revision: 3, files: { "Notes/kept.md": { revision: "a".repeat(64), deleted: false, contentType: "text/markdown; charset=utf-8", size: 5 } } };
let commits = 0;
let server: Server;
let baseUrl: string;

beforeAll(async () => {
  const handler = createApiHandler({
    runtimeConfig: { host: "localhost", port: 8787 },
    authService: { getAuthContext: async () => ({ user }) },
    vaultService: {
      configured: true,
      status: async () => ({ configured: true, manifest }),
      readFile: async () => ({ bytes: Buffer.from("Kept."), revision: "a".repeat(64), contentType: "text/markdown; charset=utf-8" }),
      readFileUrl: async () => null,
      commit: async () => { commits += 1; return { manifest }; },
      commitBinary: async () => { commits += 1; return { manifest }; },
    },
  });
  server = createServer((request, response) => void handler(request, response));
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
});
afterAll(async () => {
  server?.closeAllConnections();
  if (server) await new Promise<void>((resolve) => server.close(() => resolve()));
});

test("after a plan ends, the account can still list and download its cloud files", async () => {
  const status = await fetch(`${baseUrl}/api/vault`);
  expect(status.status).toBe(200);
  expect((await status.json()).manifest.files["Notes/kept.md"]).toBeDefined();
  const file = await fetch(`${baseUrl}/api/vault/file?path=Notes%2Fkept.md`);
  expect(file.status).toBe(200);
  expect(await file.text()).toBe("Kept.");
});

test("after a plan ends, the cloud vault can't be changed until the account subscribes again", async () => {
  const commit = await fetch(`${baseUrl}/api/vault/commit`, { method: "POST", headers: { "content-type": "application/json", "x-margin-vault-write": "1" },
    body: JSON.stringify({ changes: [{ path: "Notes/new.md", content: "New", baseRevision: null }] }) });
  expect(commit.status).toBe(403);
  const write = await fetch(`${baseUrl}/api/vault/file?path=Notes%2Fnew.md&baseRevision=`, { method: "PUT", headers: { "x-margin-vault-write": "1" }, body: "New" });
  expect(write.status).toBe(403);
  const changes = await fetch(`${baseUrl}/api/vault/changes?since=0`);
  expect(changes.status).toBe(403);
  expect(commits).toBe(0);
});
