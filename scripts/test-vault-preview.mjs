/**
 * Isolated browser fixture: serves the real built client and vault API on loopback.
 * Uses temporary files and in-memory feature/auth records; never loads production
 * configuration, a live database, an embedding provider, or a cloud account.
 * Run: bun scripts/test-vault-preview.mjs [port]
 * Control: POST /api/fixture with X-Margin-Test-Fixture: 1 and a JSON body.
 * Optional synthetic suggestions: { action: "controls", jev: true }. No model calls
 * or external network are made; /api/chat stays unavailable in every fixture mode.
 */
import { createServer } from "node:http";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, extname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { createApiHandler } from "../server/routes/api.mjs";
import { createVaultService } from "../server/vault/index.mjs";
import { createFileVaultStorage } from "../server/vault/storage.mjs";
import { createDocumentService } from "../server/documents/index.mjs";
import { readJsonBody, sendJson } from "../server/http/json.mjs";
import { validateWorkspaceAnalysis } from "../server/semantic/index.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
await stat(join(dist, "index.html"));
const directory = await mkdtemp(join(tmpdir(), "margin-chat-preview-"));
const controls = { offline: false, delayMs: 0, authDelayMs: 0, signedIn: true, free: false, jev: false, userId: "preview-user" };
let activeApiRequests = 0;
const requestCounts = { chat: 0, jevWorkspace: 0 };
const projection = new Map();
const attachments = new Map();
const noKeys = { byProvider: Object.fromEntries(["openai", "gemini", "huggingface", "xai"].map((provider) => [provider, { configured: false, hint: null }])), hasAny: false };
function user() {
  return {
    id: controls.userId, displayName: "Vault Preview", email: `${controls.userId}@example.test`,
    role: controls.free ? "member" : "admin", apiKeys: noKeys,
    billing: {
      accessKind: controls.free ? "trial" : "admin", status: controls.free ? "inactive" : "active",
      cancelAtPeriodEnd: false, creditBalanceMicros: 0, currentPeriodEnd: null,
      hasAccess: true, hasCustomer: false, priceId: null,
      trialCallsLimit: 100, trialCallsRemaining: 100, trialCallsUsed: 0,
    },
  };
}
const key = (userId, documentId) => `${userId}/${documentId}`;
const database = {
  ready: async () => undefined,
  getHealth: () => ({ configured: true, ready: true, host: "isolated fixture" }),
  loadWorkspace: async () => null,
  listVaultAttachments: async () => [],
  getVaultProjectionRevision: async (userId) => projection.get(userId)?.revision ?? null,
  async projectVaultState(userId, state, revision, { force = false, attachments: originals = [], deletedAttachmentIds = [] } = {}) {
    const current = projection.get(userId)?.revision ?? -1;
    if (current > revision || (current === revision && !force)) return { projected: false, vaultRevision: current };
    for (const id of deletedAttachmentIds) attachments.delete(key(userId, id));
    for (const original of originals) await database.restoreVaultAttachment({ userId, ...original });
    projection.set(userId, { state, revision });
    return { projected: true, vaultRevision: revision };
  },
  async restoreVaultAttachment({ userId, attachment, bytes }) {
    const existing = attachments.get(key(userId, attachment.id));
    const record = { ...attachment, bytes: Buffer.from(bytes), status: existing?.status ?? "processing", error: existing?.error ?? null };
    attachments.set(key(userId, attachment.id), record);
    const { bytes: _, ...descriptor } = record;
    return descriptor;
  },
  getVaultAttachment: async ({ userId, documentId }) => attachments.get(key(userId, documentId)) ?? null,
  async failDocument({ userId, documentId, error }) {
    const record = attachments.get(key(userId, documentId));
    if (!record) return null;
    Object.assign(record, { status: "failed", error });
    return record;
  },
  deleteDocument: async ({ userId, documentId }) => attachments.delete(key(userId, documentId)),
  getCaptureToken: async () => null,
};
const vaultService = createVaultService({ database, storage: createFileVaultStorage(directory), env: {} });
const documentService = createDocumentService({ database, vaultService, env: {} });
const authService = {
  getAuthContext: async () => ({ user: controls.signedIn ? user() : null, shouldClearSession: false }),
  login: async () => { controls.signedIn = true; return { user: user(), cookie: "preview-session=1; SameSite=Strict; Path=/" }; },
  logout: async () => { controls.signedIn = false; return { cookie: "preview-session=; Max-Age=0; Path=/" }; },
  buildClearedSessionCookie: () => "preview-session=; Max-Age=0; Path=/",
  updateProfile: async (_id, values) => ({ ...user(), ...values }),
};
// Deterministic test data only. This object never constructs the real semantic
// service, reads a key, or sends a request to a model provider.
const syntheticCategoryRules = [
  ["design", /\b(?:design(?:ing)?|ui|ux|layout|prototype|wireframe|typography)\b/iu],
  ["coding", /\b(?:code|coding|debug|api|typescript|javascript|react|software)\b/iu],
  ["research", /\b(?:research|evidence|study|compare|investigate|interview)\b/iu],
  ["writing", /\b(?:writing|write|draft|essay|newsletter|article|rewrite)\b/iu],
  ["planning", /\b(?:plan|planning|launch|roadmap|schedule|milestone|strategy)\b/iu],
  ["data", /\b(?:data|dataset|spreadsheet|metrics|chart|statistics|sql)\b/iu],
  ["personal", /\b(?:travel|family|recipe|workout|vacation|personal)\b/iu],
];
const fixtureIgnoredWords = new Set(["the", "and", "for", "with", "this", "that", "from", "into", "your", "how", "what", "chat", "note", "app", "project"]);
const fixtureWords = (value) => new Set(value.toLowerCase().match(/[a-z0-9]{3,}/gu)?.filter((word) => !fixtureIgnoredWords.has(word)) ?? []);
function syntheticCategory(item) {
  return syntheticCategoryRules.find(([, pattern]) => pattern.test(item.title))?.[0]
    ?? syntheticCategoryRules.find(([, pattern]) => pattern.test(item.content))?.[0]
    ?? "general";
}
const semanticService = {
  get configured() { return controls.jev; },
  async analyzeWorkspace({ payload, signal }) {
    requestCounts.jevWorkspace++;
    signal?.throwIfAborted();
    if (!controls.jev) return { available: false, categories: [], groupSuggestions: [], related: [], warning: "Synthetic Jev is disabled in this isolated fixture." };
    const { items, groups, current, categories, related } = validateWorkspaceAnalysis(payload);
    const categoryResults = categories ? items.map((item) => ({ id: item.id, categoryId: syntheticCategory(item), confidence: 0.98 })) : [];
    const groupSuggestions = items.filter((item) => item.content.trim()).flatMap((item) => {
      const words = fixtureWords(`${item.title} ${item.content}`);
      const matches = groups.map((group) => {
        const groupWords = fixtureWords(`${group.name} ${group.memberTitles.join(" ")}`);
        const score = [...groupWords].filter((word) => words.has(word)).length;
        return { group, score };
      }).filter(({ score }) => score > 0).sort((a, b) => b.score - a.score || a.group.id.localeCompare(b.group.id));
      if (!matches.length || matches[1]?.score === matches[0].score) return [];
      return [{ id: item.id, groupId: matches[0].group.id, confidence: 0.96 }];
    });
    const currentWords = fixtureWords(`${current.title} ${current.content}`);
    const relatedResults = related ? items.filter((item) => item.id !== current.id).flatMap((item) => {
      const overlap = [...fixtureWords(`${item.title} ${item.content}`)].filter((word) => currentWords.has(word)).length;
      return overlap >= 2 ? [{ id: item.id, score: Math.min(0.95, 0.6 + overlap * 0.03) }] : [];
    }).sort((a, b) => b.score - a.score || a.id.localeCompare(b.id)).slice(0, 5) : [];
    return { available: true, model: "synthetic-jev-fixture", categories: categoryResults, groupSuggestions, related: relatedResults };
  },
};
const handler = createApiHandler({
  authService, database, documentService, vaultService, semanticService,
  apiKeyService: { getDecryptedKeys: async () => ({}), getSummaries: async () => noKeys },
  captureService: { list: async () => ({ captures: [], nextCursor: null }) },
  billingService: {},
  chatService: { buildHealthPayload: (storage) => ({ storage, status: "ok" }) },
  runtimeConfig: { host: "127.0.0.1", port: 0 },
});

async function seed(userId) {
  const snapshot = await vaultService.snapshot(userId);
  if (snapshot.manifest.revision) return;
  await vaultService.commit(userId, [
    { path: "Notes/shared.md", content: "# Shared note\n\nThis Markdown is shared between preview devices.\n", baseRevision: null },
    { path: "Notes/second.md", content: "# Second note\n\nIndependent edits can sync without conflicts.\n", baseRevision: null },
  ]);
}
await seed(controls.userId);
const mimeTypes = { ".html": "text/html", ".js": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
const server = createServer(async (request, response) => {
  try {
    const url = new URL(request.url, "http://127.0.0.1");
    if (url.pathname === "/api/fixture") {
      if (request.method === "POST") {
        if (request.headers["x-margin-test-fixture"] !== "1") return sendJson(response, 403, { error: "Fixture control header required" });
        const body = await readJsonBody(request);
        if (body.action === "remote") {
          const current = (await vaultService.snapshot(controls.userId)).manifest;
          await vaultService.commit(controls.userId, [{
            path: body.path, content: body.content, baseRevision: current.files[body.path]?.revision ?? null,
          }]);
        } else if (body.action === "controls") {
          for (const field of ["offline", "signedIn", "free", "jev"]) if (typeof body[field] === "boolean") controls[field] = body[field];
          for (const field of ["delayMs", "authDelayMs"]) if (Number.isSafeInteger(body[field]) && body[field] >= 0 && body[field] <= 120000) controls[field] = body[field];
          if (typeof body.userId === "string" && /^preview-[a-z0-9_-]+$/u.test(body.userId)) controls.userId = body.userId;
          if (body.seed !== false) await seed(controls.userId);
        } else return sendJson(response, 400, { error: "Use action: controls or remote" });
      }
      const manifest = (await vaultService.snapshot(controls.userId)).manifest;
      return sendJson(response, 200, { controls, user: user(), manifest, activeApiRequests, requestCounts, projection: projection.get(controls.userId) ?? null, directory }, { "Cache-Control": "no-store" });
    }
    if (url.pathname.startsWith("/api/")) {
      activeApiRequests++;
      try {
        const delay = url.pathname === "/api/auth/session" ? controls.authDelayMs : controls.delayMs;
        if (delay) await new Promise((done) => setTimeout(done, delay));
        if (controls.offline) return sendJson(response, 503, { error: "The fixture is simulating an offline API." });
        if (url.pathname.startsWith("/api/chat")) {
          requestCounts.chat++;
          return sendJson(response, 503, { error: "Model calls are intentionally unavailable in this isolated preview." });
        }
        return await handler(request, response);
      } finally { activeApiRequests--; }
    }
    const pathname = decodeURIComponent(url.pathname);
    const candidate = resolve(dist, `.${pathname}`);
    if (candidate !== dist && !candidate.startsWith(`${dist}${sep}`)) return sendJson(response, 400, { error: "Invalid path" });
    let path = candidate;
    try { if (!(await stat(path)).isFile()) path = join(dist, "index.html"); }
    catch { path = join(dist, "index.html"); }
    const bytes = await readFile(path);
    response.writeHead(200, {
      "Content-Type": `${mimeTypes[extname(path)] ?? "application/octet-stream"}; charset=utf-8`,
      "Cache-Control": "no-cache", "Content-Length": bytes.length,
    });
    response.end(bytes);
  } catch (error) {
    if (!response.headersSent) sendJson(response, error.statusCode ?? 500, { error: error.message });
    else response.end();
  }
});
const port = Number(process.argv[2] ?? 0);
server.listen(port, "127.0.0.1", () => {
  console.log(JSON.stringify({ url: `http://127.0.0.1:${server.address().port}`, directory, fixture: "/api/fixture" }));
});
process.on("SIGTERM", () => server.close(() => process.exit(0)));
process.on("SIGINT", () => server.close(() => process.exit(0)));
