import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { createServer } from "node:http";
import { createCaptureTestDatabase } from "./helpers/captureDatabase.mjs";
import { readVaultProjectionCheckpoint, writeState } from "../server/db/repository.mjs";
import { readAgentConversation, searchAgentPassages } from "../server/db/searchRepository.mjs";
import { normalizeAppState } from "../server/db/validation.mjs";
import { createVaultService } from "../server/vault/index.mjs";
import { digest } from "../server/vault/storage.mjs";
import { createApiHandler } from "../server/routes/api.mjs";
import { createAuthService } from "../server/auth/index.mjs";
import { createRuntimeConfig } from "../server/config/runtime.mjs";
import { MCP_TOOLS, mcpToolsFor } from "../server/mcp/index.mjs";
import { isAllowedRedirectUri } from "../server/mcp/oauth.mjs";
import { createHash } from "node:crypto";
import { appendToSource, documentFileName } from "../server/mcp/writeTools.mjs";
import { createMarkdownWorkspace } from "@margin-chat/workspace-contracts/markdown";
import { createEmptyState, createStandaloneNoteConversation } from "../client/src/initialState";

function memoryStorage() {
  const objects = new Map<string, Buffer>();
  return {
    kind: "memory",
    async read(key: string) { const bytes = objects.get(key); return bytes ? { bytes: Buffer.from(bytes), etag: digest(bytes) } : null; },
    async putImmutable(key: string, bytes: Buffer) { objects.set(key, Buffer.from(bytes)); },
    async compareAndSwap(key: string, bytes: Buffer, expected: string | null) {
      if ((objects.has(key) ? digest(objects.get(key)!) : null) !== expected) return false;
      objects.set(key, Buffer.from(bytes)); return true;
    },
  };
}

const at = "2026-10-01T10:00:00.000Z";

/** A plan document with a chat under it (holding a private margin comment). */
function workspace() {
  const state = createEmptyState();
  const plan = state.conversations[state.rootId];
  Object.assign(plan, { id: "plan", title: "Launch plan", createdAt: at, updatedAt: at, childIds: ["chat"] });
  plan.document = { schemaVersion: 1, blocks: [
    { id: "pricing", kind: "markdown", content: "We agreed the pricing tiers stay simple.", createdAt: at, updatedAt: at },
  ], prompts: [], generations: [] } as any;
  const chat = createStandaloneNoteConversation({ id: "chat", noteId: "chat-note", createdAt: at });
  Object.assign(chat, { title: "Supplier call", kind: "chat", parentId: "plan", updatedAt: at });
  chat.messages = [{ id: "m1", role: "user", content: "Can the supplier hold pricing through March?", createdAt: at } as any];
  chat.notes = [{ id: "c1", kind: "comment", sourceMessageId: "m1", startOffset: null, endOffset: null, quote: null,
    content: "Private pricing worry.", createdAt: at, updatedAt: at } as any];
  state.rootId = "plan";
  state.conversations = { plan, chat };
  return createMarkdownWorkspace(state).files as Record<string, string>;
}

describe("MCP server", () => {
  let fixture: Awaited<ReturnType<typeof createCaptureTestDatabase>>;
  let server: ReturnType<typeof createServer>;
  let origin: string;
  let vault: ReturnType<typeof createVaultService>;

  beforeAll(async () => {
    fixture = await createCaptureTestDatabase();
    const database = {
      ...fixture.database,
      getVaultProjectionCheckpoint: (id: string) => readVaultProjectionCheckpoint(fixture.client, id),
      projectVaultState: (id: string, source: any, revision: number, options: any) => writeState(fixture.client, id, source === null ? null : normalizeAppState(source), {
        vaultRevision: revision, forceVaultProjection: options.force, vaultAttachments: options.attachments,
        deletedVaultAttachmentIds: options.deletedAttachmentIds, attachmentRevisions: options.attachmentRevisions,
        expectedVaultProjectionRevision: options.expectedProjectionRevision, unchangedConversationIds: options.unchangedConversationIds,
      }),
      searchAgentPassages: (args: any) => searchAgentPassages(fixture.client, args),
      readAgentConversation: (args: any) => readAgentConversation(fixture.client, args),
    };
    for (const [id, status] of [["plus", "active"], ["free", "inactive"]]) {
      await database.createUser({ id, role: "member", email: `${id}@example.test`, displayName: id, passwordHash: "unused" });
      await fixture.client.query("update marginchat_users set billing_status = $2, billing_price_id = $3 where id = $1",
        [id, status, status === "active" ? "price_plus" : null]);
      await database.createAuthSession({ id: `session-${id}`, userId: id, expiresAt: new Date(Date.now() + 600_000) });
    }
    vault = createVaultService({ storage: memoryStorage(), database });
    await vault.commit("plus", Object.entries(workspace()).map(([path, content]) => ({ path, content, baseRevision: null })));
    const config = createRuntimeConfig({});
    server = createServer(createApiHandler({
      database, vaultService: vault, runtimeConfig: config,
      authService: createAuthService({ database, runtimeConfig: config }),
    }));
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  }, 30000);
  afterAll(async () => {
    server?.closeAllConnections();
    await new Promise<void>((resolve) => server?.close(() => resolve()));
    await fixture?.pg.close();
  });

  const settings = (user: string, init: RequestInit = {}) => fetch(`${origin}/api/settings/mcp-tokens${init.method === "DELETE" ? "" : ""}`, {
    ...init, headers: { Cookie: `margin_chat_session=session-${user}`, "Content-Type": "application/json", "X-Margin-Agent-Settings": "1", ...init.headers },
  });
  let nextId = 1;
  const rpc = (token: string | null, method: string, params?: unknown) => fetch(`${origin}/api/mcp`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
    body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method, ...(params ? { params } : {}) }),
  });
  async function call(token: string, name: string, args: unknown) {
    const response = await rpc(token, "tools/call", { name, arguments: args });
    expect(response.status).toBe(200);
    return (await response.json()).result;
  }

  test("a Plus member makes a token, an agent searches and reads the vault with it, and revoking it locks the agent out", async () => {
    const made = await settings("plus", { method: "POST", body: JSON.stringify({ name: "  Claude Code   on laptop " }) });
    expect(made.status).toBe(201);
    const { token, summary } = await made.json();
    expect(token).toMatch(/^mc_mcp_[A-Za-z0-9_-]{43}$/u);
    expect(summary).toMatchObject({ name: "Claude Code on laptop", scope: "read", lastUsedAt: null });
    const listed = await (await settings("plus")).json();
    expect(listed).toMatchObject({ canConnect: true, tokens: [{ id: summary.id, name: "Claude Code on laptop" }] });
    expect(JSON.stringify(listed)).not.toContain(token);

    const init = await (await rpc(token, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } })).json();
    expect(init.result).toMatchObject({ protocolVersion: "2025-06-18", capabilities: { tools: {} }, serverInfo: { name: "margin-chat" } });
    const notified = await fetch(`${origin}/api/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", method: "notifications/initialized" }) });
    expect(notified.status).toBe(202);
    const tools = (await (await rpc(token, "tools/list")).json()).result.tools;
    expect(tools.map((tool: any) => tool.name)).toEqual(["search_vault", "read_document", "list_related", "search", "fetch"]);
    expect(tools.every((tool: any) => tool.annotations.readOnlyHint && tool.inputSchema.type === "object")).toBe(true);

    const found = await call(token, "search_vault", { query: "pricing" });
    expect(found.structuredContent.results.map((hit: any) => hit.title)).toEqual(["Launch plan", "Supplier call"]);
    expect(JSON.parse(found.content[0].text)).toEqual(found.structuredContent);
    expect((await call(token, "search_vault", { query: "private worry" })).structuredContent.total_matches).toBe(0);
    const plan = await call(token, "read_document", { document_id: "plan" });
    expect(plan.structuredContent.document).toMatchObject({ title: "Launch plan", text: "We agreed the pricing tiers stay simple." });
    const related = await call(token, "list_related", { document_id: "plan" });
    expect(related.structuredContent.related.map((item: any) => [item.title, item.relation])).toEqual([["Supplier call", "child"]]);

    // ChatGPT's search and fetch shapes.
    expect((await call(token, "search", { query: "supplier" })).structuredContent.results).toEqual([
      { id: "chat", title: "Supplier call", text: "Can the supplier hold pricing through March?" }]);
    const fetched = (await call(token, "fetch", { id: "chat" })).structuredContent;
    expect(fetched).toMatchObject({ id: "chat", title: "Supplier call", text: "user: Can the supplier hold pricing through March?",
      metadata: { kind: "chat", parent_id: "plan" } });
    expect(JSON.stringify(fetched)).not.toContain("Private");
    expect(await call(token, "fetch", { id: "missing" })).toMatchObject({ isError: true, content: [{ type: "text" }] });

    const unknown = await (await rpc(token, "tools/call", { name: "delete_everything", arguments: {} })).json();
    expect(unknown.error.code).toBe(-32602);
    expect((await (await rpc(token, "resources/list")).json()).error.code).toBe(-32601);
    expect((await settings("plus")).ok).toBe(true);
    expect((await (await settings("plus")).json()).tokens[0].lastUsedAt).not.toBeNull();

    const revoked = await fetch(`${origin}/api/settings/mcp-tokens/${summary.id}`, { method: "DELETE",
      headers: { Cookie: "margin_chat_session=session-plus", "X-Margin-Agent-Settings": "1" } });
    expect(revoked.status).toBe(200);
    const locked = await rpc(token, "tools/list");
    expect(locked.status).toBe(401);
    expect(locked.headers.get("www-authenticate")).toContain("Bearer");
  });

  test("agents need a Plus or Cloud plan, a real token and POST; tokens are managed only from Margin Chat itself", async () => {
    expect((await (await settings("free")).json())).toEqual({ tokens: [], canConnect: false });
    expect((await settings("free", { method: "POST", body: JSON.stringify({ name: "Agent" }) })).status).toBe(403);
    expect((await settings("plus", { method: "POST", body: JSON.stringify({ name: "" }) })).status).toBe(400);
    expect((await settings("plus", { method: "POST", body: JSON.stringify({ name: "Agent" }), headers: { "X-Margin-Agent-Settings": "" } })).status).toBe(403);

    const { token } = await (await settings("plus", { method: "POST", body: JSON.stringify({ name: "Cursor" }) })).json();
    // A member whose subscription lapses keeps the token, but agents can't use it until they subscribe again.
    await fixture.client.query("update marginchat_users set billing_status = 'canceled' where id = 'plus'");
    expect((await rpc(token, "tools/list")).status).toBe(403);
    await fixture.client.query("update marginchat_users set billing_status = 'active' where id = 'plus'");
    expect((await rpc(token, "tools/list")).status).toBe(200);

    expect((await rpc(null, "tools/list")).status).toBe(401);
    expect((await rpc(`mc_mcp_${"a".repeat(43)}`, "tools/list")).status).toBe(401);
    expect((await fetch(`${origin}/api/mcp`, { headers: { Authorization: `Bearer ${token}` } })).status).toBe(405);
    const broken = await fetch(`${origin}/api/mcp`, { method: "POST", headers: { Authorization: `Bearer ${token}` }, body: "{not json" });
    expect((await broken.json()).error.code).toBe(-32700);
  });

  test("a write token creates documents linked on the map and appends to documents and notes, never chats", async () => {
    await fixture.client.query("update marginchat_users set billing_status = 'active' where id = 'plus'");
    const reader = (await (await settings("plus", { method: "POST", body: JSON.stringify({ name: "Reader" }) })).json()).token;
    const made = await (await settings("plus", { method: "POST", body: JSON.stringify({ name: "Claude Code", scope: "write" }) })).json();
    expect(made.summary.scope).toBe("write");
    const writer = made.token;
    expect((await settings("plus", { method: "POST", body: JSON.stringify({ name: "x", scope: "admin" }) })).status).toBe(400);

    const names = async (token: string) => (await (await rpc(token, "tools/list")).json()).result.tools.map((tool: any) => tool.name);
    expect(await names(reader)).not.toContain("create_document");
    expect(await names(writer)).toEqual(["search_vault", "read_document", "list_related", "search", "fetch", "create_document", "append_to_document"]);
    const refused = await (await rpc(reader, "tools/call", { name: "create_document", arguments: { title: "x", content: "y" } })).json();
    expect(refused.error).toMatchObject({ code: -32602, message: expect.stringContaining("can add documents") });
    const init = await (await rpc(writer, "initialize", { protocolVersion: "2025-06-18", capabilities: {} })).json();
    expect(init.result.instructions).toContain("never changed or deleted");

    const created = (await call(writer, "create_document", { title: "Pricing research: notes/plan", content: "Competitors charge per seat.",
      relations: [{ type: "part-of", document_id: "plan" }] })).structuredContent;
    expect(created).toMatchObject({ ok: true, title: "Pricing research: notes/plan", path: "Pricing research notes plan.md" });
    expect(created.document_id).toMatch(/^mcp-/u);
    const read = (await call(writer, "read_document", { document_id: created.document_id })).structuredContent;
    expect(read.document).toMatchObject({ title: "Pricing research: notes/plan", text: "Competitors charge per seat." });
    const links = (await call(writer, "list_related", { document_id: created.document_id })).structuredContent;
    expect(links.related.map((item: any) => [item.title, item.relation])).toEqual([["Launch plan", "part-of"]]);
    const saved = (await vault.readFile({ userId: "plus", path: "Pricing research notes plan.md" })).bytes.toString("utf8");
    expect(saved).toContain('created-by: "Claude Code"');
    // The same title again gets its own file.
    expect((await call(writer, "create_document", { title: "Pricing research: notes/plan", content: "Again." })).structuredContent.path)
      .toBe("Pricing research notes plan 2.md");

    expect((await call(writer, "append_to_document", { document_id: "plan", content: "Agents found per-seat pricing." })).structuredContent).toMatchObject({ ok: true });
    const plan = (await call(writer, "read_document", { document_id: "plan" })).structuredContent.document;
    expect(plan.text).toBe("We agreed the pricing tiers stay simple.\n\nAgents found per-seat pricing.");
    expect((await call(writer, "append_to_document", { document_id: created.document_id, content: "Second finding." })).structuredContent.ok).toBe(true);
    expect((await call(writer, "read_document", { document_id: created.document_id })).structuredContent.document.text)
      .toBe("Competitors charge per seat.\n\nSecond finding.");
    expect(await call(writer, "append_to_document", { document_id: "chat", content: "x" })).toMatchObject({ isError: true });
    expect(await call(writer, "append_to_document", { document_id: "missing", content: "x" })).toMatchObject({ isError: true });
    expect(await call(writer, "create_document", { title: "Linked", content: "x", relations: [{ type: "part-of", document_id: "missing" }] }))
      .toMatchObject({ isError: true });
  });

  test("file names and appends keep documents readable", () => {
    expect(documentFileName("  ../a/b\\c: [[x]] # ^y  ")).toBe("a b c x y");
    expect(documentFileName("???")).toBe("Untitled");
    expect(appendToSource("---\ntitle: \"Plain\"\n---\n\nBody.\n\n", "More.")).toBe("---\ntitle: \"Plain\"\n---\n\nBody.\n\nMore.");
    expect(mcpToolsFor("read")).toBe(MCP_TOOLS);
  });

  test("a connector registers, the member approves it, and its OAuth tokens reach the vault until revoked", async () => {
    await fixture.client.query("update marginchat_users set billing_status = 'active' where id = 'plus'");
    const resource = await (await fetch(`${origin}/.well-known/oauth-protected-resource/api/mcp`)).json();
    expect(resource).toMatchObject({ resource: `${origin}/api/mcp`, authorization_servers: [origin] });
    const metadata = await (await fetch(`${origin}/.well-known/oauth-authorization-server`)).json();
    expect(metadata).toMatchObject({ issuer: origin, authorization_endpoint: `${origin}/oauth/authorize`,
      token_endpoint: `${origin}/api/oauth/token`, registration_endpoint: `${origin}/api/oauth/register`, code_challenge_methods_supported: ["S256"] });
    const challengeless = await rpc(null, "initialize");
    expect(challengeless.status).toBe(401);
    expect(challengeless.headers.get("www-authenticate")).toBe(`Bearer resource_metadata="${origin}/.well-known/oauth-protected-resource"`);

    const register = (body: unknown) => fetch(`${origin}/api/oauth/register`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    expect((await (await register({ redirect_uris: ["http://evil.example/cb"] })).json()).error).toBe("invalid_redirect_uri");
    const redirectUri = "https://claude.ai/api/mcp/auth_callback";
    const registered = await register({ client_name: "Claude", redirect_uris: [redirectUri], token_endpoint_auth_method: "none" });
    expect(registered.status).toBe(201);
    const { client_id: clientId } = await registered.json();

    const verifier = "v".repeat(64);
    const challenge = createHash("sha256").update(verifier).digest("base64url");
    const request = { response_type: "code", client_id: clientId, redirect_uri: redirectUri, code_challenge: challenge,
      code_challenge_method: "S256", state: "s1", scope: "vault:read vault:write", resource: `${origin}/api/mcp` };
    const described = await (await fetch(`${origin}/api/oauth/authorization?${new URLSearchParams(request)}`)).json();
    expect(described).toEqual({ clientName: "Claude", redirectHost: "claude.ai", scope: "write" });
    expect((await (await fetch(`${origin}/api/oauth/authorization?${new URLSearchParams({ ...request, redirect_uri: "https://evil.example/" })}`)).json()).error)
      .toBe("invalid_request");

    const decide = (body: unknown, user = "plus", headers: Record<string, string> = {}) => fetch(`${origin}/api/oauth/authorization`, { method: "POST",
      headers: { Cookie: `margin_chat_session=session-${user}`, "Content-Type": "application/json", "X-Margin-Agent-Settings": "1", ...headers }, body: JSON.stringify(body) });
    expect((await decide({ request, allow: true }, "plus", { "X-Margin-Agent-Settings": "" })).status).toBe(403);
    expect((await decide({ request, allow: true }, "free")).status).toBe(403);
    const denied = new URL((await (await decide({ request, allow: false })).json()).redirectTo);
    expect([denied.origin + denied.pathname, denied.searchParams.get("error"), denied.searchParams.get("state")]).toEqual([redirectUri, "access_denied", "s1"]);
    const approve = async () => new URL((await (await decide({ request, allow: true, write: true })).json()).redirectTo).searchParams.get("code")!;

    const token = (fields: Record<string, string>) => fetch(`${origin}/api/oauth/token`, { method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams(fields) });
    const firstCode = await approve();
    const wrong = await token({ grant_type: "authorization_code", code: firstCode, redirect_uri: redirectUri, client_id: clientId, code_verifier: "w".repeat(64) });
    expect([wrong.status, (await wrong.json()).error]).toEqual([400, "invalid_grant"]);
    // A code is spent by its first use, right or wrong.
    expect((await token({ grant_type: "authorization_code", code: firstCode, redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier })).status).toBe(400);
    const granted = await (await token({ grant_type: "authorization_code", code: await approve(), redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier })).json();
    expect(granted).toMatchObject({ token_type: "Bearer", expires_in: 3600, scope: "vault:read vault:write" });
    expect((await (await rpc(granted.access_token, "tools/list")).json()).result.tools.map((tool: any) => tool.name)).toContain("create_document");

    const listed = (await (await settings("plus")).json()).tokens.filter((item: any) => item.connector);
    expect(listed).toMatchObject([{ name: "Claude", scope: "write", connector: true }]);

    const refreshed = await (await token({ grant_type: "refresh_token", refresh_token: granted.refresh_token, client_id: clientId })).json();
    expect(refreshed.access_token).not.toBe(granted.access_token);
    expect((await rpc(granted.access_token, "tools/list")).status).toBe(401);
    expect((await rpc(refreshed.access_token, "tools/list")).status).toBe(200);
    expect((await token({ grant_type: "refresh_token", refresh_token: granted.refresh_token, client_id: clientId })).status).toBe(400);
    // Reconnecting the same app replaces its earlier connection.
    await (await token({ grant_type: "authorization_code", code: await approve(), redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier })).json();
    expect((await (await settings("plus")).json()).tokens.filter((item: any) => item.connector)).toHaveLength(1);
    expect((await rpc(refreshed.access_token, "tools/list")).status).toBe(401);

    const last = await (await token({ grant_type: "authorization_code", code: await approve(), redirect_uri: redirectUri, client_id: clientId, code_verifier: verifier })).json();
    await fetch(`${origin}/api/oauth/revoke`, { method: "POST", headers: { "Content-Type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ token: last.refresh_token, client_id: clientId }) });
    expect((await rpc(last.access_token, "tools/list")).status).toBe(401);
    expect((await token({ grant_type: "password", client_id: clientId })).status).toBe(400);
    expect((await token({ grant_type: "refresh_token", refresh_token: "x", client_id: "unknown" })).status).toBe(401);
  });

  test("connectors may return to HTTPS addresses or this computer only", () => {
    expect(["https://chatgpt.com/connector_platform_oauth_redirect", "http://localhost:3334/cb", "http://127.0.0.1/cb"].every(isAllowedRedirectUri)).toBe(true);
    expect(["http://example.com/cb", "javascript:alert(1)", "https://a.example/#x", "https://u:p@a.example/"].some(isAllowedRedirectUri)).toBe(false);
  });

  test("tool names and schemas match what MCP clients expect", () => {
    for (const tool of mcpToolsFor("write")) {
      expect(tool.name).toMatch(/^[a-z_]{1,64}$/u);
      expect(tool.inputSchema.required?.length).toBeGreaterThan(0);
    }
  });
});
