import { describe, expect, test } from "bun:test";
import { normalizeAIExecution } from "@margin-chat/workspace-contracts";
import { createProposalTools, describeProposalStep } from "../server/chat/agent/proposalTools.mjs";
import { buildAgentInstruction } from "../server/chat/systemPrompt.mjs";
import { createEmptyState, createStandaloneNoteConversation } from "../client/src/initialState";
import { buildDocumentAIMessage } from "../client/src/lib/documentAI";
import { applyRoadmapDraft, buildRoadmapGraph, getRoadmap, isRoadmapReviseRequest, roadmapDraftIds, roadmapOutline, roadmapRevisePrompt } from "../client/src/lib/roadmap";
import type { AgentRoadmapProposal, AppState, Message } from "../client/src/types";

const at = "2026-11-17T03:00:00.000Z";

/** A roadmap "Aging" with Foundations (cells, done; dna) and Aging (hallmarks needs cells + dna). */
function vault(): AppState {
  const state = createEmptyState();
  for (const id of ["roadmap", "cells", "dna", "hallmarks", "senolytics"]) {
    const note = createStandaloneNoteConversation({ createdAt: at, id, noteId: `${id}-note` });
    note.title = id[0].toUpperCase() + id.slice(1);
    state.conversations[id] = note;
  }
  state.conversations.roadmap = { ...state.conversations.roadmap, title: "Aging", nodeType: "roadmap", roadmap: { version: 1,
    stages: [{ id: "stage-a", title: "Foundations" }, { id: "stage-b", title: "Aging" }],
    nodes: [
      { id: "node-cells", target: { docId: "cells" }, stage: "stage-a", order: 0, status: "done", proof: "Read it twice" },
      { id: "node-dna", target: { docId: "dna" }, stage: "stage-a", order: 1 },
      { id: "node-hall", target: { docId: "hallmarks" }, stage: "stage-b", order: 0, dependsOn: ["node-cells", "node-dna"] },
    ] } };
  return state;
}

describe("the AI can read a roadmap", () => {
  test("a roadmap document's prompt lists its steps with their IDs, progress and needs", () => {
    const state = vault();
    const outline = roadmapOutline(state.conversations.roadmap, state.conversations)!;
    expect(outline.stages).toEqual([
      { title: "Foundations", steps: [
        { step_id: "node-cells", title: "Cells", document_id: "cells", status: "done", needs: [] },
        { step_id: "node-dna", title: "Dna", document_id: "dna", status: "not-started", needs: [] }] },
      { title: "Aging", steps: [{ step_id: "node-hall", title: "Hallmarks", document_id: "hallmarks", status: "not-started", needs: ["node-cells", "node-dna"] }] },
    ]);
    expect(roadmapOutline(state.conversations.cells, state.conversations)).toBeNull();
    const prompt: Message = { id: "m", role: "user", content: roadmapRevisePrompt("Add senolytics after hallmarks"), createdAt: at };
    const message = buildDocumentAIMessage(state.conversations.roadmap, prompt, undefined, { roadmap: outline });
    expect(message.content).toContain("\"roadmap\":{\"stages\":");
    expect(message.content).toContain("This document is a learning roadmap.");
    expect(isRoadmapReviseRequest(prompt.content)).toBe(true);
    expect(buildDocumentAIMessage(state.conversations.cells, prompt).content).not.toContain("\"roadmap\"");
  });

  test("the system prompt points roadmap changes at revise_roadmap", () => {
    const text = buildAgentInstruction({ ai: { mode: "balanced" }, conversation: { id: "roadmap", ancestorContext: [] }, messages: [] } as never, { proposals: true });
    expect(String(text)).toContain("use revise_roadmap, not propose_roadmap");
  });
});

function tools() {
  const state = vault();
  const prompt = buildDocumentAIMessage(state.conversations.roadmap, { id: "m", role: "user", content: roadmapRevisePrompt("Add senolytics"), createdAt: at },
    undefined, { roadmap: roadmapOutline(state.conversations.roadmap, state.conversations) });
  return createProposalTools({
    chatRequest: { ai: { mode: "balanced" }, conversation: { id: "roadmap", ancestorContext: [] }, messages: [{ role: "user", content: prompt.content }] },
    snapshots: new Map(), reachable: (id: string) => id === "senolytics",
  });
}
const kept = (step_id: string, needs: string[] = [], title = "") => ({ step_id, document_id: "", title, notes: null, why: "", needs });

describe("revise_roadmap", () => {
  test("records the whole changed roadmap, keeping existing steps by ID", () => {
    const run = tools();
    const result = run.run("revise_roadmap", { summary: "Added senolytics and a lesson on clocks; dropped DNA", stages: [
      { title: "Foundations", steps: [kept("node-cells", [], "Cells")] },
      { title: "Aging", steps: [kept("node-hall", ["node-cells"], "The hallmarks"),
        { step_id: "new-1", document_id: "senolytics", title: "", notes: null, why: "Drugs that clear old cells", needs: ["node-hall"] },
        { step_id: "new-2", document_id: "", title: "Epigenetic clocks", notes: "- Horvath clock", why: "", needs: ["node-hall", "missing"] }] },
    ] }) as { ok: boolean; note: string };
    expect(result.ok).toBe(true);
    expect(result.note).toContain("2 new steps, 1 taken off (\"Dna\")");
    const [proposal] = run.list();
    expect(proposal).toMatchObject({ kind: "roadmap", revise: true, roadmapId: "roadmap", roadmapTitle: "Aging" });
    // Sending back a step's current name is no rename.
    expect(proposal.stages[0].steps).toEqual([{ key: "node-cells", nodeId: "node-cells", documentId: "cells", needs: [] }]);
    expect(proposal.stages[1].steps[0]).toEqual({ key: "node-hall", nodeId: "node-hall", documentId: "hallmarks", title: "The hallmarks", needs: ["node-cells"] });
    expect(proposal.stages[1].steps[2]).toEqual({ key: "new-2", notes: "- Horvath clock", title: "Epigenetic clocks", needs: ["node-hall"] });
    const execution = normalizeAIExecution({ schemaVersion: 1, model: "m", provider: "meta-api", agent: { steps: [], stopReason: "answered", proposals: [proposal] } });
    expect(execution?.agent?.proposals).toEqual([proposal]);
    expect(describeProposalStep("revise_roadmap", { summary: "Added senolytics" }, result).label).toBe("Changed the roadmap");
  });

  test("refuses unknown step IDs, a step placed twice, loops, and documents that aren't roadmaps", () => {
    const error = (stages: unknown) => (tools().run("revise_roadmap", { summary: "", stages }) as { error?: string }).error;
    expect(error([{ title: "A", steps: [kept("node:made-up")] }])).toContain("isn't a step on this roadmap");
    expect(error([{ title: "A", steps: [kept("node-cells"), kept("node-cells")] }])).toContain("used twice");
    expect(error([{ title: "A", steps: [kept("node-cells", ["node-dna"]), kept("node-dna", ["node-cells"])] }])).toContain("loop back");
    expect(error([{ title: "A", steps: [] }])).toContain("no steps");
    const plain = createProposalTools({ chatRequest: { ai: { mode: "balanced" }, conversation: { id: "cells", ancestorContext: [] }, messages: [{ role: "user", content: "x" }] },
      snapshots: new Map() });
    expect((plain.run("revise_roadmap", { summary: "", stages: [{ title: "A", steps: [kept("node-cells")] }] }) as { error?: string }).error).toContain("isn't a roadmap");
  });
});

describe("applying a roadmap change", () => {
  const change: AgentRoadmapProposal = { id: "proposal-1", kind: "roadmap", revise: true, roadmapId: "roadmap", roadmapTitle: "Aging", goal: "Aging", summary: "",
    stages: [
      { title: "Aging", steps: [{ key: "node-hall", nodeId: "node-hall", documentId: "hallmarks", title: "The hallmarks", needs: ["node-cells"] },
        { key: "new-1", documentId: "senolytics", needs: ["node-hall"] }] },
      { title: "foundations", steps: [{ key: "node-cells", nodeId: "node-cells", documentId: "cells", needs: [] },
        { key: "new-2", notes: "- Horvath clock", title: "Epigenetic clocks", needs: ["node-cells"] }] },
    ] };

  test("moves, renames, adds and removes steps, keeping progress, stage IDs and setting needs", () => {
    const ids = roadmapDraftIds(change, (prefix) => `${prefix}-new`);
    const result = applyRoadmapDraft(vault(), change, ids, { updatedAt: at })! as ReturnType<typeof applyRoadmapDraft> & { removed: number };
    expect(result.added).toBe(2);
    expect(result.created).toBe(1);
    expect(result.removed).toBe(1);
    const roadmap = getRoadmap(result.state.conversations.roadmap);
    // Stages follow the change's order and keep their IDs when the names match.
    expect(roadmap.stages).toEqual([{ id: "stage-b", title: "Aging" }, { id: "stage-a", title: "foundations" }]);
    const cells = roadmap.nodes.find((node) => node.id === "node-cells")!;
    expect(cells).toMatchObject({ stage: "stage-a", status: "done", proof: "Read it twice" });
    expect(roadmap.nodes.some((node) => node.id === "node-dna")).toBe(false);
    // The removed step's document stays in the vault.
    expect(result.state.conversations.dna).toBeDefined();
    expect(roadmap.nodes.find((node) => node.id === "node-hall")!.title).toBe("The hallmarks");
    const graph = buildRoadmapGraph(roadmap, result.state.conversations);
    expect(graph.needs.get("node-hall")).toEqual(["node-cells"]);
    expect(graph.needs.get(ids.nodes["new-1"])).toEqual(["node-hall"]);
    const clock = roadmap.nodes.find((node) => node.id === ids.nodes["new-2"])!;
    expect(result.state.conversations[clock.target.docId].title).toBe("Epigenetic clocks");
    expect(graph.needs.get(clock.id)).toEqual(["node-cells"]);
  });

  test("is refused when the roadmap is gone or none of its steps are left", () => {
    expect(applyRoadmapDraft(vault(), { ...change, roadmapId: "cells" }, roadmapDraftIds(change), { updatedAt: at })).toBeNull();
    const nothing = { ...change, stages: [{ title: "A", steps: [{ key: "node-x", nodeId: "node-x", documentId: "gone", needs: [] }] }] };
    expect(applyRoadmapDraft(vault(), nothing, roadmapDraftIds(nothing), { updatedAt: at })).toBeNull();
  });
});
