/**
 * Isolated browser fixture: serves the real built client and vault API on loopback.
 * Uses temporary files and in-memory feature/auth records; never loads production
 * configuration, a live database, an embedding provider, or a cloud account.
 * Run: bun scripts/test-vault-preview.mjs [port]
 * Control: POST /api/fixture with X-Margin-Test-Fixture: 1 and a JSON body.
 * Optional synthetic suggestions: { action: "controls", jev: true }. No model calls
 * or external network are made. Optional { action: "controls", chat: true }
 * serves deterministic synthetic document replies; chat otherwise stays unavailable.
 * With { web: true } as well, a roadmap built from a link reads that page from the network.
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
import { readImportPage } from "../server/chat/agent/webImport.mjs";
import { createProposalTools, describeProposalStep, documentInPrompt } from "../server/chat/agent/proposalTools.mjs";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
await stat(join(dist, "index.html"));
// PREVIEW_DIR reuses a vault saved by an earlier run (for timing runs on a large seeded vault).
const directory = process.env.PREVIEW_DIR || await mkdtemp(join(tmpdir(), "margin-chat-preview-"));
const controls = { offline: false, delayMs: 0, authDelayMs: 0, signedIn: true, free: false, jev: false, chat: false, web: false, userId: "preview-user" };
let activeApiRequests = 0;
const requestCounts = { chat: 0, jevWorkspace: 0 };
let lastChatRequest = null;
let syntheticReplyCount = 0;
const projection = new Map();
const attachments = new Map();
const noKeys = { byProvider: Object.fromEntries(["openai", "anthropic", "gemini", "huggingface", "xai"].map((provider) => [provider, { configured: false, hint: null }])), hasAny: false };
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
const flashcardRows = { cards: new Map(), reviews: new Map(), seq: 0 };
const ratchetRows = new Map();

/**
 * A synthetic agent run for a roadmap request. "Build this roadmap from the page at <link>" reads
 * that page with the real reader (only with { action: "controls", web: true }, the one case this
 * fixture uses the network); "Dive deeper" uses the list in the prompt's document. The outline's
 * headings become stages and steps through the real propose_roadmap tool. No model is called.
 */
async function syntheticRoadmapRun(body) {
  const prompt = String(body.messages?.at(-1)?.content ?? "");
  const link = /Build this roadmap from the page at (\S+)/u.exec(prompt)?.[1];
  const steps = [];
  let outline = "", goal = "";
  if (link) {
    if (!controls.web) return null;
    const page = await readImportPage(link, {});
    outline = page.markdown;
    goal = page.title;
    steps.push({ label: `Read \u201c${page.title}\u201d`, detail: new URL(link).hostname, ok: true });
  } else if (prompt.includes("Dive deeper into")) {
    const document = documentInPrompt(body);
    goal = document?.title || "This topic";
    const topics = String(document?.text ?? "").split(/\n#/u)[0].split("\n").map((line) => /^\s*[-*]\s+(.+)$/u.exec(line)?.[1]?.trim()).filter(Boolean).slice(0, 12);
    const half = Math.ceil(topics.length / 2);
    outline = `## Start here\n${topics.slice(0, half).map((topic) => `### ${topic}\n- What it is\n- When to use it\n- A small example`).join("\n")}\n## Go further\n${topics.slice(half).map((topic) => `### ${topic}\n- How it works\n- Common mistakes`).join("\n")}`;
  } else return null;
  const stages = [];
  for (const line of outline.split("\n")) {
    const heading = /^(#{2,3})\s+(.+)$/u.exec(line);
    const bullet = /^\s*[-*]\s+(.+)$/u.exec(line);
    if (heading?.[1] === "##") stages.push({ title: heading[2].trim(), steps: [] });
    else if (heading && stages.length) stages.at(-1).steps.push({ title: heading[2].trim(), notes: [] });
    else if (bullet && stages.at(-1)?.steps.length) stages.at(-1).steps.at(-1).notes.push(`- ${bullet[1].trim()}`);
    // A page with one level of headings: its list items are the steps.
    else if (bullet && stages.length) stages.at(-1).flat = [...(stages.at(-1).flat ?? []), bullet[1].trim()];
  }
  let count = 0, previous = null;
  const args = { roadmap_id: "", goal, summary: link ? "Follows the page's sections and topics." : "Subtopics, from first steps to advanced.",
    stages: stages.map((stage) => ({ title: stage.title, steps: (stage.steps.length ? stage.steps : (stage.flat ?? [stage.title]).map((title) => ({ title, notes: [] }))).map((step, index) => {
      const key = `s${count += 1}`;
      const needs = index > 0 && previous ? [previous] : [];
      previous = key;
      return { key, document_id: "", title: step.title, notes: step.notes.join("\n"), why: "", needs };
    }) })).filter((stage) => stage.steps.length).slice(0, 12) };
  const tools = createProposalTools({ chatRequest: { ...body, conversation: body.conversation ?? { id: body.sourceDocumentId } }, snapshots: new Map() });
  const output = tools.run("propose_roadmap", args);
  steps.push({ ...describeProposalStep("propose_roadmap", args, output) });
  const total = args.stages.reduce((sum, stage) => sum + stage.steps.length, 0);
  return { steps, proposals: tools.list(), reply: output.ok
    ? `I laid out ${goal} as ${args.stages.length} stages and ${total} steps${link ? ", following the page's order" : ""}. None of your documents cover these topics yet, so each step gets a new document with the points to cover. Approve it below to add it.`
    : `I couldn't build the roadmap: ${output.error}` };
}

/**
 * Synthetic Ratchet replies: claims are the document's lines with a number or
 * "lifespan" in them; each claim with passages is judged in turn supported,
 * contradicted, unsupported, citing its first passage's longest line word for word.
 */
function syntheticRatchetReply(asked) {
  const prompt = (() => { try { return JSON.parse(asked).at(-1)?.content ?? ""; } catch { return ""; } })();
  const data = (() => { try { return JSON.parse(prompt.slice(prompt.lastIndexOf("\n\n") + 2)); } catch { return null; } })();
  if (!data) return null;
  if (prompt.startsWith("Find the checkable claims")) {
    const claims = String(data.lines ?? "").split("\n").map((line) => /^\[(\d+):(\d+)\] (.*)$/.exec(line)).filter(Boolean)
      .filter((match) => /\d|lifespan/i.test(match[3]) && !/^#/.test(match[3])).slice(0, 4)
      .map((match) => ({ from: `${match[1]}:${match[2]}`, to: `${match[1]}:${match[2]}`, span: match[3].replace(/^[-*]\s+/, ""), claim: match[3].replace(/^[-*]\s+/, "") }));
    return JSON.stringify({ claims });
  }
  const verdicts = [["supported", "supports"], ["contradicted", "contradicts"], ["unsupported", "related"]];
  let turn = 0;
  return JSON.stringify({ results: (data.claims ?? []).map((claim) => {
    const passage = claim.passages?.[0];
    if (!passage) return { claim: claim.id, verdict: "insufficient-evidence", evidence: [], reason: "Nothing to go on." };
    const [verdict, stance] = verdicts[turn++ % verdicts.length];
    const quote = passage.text.split("\n").sort((a, b) => b.length - a.length)[0].replace(/^[-*#>\s]+/, "");
    return { claim: claim.id, verdict, evidence: [{ passage: passage.id, quote, stance }], reason: `Synthetic: ${passage.document} says so.` };
  }) });
}
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
  // Flashcards, in memory, with the same rules as Postgres: newer cards win, reviews are added once.
  async saveFlashcardChanges({ userId, cards, reviews }) {
    for (const card of cards) {
      const stored = flashcardRows.cards.get(key(userId, card.id));
      if (!stored || stored.card.updatedAt < card.updatedAt) flashcardRows.cards.set(key(userId, card.id), { userId, card, seq: ++flashcardRows.seq });
    }
    for (const review of reviews) {
      if (!flashcardRows.reviews.has(key(userId, review.id))) flashcardRows.reviews.set(key(userId, review.id), { userId, review, seq: ++flashcardRows.seq });
    }
  },
  async saveRatchetCheck({ userId, documentId, claims, run }) { ratchetRows.set(key(userId, documentId), { claims, run }); },
  async readRatchetCheck({ userId, documentId }) { return ratchetRows.get(key(userId, documentId)) ?? { claims: [], run: null }; },
  async readFlashcardChanges({ userId, cardSince = 0, reviewSince = 0, limit = 2000 }) {
    const cards = [...flashcardRows.cards.values()].filter((row) => row.userId === userId && row.seq > cardSince).sort((a, b) => a.seq - b.seq).slice(0, limit);
    const reviews = [...flashcardRows.reviews.values()].filter((row) => row.userId === userId && row.seq > reviewSince).sort((a, b) => a.seq - b.seq).slice(0, limit);
    return {
      cards: cards.map((row) => row.card), reviews: reviews.map((row) => row.review),
      cardCursor: cards.at(-1)?.seq ?? cardSince, reviewCursor: reviews.at(-1)?.seq ?? reviewSince,
      more: cards.length === limit || reviews.length === limit,
    };
  },
};
// PREVIEW_STORAGE_DELAY_MS models cloud storage latency per read (Vercel Blob is ~50-150 ms).
// PREVIEW_COLD=1 starts each request on a fresh vault service, like a cold serverless instance.
const storageDelayMs = Number(process.env.PREVIEW_STORAGE_DELAY_MS) || 0;
const fileStorage = createFileVaultStorage(directory);
const storageReads = { count: 0 };
const storage = storageDelayMs ? { ...fileStorage, async read(key) {
  storageReads.count += 1;
  await new Promise((done) => setTimeout(done, storageDelayMs));
  return fileStorage.read(key);
} } : fileStorage;
const newVaultService = () => createVaultService({ database, storage, env: {} });
let vaultService = newVaultService();
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
const coldStart = process.env.PREVIEW_COLD === "1";
const currentVaultService = new Proxy({}, { get: (_, name) => vaultService[name] });
const handler = createApiHandler({
  authService, database, documentService, vaultService: currentVaultService, semanticService,
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
const mimeTypes = { ".html": "text/html", ".js": "application/javascript", ".mjs": "application/javascript", ".css": "text/css", ".svg": "image/svg+xml", ".json": "application/json", ".webmanifest": "application/manifest+json" };
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
          for (const field of ["offline", "signedIn", "free", "jev", "chat", "web"]) if (typeof body[field] === "boolean") controls[field] = body[field];
          for (const field of ["delayMs", "authDelayMs", "chatDelayMs"]) if (Number.isSafeInteger(body[field]) && body[field] >= 0 && body[field] <= 120000) controls[field] = body[field];
          if (typeof body.userId === "string" && /^preview-[a-z0-9_-]+$/u.test(body.userId)) controls.userId = body.userId;
          if (body.seed !== false) await seed(controls.userId);
        } else return sendJson(response, 400, { error: "Use action: controls or remote" });
      }
      const manifest = (await vaultService.snapshot(controls.userId)).manifest;
      return sendJson(response, 200, { controls, user: user(), manifest, activeApiRequests, requestCounts, lastChatRequest, projection: projection.get(controls.userId) ?? null, directory }, { "Cache-Control": "no-store" });
    }
    if (url.pathname.startsWith("/api/")) {
      activeApiRequests++;
      try {
        const delay = url.pathname === "/api/auth/session" ? controls.authDelayMs : controls.delayMs;
        if (delay) await new Promise((done) => setTimeout(done, delay));
        if (controls.offline) return sendJson(response, 503, { error: "The fixture is simulating an offline API." });
        if (url.pathname.startsWith("/api/chat")) {
          requestCounts.chat++;
          if (controls.chat && request.method === "POST") {
            if (!controls.signedIn) return sendJson(response, 401, { error: "Sign in to continue." });
            if (request.headers["x-margin-vault-user"] && request.headers["x-margin-vault-user"] !== controls.userId) return sendJson(response, 409, { error: "The fixture account changed." });
            const body = await readJsonBody(request, 512 * 1024);
            if (url.pathname.endsWith("/title")) return sendJson(response, 200, { title: "A thoughtful reading document" });
            lastChatRequest = { userId: controls.userId, body };
            syntheticReplyCount++;
            const metadata = { model: "synthetic-document-fixture", requestedModelId: body.modelId,
              requestedServiceId: body.serviceId, resolvedServiceId: body.serviceId, credentialSource: "personal" };
            // A diagram edit gets a changed diagram, wrapped in the kind of words the app must drop.
            const asked = JSON.stringify(body.messages ?? []);
            const ratchetReply = asked.includes("Find the checkable claims") || asked.includes("Check each claim against the passages") ? syntheticRatchetReply(JSON.stringify(body.messages ?? [])) : null;
            const reply = ratchetReply ? ratchetReply : asked.includes("The user wrote a note on a whiteboard")
              ? "```mermaid\nflowchart TD\n  N[Sleep under 6 hours] --> C[Higher cortisol]\n  N --> I[Worse insulin response]\n  C --> R[More belly fat]\n  I --> R\n  R --> Q{Fix sleep first?}\n```"
              : asked.includes("selected passage is a Mermaid diagram") || asked.includes("Help edit a Mermaid diagram")
              ? "Here is the updated diagram:\n\n```mermaid\nflowchart TD\n  A[Pack] --> S[Pack snacks]\n  S --> B{Rain?}\n  B -->|yes| C[Museum]\n  B -->|no| D[Beach]\n```\n\nI added a snack step."
              : asked.includes("Ask me one short question that tests this passage")
                ? "What human evidence shows a weekly dose avoids the immune effects, rather than mouse data?"
              : asked.includes("Answer the user's question about this note")
                ? "The note's main claim is that rapamycin \"extends lifespan in mice\" by blocking mTOR. The weak link is the step to people: \"a weekly dose should be safe\" rests on the mouse data alone.\n\n### Try next\n\n- What human trials have tested weekly dosing?\n- Which immune side effects matter most at that dose?\n- Add a line on what result would change your mind."
              : asked.includes("Write up to") && asked.includes("flashcards")
                ? "1. What does rapamycin block? :: mTOR\n\n2. Autophagy ::: The cell's recycling of its own parts\n\n3. Rapamycin {{c1::extends lifespan}} in {{c2::mice}}.\n\nThese cards cover the main claim."
              : asked.includes("so I can learn it. It is a step in my roadmap")
                ? "## What it is\n\nThis topic covers the rules a client and a server follow when they talk over the web: the client sends a request, the server sends back a response.\n\n## Why it matters here\n\nEvery route you write answers one kind of request, so knowing the parts of a request tells you what your code receives.\n\n## Key ideas\n\n- A request has a method, a path, headers and sometimes a body.\n- A response has a status code, headers and a body.\n- Status codes come in families: 2xx worked, 4xx the caller made a mistake, 5xx the server failed.\n\n## A small example\n\nA browser sends GET /items/3. The server finds item 3 and answers 200 with the item as JSON. If there is no item 3, it answers 404.\n\n## Check yourself\n\n1. Which part of a request says what to do with the resource?\n2. What does a 404 tell the caller?"
              : asked.includes("builds up in 3 to 5 stages")
                ? "```mermaid\nflowchart LR\n%% stage: The drug\n  R[Rapamycin] --> M[mTOR blocked]\n%% stage: What it changes\n  M --> G[Less cell growth]\n  M --> A[More autophagy]\n%% stage: The claim\n  A --> L[Longer life in mice]\n%% stage: The open question\n  L -.-> H{Same in humans?}\n```"
              : `## A clearer next step ${syntheticReplyCount}\n\nUse a short weekly reflection to connect a saved passage with an action.\n\n### Try this\n\nWrite one sentence about what changed after reading it.`;
            // A roadmap request gets a synthetic agent run: the real propose_roadmap tool, fed an outline.
            const roadmapRun = asked.includes("propose_roadmap") ? await syntheticRoadmapRun(body) : null;
            if (roadmapRun) {
              response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
              response.write(`${JSON.stringify({ type: "metadata", metadata })}\n`);
              for (const step of roadmapRun.steps) { response.write(`${JSON.stringify({ type: "step", step })}\n`); await new Promise((resolve) => setTimeout(resolve, 150)); }
              response.write(`${JSON.stringify({ type: "delta", delta: roadmapRun.reply })}\n`);
              response.end(`${JSON.stringify({ type: "done", metadata: { ...metadata, execution: { schemaVersion: 1, model: metadata.model, provider: "meta-api",
                agent: { steps: roadmapRun.steps, stopReason: "answered", proposals: roadmapRun.proposals } } } })}\n`);
              return;
            }
            response.writeHead(200, { "Content-Type": "application/x-ndjson; charset=utf-8", "Cache-Control": "no-store" });
            response.write(`${JSON.stringify({ type: "metadata", metadata })}\n`);
            // A slow model, to see what the page shows while it thinks.
            if (controls.chatDelayMs) await new Promise((resolve) => setTimeout(resolve, controls.chatDelayMs));
            for (let offset = 0; offset < reply.length; offset += 48) {
              if (response.destroyed) break;
              response.write(`${JSON.stringify({ type: "delta", delta: reply.slice(offset, offset + 48) })}\n`);
              await new Promise((resolve) => setTimeout(resolve, 35));
            }
            if (!response.destroyed) response.end(`${JSON.stringify({ type: "done" })}\n`);
            return;
          }
          return sendJson(response, 503, { error: "Model calls are intentionally unavailable in this isolated preview." });
        }
        if (coldStart) vaultService = newVaultService();
        const started = Date.now(), reads = storageReads.count;
        if (storageDelayMs) response.once("finish", () => console.log(`${url.pathname} ${Date.now() - started} ms, ${storageReads.count - reads} storage reads`));
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
