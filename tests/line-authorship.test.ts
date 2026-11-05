import { describe, expect, test } from "bun:test";
import { createMarkdownWorkspace, discoverMarkdownWorkspace, parseMarkdownWorkspace, readAgentEditPolicy } from "@margin-chat/workspace-contracts";
import { createEmptyState } from "../client/src/initialState";
import { createVaultService } from "../server/vault/index.mjs";
import { digest } from "../server/vault/storage.mjs";
import {
  diffSequences, documentLines, forwardBlocks, inferBlocks, sha256, splitLines, summarizeBlocks, wrapperFor,
} from "../server/vault/provenance/lines.mjs";
import { ownerActor } from "../server/vault/provenance/store.mjs";
import { agentActor, createWriteTools } from "../server/mcp/writeTools.mjs";

function memoryStorage() {
  const objects = new Map<string, Buffer>();
  return {
    kind: "memory", objects,
    async read(key: string) { const bytes = objects.get(key); return bytes ? { bytes: Buffer.from(bytes), etag: digest(bytes) } : null; },
    async putImmutable(key: string, bytes: Buffer) { objects.set(key, Buffer.from(bytes)); },
    async compareAndSwap(key: string, bytes: Buffer, expected: string | null) {
      if ((objects.has(key) ? digest(objects.get(key)!) : null) !== expected) return false;
      objects.set(key, Buffer.from(bytes)); return true;
    },
  };
}

const at = "2026-11-01T10:00:00.000Z";
const owner = ownerActor("jon");
type Block = { id: string; content: string; authorship?: "ai" | "user" | "mixed"; generationId?: string; origin?: unknown };

/** One in-app document, rendered to its vault file exactly as the app saves it. */
function documentFile(blocks: Block[], extra: Record<string, unknown> = {}, generations: unknown[] = [], prompts: unknown[] = []) {
  const state = createEmptyState();
  const conversation = state.conversations[state.rootId];
  Object.assign(conversation, { id: "doc", title: "Doc", createdAt: at, updatedAt: at, childIds: [], ...extra });
  conversation.document = { schemaVersion: 1, prompts, generations,
    blocks: blocks.map((block) => ({ kind: "markdown", createdAt: at, updatedAt: at, ...block })) } as any;
  state.conversations = { doc: conversation };
  const [[path, content]] = Object.entries(createMarkdownWorkspace(state, at).files as Record<string, string>);
  return { path, content };
}

const authors = (blocks: any[]) => blocks.map((block) => [block.blockId, block.lines.map((line: any) => line.author.type).join(",")]);

describe("line diff", () => {
  const lcs = (a: string[], b: string[]) => {
    const table = Array.from({ length: a.length + 1 }, () => new Array(b.length + 1).fill(0));
    for (let i = a.length - 1; i >= 0; i -= 1) for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i][j] = a[i] === b[j] ? table[i + 1][j + 1] + 1 : Math.max(table[i + 1][j], table[i][j + 1]);
    }
    return table[0][0];
  };

  test("Myers diff finds a shortest edit script and replays to the new sequence", () => {
    let seed = 7;
    const random = () => (seed = (seed * 48271) % 2147483647) / 2147483647;
    for (let round = 0; round < 300; round += 1) {
      const a = Array.from({ length: Math.floor(random() * 12) }, () => "abc"[Math.floor(random() * 3)]);
      const b = Array.from({ length: Math.floor(random() * 12) }, () => "abc"[Math.floor(random() * 3)]);
      const steps = diffSequences(a, b);
      const equal = steps.filter((step: any) => step.type === "equal");
      expect(equal.length).toBe(lcs(a, b));
      expect(steps.filter((step: any) => step.type !== "delete").map((step: any) => b[step.after])).toEqual(b);
      expect(steps.filter((step: any) => step.type !== "insert").map((step: any) => a[step.before])).toEqual(a);
      for (const step of equal) expect(a[step.before]).toBe(b[step.after]);
    }
  });

  test("lines split on \\n with a trailing \\r dropped, and nothing else normalized", () => {
    expect(splitLines("a\r\n b \n\n")).toEqual(["a", " b ", "", ""]);
    expect(sha256("x")).not.toBe(sha256("x "));
  });
});

describe("shared document format", () => {
  test("agent-edit is a frontmatter property that round-trips, and absent means only lines the user didn't write", () => {
    for (const policy of ["locked", "open", undefined]) {
      const { path, content } = documentFile([{ id: "b", content: "Text." }], policy ? { agentEdit: policy } : {});
      expect(content.includes("agent-edit:")).toBe(Boolean(policy));
      expect(readAgentEditPolicy(content)).toBe(policy ?? "non-authored-only");
      const { manifest, files } = discoverMarkdownWorkspace({ [path]: content });
      expect(parseMarkdownWorkspace(manifest, files)!.conversations.doc.agentEdit).toBe(policy as any);
    }
    expect(readAgentEditPolicy("---\nagent-edit: anything\n---\nBody")).toBe("non-authored-only");
    expect(readAgentEditPolicy("No frontmatter")).toBe("non-authored-only");
  });

  test("an imported block keeps its origin through a save", () => {
    const origin = { type: "import", source: "web", label: "example.com" };
    const { path, content } = documentFile([{ id: "b", content: "Page text.", authorship: "user", origin }]);
    const { manifest, files } = discoverMarkdownWorkspace({ [path]: content });
    expect(parseMarkdownWorkspace(manifest, files)!.conversations.doc.document!.blocks[0].origin).toEqual(origin as any);
  });

  test("the wrapper is derived from line authors and agrees with the codec's (fixture C)", () => {
    const line = (type: string) => ({ author: { type } });
    expect(wrapperFor([line("human"), line("human")] as any)).toBe("user");
    expect(wrapperFor([line("ai"), line("agent")] as any)).toBe("ai");
    expect(wrapperFor([line("ai"), line("human")] as any)).toBe("mixed");
    expect(wrapperFor([line("ai"), line("unknown")] as any)).toBe("mixed");
    const fixture = documentFile([
      { id: "a1", content: "AI one.\nAI two.", authorship: "ai" },
      { id: "u1", content: "Mine.", authorship: "user" },
      { id: "a2", content: "AI kept.\nJon edited this one.", authorship: "mixed" },
    ]);
    const file = documentLines(fixture.path, fixture.content)!;
    expect(file.blocks.map((block: any) => block.wrapper)).toEqual(["ai", "user", "mixed"]);
    expect(fixture.content).toContain('<ai id="a2" edited-by="user">');
  });
});

describe("authorship matcher", () => {
  const app = { type: "human", id: "jon", label: "You" };
  const file = (blocks: { blockId: string; lines: string[]; wrapper?: string }[]) =>
    ({ documentId: "d", path: "d.md", plain: false, kind: "document", blocks: blocks.map((block) => ({ wrapper: "user", origin: null, model: null, ...block })) });

  test("repeated and blank lines never cross blocks, and blank runs keep their authors (fixture E)", () => {
    const repeated = ["same", "same", "same", "same", "same"];
    const genesis = forwardBlocks({ parentBlocks: null, revisionKey: "r1",
      file: file([{ blockId: "x", lines: ["```js", "same", "```", "", ""], wrapper: "ai" }, { blockId: "y", lines: repeated }]),
      authorFor: (block: any) => block.wrapper === "ai" ? { type: "ai", id: "ai:m", label: "M" } : app });
    expect(authors(genesis)).toEqual([["x", "ai,ai,ai,ai,ai"], ["y", "human,human,human,human,human"]]);
    const next = forwardBlocks({ parentBlocks: genesis, revisionKey: "r2",
      file: file([{ blockId: "x", lines: ["```js", "same", "```", "", "", "new"], wrapper: "ai" }, { blockId: "y", lines: [...repeated, "same"] }]),
      authorFor: () => ({ type: "agent", id: "mcp:1", label: "Muse" }) });
    expect(authors(next)).toEqual([["x", "ai,ai,ai,ai,ai,agent"], ["y", "human,human,human,human,human,agent"]]);
    expect(next[1].lines.slice(0, 5).every((line: any) => line.originRevisionId === "r1")).toBe(true);
  });

  test("a moved non-human line keeps its origin; a whitespace-only change is a new line by whoever made it", () => {
    const ai = { type: "ai", id: "ai:m", label: "M" };
    const genesis = forwardBlocks({ parentBlocks: null, revisionKey: "r1", authorFor: () => ai,
      file: file([{ blockId: "a", lines: ["one", "two", "three"] }, { blockId: "b", lines: ["four"] }]) });
    const next = forwardBlocks({ parentBlocks: genesis, revisionKey: "r2", authorFor: () => app,
      file: file([{ blockId: "a", lines: ["three", "one", "two "] }, { blockId: "b", lines: ["four", "two"] }]) });
    expect(authors(next)).toEqual([["a", "ai,ai,human"], ["b", "ai,ai"]]);
    expect(next[0].lines[0].originRevisionId).toBe("r1");
    expect(next[1].lines[1].originRevisionId).toBe("r1");
    expect(next[0].lines[2].originRevisionId).toBe("r2");
  });
});

describe("capture on save", () => {
  function setup() {
    const storage = memoryStorage();
    const vault = createVaultService({ storage });
    return { storage, vault };
  }
  const head = async (vault: any, id = "doc") => vault.provenance.current("jon", id);

  test("the editor's save makes the one line Jon changed his, and the rest of the AI block stays the model's (fixture C)", async () => {
    const { vault } = setup();
    const prompts = [{ id: "p1", content: "Write", createdAt: at, serviceId: "anthropic-api", modelId: "claude-x" }];
    const generations = [{ id: "g1", promptId: "p1", messageId: "m1", createdAt: at, serviceId: "anthropic-api", modelId: "claude-x", status: "complete", blockIds: ["a2"] }];
    const doc = (a2: string, authorship: "ai" | "mixed") => documentFile([
      { id: "a1", content: "AI one.\nAI two.", authorship: "ai" },
      { id: "u1", content: "Mine.", authorship: "user" },
      { id: "a2", content: a2, authorship, generationId: "g1" },
    ], {}, generations, prompts);
    const first = doc("AI kept.\nAI line Jon will edit.", "ai");
    const saved = await vault.commit("jon", [{ path: first.path, content: first.content, baseRevision: null }]);
    const genesis = await head(vault);
    expect(authors(genesis.blocks)).toEqual([["a1", "ai,ai"], ["u1", "human"], ["a2", "ai,ai"]]);
    expect(genesis.blocks[0].lines[0].author).toEqual({ type: "ai", id: "ai:legacy", label: "AI" });
    expect(genesis.blocks[2].lines[0].author).toEqual({ type: "ai", id: "anthropic-api:claude-x", label: "claude-x" });
    const edited = doc("AI kept.\nJon's own version of this line.", "mixed");
    await vault.commit("jon", [{ path: edited.path, content: edited.content, baseRevision: saved.manifest.files[first.path].revision }]);
    const after = await head(vault);
    expect(authors(after.blocks)).toEqual([["a1", "ai,ai"], ["u1", "human"], ["a2", "ai,human"]]);
    expect(after.blocks[2].lines[0].originRevisionId).toBe(genesis.revisionKey);
    expect(after.parentRevisionKey).toBe(genesis.revisionKey);
    expect(after.actor).toEqual(owner);
    expect((await vault.provenance.chain("jon", "doc")).map((sidecar: any) => sidecar.revisionKey)).toEqual([after.revisionKey, genesis.revisionKey]);
  });

  test("an MCP save credits every new line to the token by the name Jon gave it", async () => {
    const { vault } = setup();
    const actor = agentActor({ agentId: "tok1", agentName: "Muse" });
    await vault.commit("jon", [{ path: "Journal.md", content: "---\nmargin-chat-id: mcp-1\ntitle: Journal\n---\nDay one.\n\nDay two.", baseRevision: null }],
      { authorship: { wait: true, actor, source: "mcp", authorFor: () => actor } });
    const sidecar = await head(vault, "mcp-1");
    expect(sidecar.blocks[0].lines.map((line: any) => line.author)).toEqual(Array(3).fill({ type: "agent", id: "mcp:tok1", label: "Muse" }));
    expect(sidecar).toMatchObject({ source: "mcp", actor: { type: "agent", label: "Muse" } });
  });

  test("an imported page is the importer's, until Jon edits a line of it", async () => {
    const { vault } = setup();
    const origin = { type: "import", source: "web", label: "example.com" };
    const first = documentFile([{ id: "page", content: "Imported one.\nImported two.", authorship: "user", origin }]);
    const saved = await vault.commit("jon", [{ path: first.path, content: first.content, baseRevision: null }]);
    expect(authors((await head(vault)).blocks)).toEqual([["page", "import,import"]]);
    const edited = documentFile([{ id: "page", content: "Imported one.\nMy take.", authorship: "user", origin }]);
    await vault.commit("jon", [{ path: edited.path, content: edited.content, baseRevision: saved.manifest.files[first.path].revision }]);
    const after = await head(vault);
    expect(authors(after.blocks)).toEqual([["page", "import,human"]]);
    expect(after.blocks[0].lines[0].author).toMatchObject({ id: "import:web", label: "example.com" });
  });

  test("a change synced from a folder (plain Markdown) is Jon's, and lines it kept stay the agent's", async () => {
    const { vault } = setup();
    const actor = agentActor({ agentId: "tok1", agentName: "Muse" });
    const saved = await vault.commit("jon", [{ path: "Journal.md", content: "---\nmargin-chat-id: mcp-1\n---\nAgent line.", baseRevision: null }],
      { authorship: { wait: true, actor, source: "mcp", authorFor: () => actor } });
    await vault.commit("jon", [{ path: "Journal.md", content: "---\nmargin-chat-id: mcp-1\n---\nAgent line.\nTyped in Obsidian.",
      baseRevision: saved.manifest.files["Journal.md"].revision }]);
    expect(authors((await head(vault, "mcp-1")).blocks)).toEqual([["mcp-1-body", "agent,human"]]);
  });

  test("a renamed file continues its document's authorship", async () => {
    const { vault } = setup();
    const actor = agentActor({ agentId: "tok1", agentName: "Muse" });
    const saved = await vault.commit("jon", [{ path: "Old.md", content: "---\nmargin-chat-id: mcp-2\n---\nAgent line.", baseRevision: null }],
      { authorship: { wait: true, actor, source: "mcp", authorFor: () => actor } });
    await vault.commit("jon", [
      { path: "Old.md", content: null, baseRevision: saved.manifest.files["Old.md"].revision },
      { path: "New.md", content: "---\nmargin-chat-id: mcp-2\n---\nAgent line.", baseRevision: null },
    ]);
    expect(authors((await head(vault, "mcp-2")).blocks)).toEqual([["mcp-2-body", "agent"]]);
  });

  test("a save whose parent has no sidecar reads the parent's wrappers, and unknown stays protected", async () => {
    const { storage, vault } = setup();
    const first = documentFile([{ id: "m", content: "Touched by Jon somewhere.", authorship: "mixed" }, { id: "u", content: "Mine.", authorship: "user" }]);
    const saved = await vault.commit("jon", [{ path: first.path, content: first.content, baseRevision: null }]);
    for (const key of [...storage.objects.keys()]) if (key.includes("/provenance/")) storage.objects.delete(key);
    const next = documentFile([{ id: "m", content: "Touched by Jon somewhere.", authorship: "mixed" }, { id: "u", content: "Mine.\nMore.", authorship: "user" }]);
    await vault.commit("jon", [{ path: next.path, content: next.content, baseRevision: saved.manifest.files[first.path].revision }]);
    const after = await head(vault);
    expect(authors(after.blocks)).toEqual([["m", "unknown"], ["u", "human,human"]]);
    expect(after.blocks[0].lines[0].originRevisionId).toBe(`inferred:${saved.manifest.files[first.path].revision}`);
  });
});

describe("backfill", () => {
  test("infers from wrappers, is idempotent, and writes no content revision (fixture D)", async () => {
    const storage = memoryStorage();
    const vault = createVaultService({ storage });
    const legacy = documentFile([
      { id: "u", content: "Jon wrote this.", authorship: "user" },
      { id: "a", content: "Model wrote this.\nAnd this.", authorship: "ai" },
      { id: "m", content: "Edited somewhere.\nCan't tell where.", authorship: "mixed" },
    ]);
    await vault.commit("jon", [
      { path: legacy.path, content: legacy.content, baseRevision: null },
      { path: "Plain.md", content: "# Notes\n\nFrom Obsidian.", baseRevision: null },
      { path: "Attachments/x/metadata.json", content: "{}", baseRevision: null },
    ]);
    // As if saved before line authorship existed.
    for (const key of [...storage.objects.keys()]) if (key.includes("/provenance/")) storage.objects.delete(key);
    const before = await vault.revision("jon");
    const first = await vault.backfillAuthorship("jon");
    expect(first).toMatchObject({ documents: 2, created: 2, existing: 0, failed: 0,
      lines: { human: 1, ai: 2, unknown: 2 + 3, agent: 0, import: 0 } });
    expect(await vault.revision("jon")).toBe(before);
    const sidecar = await vault.provenance.current("jon", "doc");
    expect(authors(sidecar.blocks)).toEqual([["u", "human"], ["a", "ai,ai"], ["m", "unknown,unknown"]]);
    expect(sidecar).toMatchObject({ source: "backfill", parentRevisionId: null });
    expect(sidecar.blocks[1].lines[0].author).toEqual({ type: "ai", id: "ai:legacy", label: "AI" });
    const again = await vault.backfillAuthorship("jon");
    expect(again).toMatchObject({ documents: 2, created: 0, existing: 2 });
    expect(await vault.revision("jon")).toBe(before);
  });

  test("totals count every author type", () => {
    const blocks = inferBlocks({ documentId: "d", plain: false, blocks: [{ blockId: "b", wrapper: "user", lines: ["a", "b"], model: null }] } as any, "r", owner);
    expect(summarizeBlocks(blocks)).toMatchObject({ humanLines: 2, totalLines: 2 });
  });
});

describe("a write is not done until it is readable (§11)", () => {
  test("an MCP write whose projection hasn't landed says so instead of implying it can be read", async () => {
    const storage = memoryStorage();
    const real = createVaultService({ storage });
    const calls: any[] = [];
    const vault = { ...real, async commit(userId: string, changes: any[], options: any) {
      calls.push(options);
      return { ...(await real.commit(userId, changes, options)), projection: { status: "pending", revision: 1 } };
    } };
    const tools = createWriteTools({ userId: "jon", vault, agentName: "Muse", agentId: "tok1", quotaBytes: undefined });
    const created = await tools.run("create_document", { title: "Journal", content: "Day one." });
    expect(created).toMatchObject({ ok: true, projection: "pending" });
    expect(created.revision_id).toMatch(/^[a-f0-9]{64}$/u);
    expect(calls[0].authorship).toMatchObject({ wait: true, source: "mcp", actor: { type: "agent", id: "mcp:tok1", label: "Muse" } });
  });
});
