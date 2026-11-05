import { describe, expect, test } from "bun:test";
import { createMarkdownWorkspace } from "@margin-chat/workspace-contracts";
import { createEmptyState } from "../client/src/initialState";
import { mergeVaultFile } from "../client/src/lib/vaultMerge";
import { createVaultService } from "../server/vault/index.mjs";
import { digest } from "../server/vault/storage.mjs";
import { sha256 } from "../server/vault/provenance/lines.mjs";
import { createAuthorshipTools } from "../server/mcp/authorshipTools.mjs";
import { agentActor } from "../server/mcp/writeTools.mjs";

/**
 * §8: the three-way merge works on content as it always has; the merged result
 * is saved as a new revision whose authorship comes from the forward pass, so
 * each surviving line keeps the author of the side it survived from.
 */

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
const muse = agentActor({ agentId: "t1", agentName: "Muse" });
type Block = { id: string; content: string; authorship?: "ai" | "user" | "mixed" };

/** Fixture C as the app saves it: an AI block, Jon's block, and an AI block with one line Jon edited. */
function fixtureC(blocks: Block[]) {
  const state = createEmptyState();
  const conversation = { ...structuredClone(state.conversations[state.rootId]), id: "C", title: "C", createdAt: at, updatedAt: at, childIds: [], parentId: null } as any;
  conversation.document = { schemaVersion: 1, prompts: [], generations: [], blocks: blocks.map((block) => ({ kind: "markdown", createdAt: at, updatedAt: at, ...block })) };
  state.conversations = { C: conversation };
  state.rootId = "C";
  const [[path, content]] = Object.entries(createMarkdownWorkspace(state, at).files as Record<string, string>);
  return { path, content };
}
const blocksC = (overrides: Record<string, string> = {}): Block[] => [
  { id: "ai1", content: overrides.ai1 ?? "AI intro.\nAI detail.", authorship: overrides.ai1 ? "mixed" : "ai" },
  { id: "mine", content: overrides.mine ?? "Jon one.\nJon two.\nJon three.", authorship: "user" },
  { id: "ai2", content: "AI kept.\nJon's version of this line.", authorship: "mixed" },
];

async function setup() {
  const vault = createVaultService({ storage: memoryStorage() });
  const first = fixtureC([...blocksC().slice(0, 2), { id: "ai2", content: "AI kept.\nAI line Jon will edit.", authorship: "ai" }]);
  const saved = await vault.commit("jon", [{ path: first.path, content: first.content, baseRevision: null }]);
  const base = fixtureC(blocksC());
  const edited = await vault.commit("jon", [{ path: base.path, content: base.content, baseRevision: saved.manifest.files[first.path].revision }]);
  const tools = createAuthorshipTools({ userId: "jon", vault, database: null, actor: muse });
  return { vault, tools, path: base.path, base: base.content, baseRevision: edited.manifest.files[base.path].revision as string };
}

/** Jon's device saved `local` against `base` while the agent's update landed: it merges and saves on top of the agent's revision. */
async function saveMerged(vault: any, path: string, base: string, local: string) {
  const remote = await vault.readFile({ userId: "jon", path });
  const merged = mergeVaultFile(path, { content: base }, { content: local }, { content: remote.bytes.toString("utf8") });
  await vault.commit("jon", [{ path, content: merged.file!.content, baseRevision: remote.revision }]);
  return merged;
}

const linesOf = (blame: any) => blame.blocks.map((block: any) => block.lines.map((line: any) => `${line.author.type}`).join(","));

describe("merging concurrent edits keeps each side's authors (§8, test 10)", () => {
  test("a human edit and an agent edit on different lines of fixture C both survive, each attributed", async () => {
    const { vault, tools, path, base, baseRevision } = await setup();
    const before = await tools.blame({ document_id: "C" });
    expect(linesOf(before)).toEqual(["ai,ai", "human,human,human", "ai,human"]);

    const update = await tools.update({ document_id: "C", base_revision_id: baseRevision, operations: [
      { op: "replace_lines", block_id: "ai1", start_line: 1, end_line: 1, expected_sha256: [sha256("AI detail.")], new_text: "Agent's sharper detail." },
      { op: "insert_lines", block_id: "mine", after_line: 2, new_text: "Agent note after Jon's lines." },
    ] });
    expect(update.ok).toBe(true);

    // Meanwhile, offline, Jon rewrote his second line.
    const local = fixtureC(blocksC({ mine: "Jon one.\nJon two, rethought.\nJon three." })).content;
    const merged = await saveMerged(vault, path, base, local);
    expect(merged.conflicted).toBe(false);

    const after = await tools.blame({ document_id: "C" });
    const read = await tools.readAuthorship("C");
    expect(read!.blocks.map((block: any) => block.lines.map((line: any) => line.text))).toEqual([
      ["AI intro.", "Agent's sharper detail."],
      ["Jon one.", "Jon two, rethought.", "Jon three.", "Agent note after Jon's lines."],
      ["AI kept.", "Jon's version of this line."],
    ]);
    expect(linesOf(after)).toEqual(["ai,agent", "human,human,human,agent", "ai,human"]);
    expect(after.blocks[0].lines[1].author).toEqual({ type: "agent", label: "Muse" });
    // Lines neither side touched keep where they came from.
    expect(after.blocks[1].lines[0].origin_revision_id).toBe(before.blocks[1].lines[0].origin_revision_id);
    expect(after.blocks[0].lines[0].origin_revision_id).toBe(before.blocks[0].lines[0].origin_revision_id);
  });

  test("when both sides changed the same line, its author is the side whose words survived, and Jon's whenever his did", async () => {
    const { vault, tools, path, base, baseRevision } = await setup();
    // The agent may edit AI text; Jon rewrote the same AI line at the same time.
    const update = await tools.update({ document_id: "C", base_revision_id: baseRevision, operations: [
      { op: "replace_lines", block_id: "ai1", start_line: 0, end_line: 0, expected_sha256: [sha256("AI intro.")], new_text: "An agent introduction." },
    ] });
    expect(update.ok).toBe(true);
    const local = fixtureC(blocksC({ ai1: "My own introduction.\nAI detail." })).content;
    await saveMerged(vault, path, base, local);

    const read = await tools.readAuthorship("C");
    const line = read!.blocks[0].lines[0];
    if (line.text === "An agent introduction.") expect(line.author.type).toBe("agent");
    else expect(line.author.type).toBe("human");
    // Whatever the merge chose, the untouched line beside it stays the model's.
    expect(read!.blocks[0].lines.at(-1)).toMatchObject({ text: "AI detail.", author: { type: "ai" } });
  });
});

describe("a parent still being recorded elsewhere", () => {
  test("the next save waits for its parent's authorship instead of marking lines unknown", async () => {
    const storage = memoryStorage();
    const vault = createVaultService({ storage });
    const first = fixtureC([...blocksC().slice(0, 2), { id: "ai2", content: "AI kept.\nAI line Jon will edit.", authorship: "ai" }]);
    const saved = await vault.commit("jon", [{ path: first.path, content: first.content, baseRevision: null }]);
    const headKey = [...storage.objects.keys()].find((key) => key.includes("/provenance/") && key.endsWith("/head.json"))!;
    const genesisHead = storage.objects.get(headKey)!;
    const second = fixtureC(blocksC());
    const edited = await vault.commit("jon", [{ path: second.path, content: second.content, baseRevision: saved.manifest.files[first.path].revision }]);
    const recorded = await vault.provenance.current("jon", "C");
    expect(recorded.revisionKey).toBe(`${edited.manifest.revision}-${edited.manifest.files[second.path].revision}`);

    // Pretend the second save's authorship is still being written by another server: its sidecar
    // isn't there yet and the head still names the first save. It lands a moment later.
    const sidecarKey = [...storage.objects.keys()].find((key) => key.endsWith(`/revisions/${recorded.revisionKey}.json`))!;
    const sidecarBytes = storage.objects.get(sidecarKey)!;
    storage.objects.delete(sidecarKey);
    storage.objects.set(headKey, genesisHead);
    setTimeout(() => storage.objects.set(sidecarKey, sidecarBytes), 200);

    const actor = agentActor({ agentId: "t1", agentName: "Muse" });
    const third = fixtureC([...blocksC().slice(0, 2), { id: "ai2", content: "AI kept.\nJon's version of this line.\nAgent addition.", authorship: "mixed" }]);
    await vault.commit("jon", [{ path: third.path, content: third.content, baseRevision: edited.manifest.files[second.path].revision }],
      { authorship: { wait: true, actor, source: "mcp", authorFor: () => actor } });
    const head = await vault.provenance.current("jon", "C");
    expect(head.parentRevisionKey).toBe(recorded.revisionKey);
    // Read from its wrappers instead, Jon's edited line in the mixed block would be unknown.
    expect(head.blocks.map((block: any) => block.lines.map((line: any) => line.author.type).join(","))).toEqual(["ai,ai", "human,human,human", "ai,human,agent"]);
  });
});
