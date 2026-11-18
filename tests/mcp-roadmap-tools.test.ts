import { describe, expect, test } from "bun:test";
import { createMarkdownWorkspace, discoverMarkdownWorkspace, parseMarkdownWorkspace } from "@margin-chat/workspace-contracts/markdown";
import { createVaultService } from "../server/vault/index.mjs";
import { digest } from "../server/vault/storage.mjs";
import { createRoadmapTools, normalizeSourceUrl, roadmapIdForSource } from "../server/mcp/roadmapTools.mjs";
import { mcpToolsFor } from "../server/mcp/index.mjs";
import { createEmptyState } from "../client/src/initialState";
import { buildRoadmapGraph, getRoadmap } from "../client/src/lib/roadmap";

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

const at = "2026-11-18T03:00:00.000Z";
const doc = (id: string, content: string) => ({ schemaVersion: 1, blocks: [{ id, kind: "markdown", content, createdAt: at, updatedAt: at }], prompts: [], generations: [] });

/** An app vault: a Certifications document, and a roadmap the member made in the app with one step done and a linked doc. */
function appWorkspace() {
  const state = createEmptyState();
  const base = state.conversations[state.rootId];
  const make = (id: string, title: string, extra: object = {}) => ({ ...base, id, title, parentId: null, childIds: [], messages: [], notes: [], documents: [],
    createdAt: at, updatedAt: at, document: doc(`${id}-b`, `${title} text.`), ...extra });
  const conversations: Record<string, any> = {
    certs: make("certs", "Certifications"),
    python: make("python", "Python course", { childIds: ["basics"], nodeType: "roadmap", linkedConversationIds: ["certs"],
      roadmap: { version: 1, stages: [{ id: "s1", title: "Start" }], nodes: [{ id: "n1", target: { docId: "basics" }, stage: "s1", order: 0, status: "done" }] } }),
    basics: make("basics", "Python basics", { parentId: "python" }),
    journal: make("journal", "Journal"),
  };
  state.rootId = "certs";
  state.conversations = conversations;
  return createMarkdownWorkspace(state, at).files as Record<string, string>;
}

async function setup() {
  const vault = createVaultService({ storage: memoryStorage() });
  const files = appWorkspace();
  await vault.commit("jon", [...Object.entries(files).map(([path, content]) => ({ path, content, baseRevision: null })),
    { path: "Plain note.md", content: "---\nmargin-chat-id: plain\ntitle: Plain note\n---\nJust text.", baseRevision: null }]);
  let n = 0;
  const tools = createRoadmapTools({ userId: "jon", vault, agentName: "Claude in Chrome", agentId: "tok1",
    now: () => new Date(at), createId: () => `00000000-0000-4000-8000-${String(++n).padStart(12, "0")}` });
  /** The whole vault as the app reads it on sync. */
  async function appState() {
    const { entries } = await vault.index("jon");
    const read: Record<string, string> = {};
    for (const entry of entries) read[entry.path] = (await vault.readFile({ userId: "jon", path: entry.path })).bytes.toString("utf8");
    const workspace = discoverMarkdownWorkspace(read);
    const state = parseMarkdownWorkspace(workspace.manifest, workspace.files);
    expect(state).not.toBeNull();
    return { state: state!, files: read };
  }
  return { vault, tools, appState, original: files };
}

const COURSE = {
  title: "Claude Developer path",
  goal: "Prepare for the Claude developer certification.",
  source_url: "https://anthropic-partners.skilljar.com/path/claude-developer/#top",
  parent_document_id: "certs",
  stages: [
    { title: "Foundations", steps: [
      { title: "Intro to the Claude API", key: "api", notes: "Messages API, models, tokens.", source_url: "https://anthropic-partners.skilljar.com/claude-api" },
      { title: "Prompt engineering", key: "prompts" },
    ] },
    { title: "Building", steps: [
      { title: "Tool use", needs: ["api", "prompts"], notes: "Define tools with JSON schema." },
      { title: "MCP servers", optional: true, needs: ["nope"] },
    ] },
  ],
};

describe("roadmap tools for connected apps", () => {
  test("any token reads roadmaps; only a write token makes them", () => {
    const names = (scope: string) => mcpToolsFor(scope).map((tool: { name: string }) => tool.name);
    expect(names("read")).toContain("read_roadmap");
    expect(names("read")).not.toContain("create_roadmap");
    expect(names("write")).toEqual(expect.arrayContaining(["read_roadmap", "create_roadmap", "add_to_roadmap"]));
  });

  test("source links match however they are written", () => {
    expect(normalizeSourceUrl("HTTPS://Anthropic-Partners.skilljar.com/path/claude-developer/#x"))
      .toBe("https://anthropic-partners.skilljar.com/path/claude-developer");
    expect(normalizeSourceUrl("javascript:alert(1)")).toBeNull();
  });

  test("creates a roadmap the app opens: stages, step documents under it with notes and lesson links, prerequisites", async () => {
    const { tools, appState } = await setup();
    const made = await tools.run("create_roadmap", COURSE);
    expect(made).toMatchObject({ ok: true, title: "Claude Developer path", stages: 2, steps: 4, ignored_needs: ["nope"] });
    expect(made.document_id).toBe(roadmapIdForSource("https://anthropic-partners.skilljar.com/path/claude-developer"));

    const { state, files } = await appState();
    const roadmap = state.conversations[made.document_id];
    expect(roadmap.nodeType).toBe("roadmap");
    expect(roadmap.relations).toEqual([expect.objectContaining({ type: "part-of", targetConversationId: "certs" })]);
    expect(roadmap.document.blocks.map((block: any) => block.content).join("\n")).toContain(
      "Source: [Claude Developer path](https://anthropic-partners.skilljar.com/path/claude-developer)");
    const graph = buildRoadmapGraph(getRoadmap(roadmap), state.conversations);
    expect(graph.stages.map((stage: any) => [stage.title, stage.total])).toEqual([["Foundations", 2], ["Building", 2]]);
    const steps = roadmap.roadmap.nodes.map((node: any) => state.conversations[node.target.docId]);
    expect(steps.map((step: any) => [step.title, step.parentId])).toEqual([
      ["Intro to the Claude API", made.document_id], ["Prompt engineering", made.document_id],
      ["Tool use", made.document_id], ["MCP servers", made.document_id]]);
    expect(roadmap.childIds).toEqual(steps.map((step: any) => step.id));
    const first = steps[0].document.blocks.map((block: any) => block.content).join("\n");
    expect(first).toContain("Messages API, models, tokens.");
    expect(first).toContain("Source: [Intro to the Claude API](https://anthropic-partners.skilljar.com/claude-api)");
    expect(steps[0].document.blocks[0].authorship).toBe("ai");
    const [api, prompts, tool, mcp] = roadmap.roadmap.nodes;
    expect(tool.dependsOn).toEqual([api.id, prompts.id]);
    expect(mcp).toMatchObject({ optional: true });
    expect(mcp.dependsOn).toBeUndefined();
    // The member's own files are untouched.
    expect(Object.keys(files).filter((path) => path.startsWith("Certifications"))).toHaveLength(1);

    // The same page again (written differently) points at the roadmap instead of making a second one.
    const again = await tools.run("create_roadmap", { ...COURSE, source_url: "https://anthropic-partners.skilljar.com/path/claude-developer" });
    expect(again).toMatchObject({ ok: false, code: "ROADMAP_EXISTS", document_id: made.document_id });
  });

  test("reads a roadmap by id or source link, then adds to a stage and a new stage", async () => {
    const { tools, appState } = await setup();
    const made = await tools.run("create_roadmap", COURSE);
    const read = await tools.run("read_roadmap", { roadmap: COURSE.source_url });
    expect(read).toMatchObject({ ok: true, found: true });
    expect(read.roadmap.stages.map((stage: any) => [stage.title, stage.steps.map((step: any) => [step.title, step.status])])).toEqual([
      ["Foundations", [["Intro to the Claude API", "not-started"], ["Prompt engineering", "not-started"]]],
      ["Building", [["Tool use", "not-started"], ["MCP servers", "not-started"]]]]);
    const [api] = read.roadmap.stages[0].steps;
    expect(read.roadmap.stages[1].steps[0].needs).toContain(api.step_id);

    const added = await tools.run("add_to_roadmap", { document_id: made.document_id, stages: [
      { stage_id: read.roadmap.stages[0].stage_id, steps: [{ title: "Models and pricing", needs: [api.step_id] }] },
      { title: "Exam", steps: [{ title: "Practice exam", key: "x" }, { title: "Certification exam", needs: ["x"] }] },
    ] });
    expect(added).toMatchObject({ ok: true, added: 3 });
    const after = (await tools.run("read_roadmap", { roadmap: made.document_id })).roadmap;
    expect(after.stages.map((stage: any) => [stage.title, stage.steps.map((step: any) => step.title)])).toEqual([
      ["Foundations", ["Intro to the Claude API", "Prompt engineering", "Models and pricing"]],
      ["Building", ["Tool use", "MCP servers"]],
      ["Exam", ["Practice exam", "Certification exam"]]]);
    expect(after.stages[0].steps[2].needs).toEqual([api.step_id]);
    expect(after.stages[2].steps[1].needs).toEqual([after.stages[2].steps[0].step_id]);
    const { state } = await appState();
    expect(state.conversations[made.document_id].childIds).toHaveLength(7);
  });

  test("adds to a roadmap made in the app without losing its progress, links or other files", async () => {
    const { tools, appState, vault, original } = await setup();
    const before = await appState();
    const added = await tools.run("add_to_roadmap", { document_id: "python", stages: [{ stage_id: "s1", steps: [{ title: "Loops", needs: ["n1"] }] }] });
    expect(added).toMatchObject({ ok: true, added: 1 });
    const { state, files } = await appState();
    const python = state.conversations.python;
    expect(python.roadmap.nodes[0]).toMatchObject({ id: "n1", status: "done" });
    expect(python.roadmap.nodes[1]).toMatchObject({ stage: "s1", order: 1, dependsOn: ["n1"] });
    expect(python.linkedConversationIds).toEqual(["certs"]);
    expect(python.childIds).toEqual(["basics", python.roadmap.nodes[1].target.docId]);
    // Only the roadmap file changed, and one step file was added.
    const changed = Object.keys(files).filter((path) => before.files[path] !== files[path]);
    expect(changed).toHaveLength(2);
    for (const path of Object.keys(original)) if (!path.startsWith("Python course")) expect(files[path]).toBe(original[path]);
    expect((await tools.run("read_roadmap", { roadmap: "python" })).roadmap.stages[0].steps.map((step: any) => step.title))
      .toEqual(["Python basics", "Loops"]);
    expect(vault).toBeDefined();
  });

  test("refuses what isn't a roadmap or isn't there, and outlines it can't use", async () => {
    const { tools } = await setup();
    expect(await tools.run("read_roadmap", { roadmap: "certs" })).toMatchObject({ ok: false, found: false });
    expect(await tools.run("add_to_roadmap", { document_id: "plain", stages: [{ steps: [{ title: "x" }] }] })).toMatchObject({ ok: false });
    expect(await tools.run("add_to_roadmap", { document_id: "missing", stages: [{ steps: [{ title: "x" }] }] })).toMatchObject({ ok: false, error: "No roadmap has that id." });
    expect(await tools.run("add_to_roadmap", { document_id: "python", stages: [{ stage_id: "zzz", steps: [{ title: "x" }] }] }))
      .toMatchObject({ ok: false });
    expect(await tools.run("create_roadmap", { title: "Empty", stages: [{ title: "A", steps: [] }] })).toMatchObject({ ok: false, error: "Send at least one step." });
    expect(await tools.run("create_roadmap", { title: "Bad", stages: [{ title: "A", steps: [{ title: "a", key: "k" }, { title: "b", key: "k" }] }] }))
      .toMatchObject({ ok: false });
    expect(await tools.run("create_roadmap", { title: "Bad link", source_url: "ftp://x", stages: [{ title: "A", steps: [{ title: "a" }] }] }))
      .toMatchObject({ ok: false });
    expect(await tools.run("create_roadmap", { ...COURSE, parent_document_id: "missing" })).toMatchObject({ ok: false });
    // Without a source link each call makes its own roadmap.
    const one = await tools.run("create_roadmap", { title: "Notes", stages: [{ title: "A", steps: [{ title: "a" }] }] });
    const two = await tools.run("create_roadmap", { title: "Notes", stages: [{ title: "A", steps: [{ title: "a" }] }] });
    expect(one.ok && two.ok && one.document_id !== two.document_id && one.path !== two.path).toBe(true);
  });
});
