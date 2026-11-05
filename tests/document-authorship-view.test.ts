import { describe, expect, test } from "bun:test";
import { createMarkdownWorkspace } from "@margin-chat/workspace-contracts";
import { createEmptyState } from "../client/src/initialState";
import { createVaultService } from "../server/vault/index.mjs";
import { digest } from "../server/vault/storage.mjs";
import { sha256 } from "../server/vault/provenance/lines.mjs";
import { documentAuthorshipView } from "../server/vault/provenance/appView.mjs";
import { agentActor } from "../server/mcp/writeTools.mjs";
import {
  describeAge, describeSummary, lineHash, matchAuthorship, readAuthorshipView, YOU, type AuthorshipView,
} from "../client/src/lib/documentAuthorship";

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
type Block = { id: string; content: string; authorship?: "ai" | "user" | "mixed"; generationId?: string };

function documentFile(blocks: Block[], generations: unknown[] = [], prompts: unknown[] = []) {
  const state = createEmptyState();
  const conversation = state.conversations[state.rootId];
  Object.assign(conversation, { id: "doc", title: "Doc", createdAt: at, updatedAt: at, childIds: [] });
  conversation.document = { schemaVersion: 1, prompts, generations,
    blocks: blocks.map((block) => ({ kind: "markdown", createdAt: at, updatedAt: at, ...block })) } as any;
  state.conversations = { doc: conversation };
  const [[path, content]] = Object.entries(createMarkdownWorkspace(state, at).files as Record<string, string>);
  return { path, content };
}

const prompts = [{ id: "p1", content: "Write", createdAt: at, serviceId: "anthropic-api", modelId: "claude-x" }];
const generations = [{ id: "g1", promptId: "p1", messageId: "m1", createdAt: at, serviceId: "anthropic-api", modelId: "claude-x", status: "complete", blockIds: ["a1"] }];

async function hashes(blocks: Array<{ content: string }>) {
  const texts = new Set(blocks.flatMap((block) => block.content.split("\n")));
  return new Map(await Promise.all([...texts].map(async (text) => [text, await lineHash(text)] as const)));
}

describe("authorship for the app (§9)", () => {
  test("the server sends each line's short hash, author and origin, and who last edited", async () => {
    const vault = createVaultService({ storage: memoryStorage() });
    const first = documentFile([
      { id: "a1", content: "AI kept.\nAI line Jon will edit.", authorship: "ai", generationId: "g1" },
      { id: "u1", content: "Mine.", authorship: "user" },
    ], generations, prompts);
    const saved = await vault.commit("jon", [{ path: first.path, content: first.content, baseRevision: null }]);
    const edited = documentFile([
      { id: "a1", content: "AI kept.\nJon's own version.", authorship: "mixed", generationId: "g1" },
      { id: "u1", content: "Mine.", authorship: "user" },
    ], generations, prompts);
    await vault.commit("jon", [{ path: edited.path, content: edited.content, baseRevision: saved.manifest.files[first.path].revision }]);

    const view = readAuthorshipView(JSON.parse(JSON.stringify(await documentAuthorshipView({ provenance: vault.provenance, userId: "jon", documentId: "doc" }))))!;
    expect(view.tracked).toBe(true);
    expect(view.lastEditedBy).toEqual({ type: "human", label: "You" });
    const a1 = view.blocks.find((block) => block.id === "a1")!;
    expect(a1.lines.map(([hash]) => hash)).toEqual([sha256("AI kept.").slice(0, 16), sha256("Jon's own version.").slice(0, 16)]);
    expect(a1.lines.map(([, author]) => view.authors[author])).toEqual([{ type: "ai", label: "claude-x" }, { type: "human", label: "You" }]);
    // The kept line dates from the first save, the edited one from the second.
    expect(a1.lines.map(([, , origin]) => origin >= 0)).toEqual([true, true]);
    expect(view.origins[a1.lines[0][2]].at).not.toBeNull();

    expect(await documentAuthorshipView({ provenance: vault.provenance, userId: "jon", documentId: "nope" })).toEqual({ documentId: "nope", tracked: false });
    expect(await documentAuthorshipView({ provenance: null, userId: "jon", documentId: "doc" })).toEqual({ documentId: "doc", tracked: false });
  });

  test("the last editor skips the backfill and names the app that wrote last", async () => {
    const vault = createVaultService({ storage: memoryStorage() });
    const actor = agentActor({ agentId: "tok1", agentName: "Muse" });
    await vault.commit("jon", [{ path: "Journal.md", content: "---\nmargin-chat-id: mcp-1\ntitle: Journal\n---\nDay one.", baseRevision: null }],
      { authorship: { wait: true, actor, source: "mcp", authorFor: () => actor } });
    const view = await documentAuthorshipView({ provenance: vault.provenance, userId: "jon", documentId: "mcp-1" }) as any;
    expect(view.lastEditedBy).toEqual({ type: "agent", label: "Muse" });
    expect(describeSummary({ totalLines: 1, mineLines: 0, unknownLines: 0, lastEditedBy: view.lastEditedBy })).toBe("0% written by you · 1 line · last edited by Muse");
  });
});

describe("matching recorded authorship to the lines on screen", () => {
  const view: AuthorshipView = {
    documentId: "doc", tracked: true, lastEditedBy: { type: "agent", label: "Muse" },
    authors: [{ type: "human", label: "You" }, { type: "ai", label: "claude-x" }, { type: "agent", label: "Muse" }, { type: "unknown", label: "Unknown" }],
    origins: [{ at: "2026-11-01T10:00:00.000Z", source: "editor" }, { at: "2026-11-02T10:00:00.000Z", source: "backfill" }],
    blocks: [],
  };
  const block = (id: string, content: string, authorship: "ai" | "user" | "mixed" = "user") => ({ id, kind: "markdown" as const, content, createdAt: at, updatedAt: at, authorship });

  test("saved lines keep their authors, moved lines keep theirs, and new lines are whoever is writing", async () => {
    const saved = [block("a", "AI one.\nAI two.", "ai"), block("b", "Mine.\n\nAgent line.")];
    const hashed = await hashes(saved);
    const recorded = { ...view, blocks: [
      { id: "a", lines: [[hashed.get("AI one.")!, 1, 0], [hashed.get("AI two.")!, 1, 0]] as Array<[string, number, number]> },
      { id: "b", lines: [[hashed.get("Mine.")!, 0, 0], [hashed.get("")!, 0, 0], [hashed.get("Agent line.")!, 2, -1]] as Array<[string, number, number]> },
    ] };
    // Unsaved: Jon typed a line in his block, AI two. moved into it, and a new AI line streams into block a.
    const now = [block("a", "AI one.\nAI streaming.", "ai"), block("b", "Mine.\nAI two.\nTyped.\n\nAgent line.")];
    const result = matchAuthorship(now, recorded, await hashes(now), (item) => item.authorship === "ai" ? { type: "ai", label: "claude-x" } : YOU);
    expect(result.runs.a.map((run) => [run.author.label, run.lines])).toEqual([["claude-x", 2]]);
    expect(result.runs.b.map((run) => [run.author.label, run.lines, now[1].content.slice(run.from, run.to)])).toEqual([
      ["You", 1, "Mine."], ["claude-x", 1, "AI two."], ["You", 1, "Typed.\n"], ["Muse", 1, "Agent line."],
    ]);
    expect(result.runs.b[1].origin).toEqual(view.origins[0]);
    expect(result.runs.b[2].origin).toBeNull();
    expect(result.summary).toMatchObject({ totalLines: 6, mineLines: 2, unknownLines: 0 });
    expect(describeSummary(result.summary)).toBe("33% written by you · 6 lines · last edited by Muse");
  });

  test("repeated lines are matched in their own block first, and unknown lines are counted", async () => {
    const saved = [block("a", "Same.\nSame."), block("b", "Same.")];
    const hashed = await hashes(saved);
    const recorded = { ...view, blocks: [
      { id: "a", lines: [[hashed.get("Same.")!, 3, 1], [hashed.get("Same.")!, 3, 1]] as Array<[string, number, number]> },
      { id: "b", lines: [[hashed.get("Same.")!, 2, 0]] as Array<[string, number, number]> },
    ] };
    const result = matchAuthorship(saved, recorded, hashed, () => YOU);
    expect(result.runs.a.map((run) => run.author.type)).toEqual(["unknown"]);
    expect(result.runs.b.map((run) => run.author.type)).toEqual(["agent"]);
    expect(result.summary.unknownLines).toBe(2);
    expect(describeSummary(result.summary)).toBe("0% written by you · 3 lines · 2 by unknown · last edited by Muse");
  });

  test("a document with no recorded authorship reads every line as whoever writes it now", () => {
    const result = matchAuthorship([block("a", "One.\nTwo.")], { ...view, tracked: false, lastEditedBy: null }, new Map(), () => YOU);
    expect(result.summary).toMatchObject({ totalLines: 2, mineLines: 2 });
    expect(describeSummary(result.summary)).toBe("100% written by you · 2 lines");
  });

  test("ages are short, and lines from before tracking say so", () => {
    const now = Date.parse("2026-11-05T10:00:00.000Z");
    expect(describeAge({ at: "2026-11-05T09:58:00.000Z", source: "editor" }, now)).toBe("2m");
    expect(describeAge({ at: "2026-11-04T10:00:00.000Z", source: "mcp" }, now)).toBe("1d");
    expect(describeAge({ at: "2026-11-05T09:00:00.000Z", source: "backfill" }, now)).toBe("earlier");
    expect(describeAge(null, now)).toBe("");
  });

  test("a malformed answer is refused rather than half-read", () => {
    expect(readAuthorshipView(null)).toBeNull();
    expect(readAuthorshipView({ documentId: "doc", tracked: true, authors: [], origins: [], blocks: [{ id: "a", lines: [["x", 5, -1]] }] })!.blocks).toEqual([]);
  });
});
