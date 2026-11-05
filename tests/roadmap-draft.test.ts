import { describe, expect, test } from "bun:test";
import { normalizeAIExecution } from "@margin-chat/workspace-contracts";
import { createProposalTools, describeProposalStep } from "../server/chat/agent/proposalTools.mjs";
import { createEmptyState, createStandaloneNoteConversation } from "../client/src/initialState";
import { applyRoadmapDraft, buildRoadmapGraph, getRoadmap, roadmapDraftIds } from "../client/src/lib/roadmap";
import type { AgentRoadmapProposal, AppState } from "../client/src/types";

const at = "2026-11-05T12:00:00.000Z";
const reachable = new Set(["cells", "dna", "aging", "senolytics"]);
const tools = () => createProposalTools({
  chatRequest: { ai: { mode: "balanced" }, conversation: { id: "roadmap", ancestorContext: [] }, messages: [{ role: "user", content: "Draft a roadmap" }] },
  snapshots: new Map(), reachable: (id: string) => reachable.has(id),
});
const step = (key: string, document_id: string, needs: string[] = [], title = "") => ({ key, document_id, title, why: `About ${key}`, needs });
const draft = (stages: unknown) => ({ roadmap_id: "", goal: "Biology of aging", summary: "Start with cells, end with drugs.", stages });

describe("propose_roadmap", () => {
  test("records stages and steps that cite reachable documents", () => {
    const run = tools();
    const result = run.run("propose_roadmap", draft([
      { title: "Foundations", steps: [step("cells", "cells"), step("dna", "dna")] },
      { title: "Aging", steps: [step("aging", "aging", ["cells", "dna"], "Hallmarks")] },
    ]));
    expect(result.ok).toBe(true);
    const [proposal] = run.list();
    expect(proposal).toEqual({ id: "proposal-1", kind: "roadmap", roadmapId: "roadmap", roadmapTitle: "", goal: "Biology of aging", summary: "Start with cells, end with drugs.",
      stages: [
        { title: "Foundations", steps: [{ key: "cells", documentId: "cells", why: "About cells", needs: [] }, { key: "dna", documentId: "dna", why: "About dna", needs: [] }] },
        { title: "Aging", steps: [{ key: "aging", documentId: "aging", title: "Hallmarks", why: "About aging", needs: ["cells", "dna"] }] },
      ] });
    // Saved execution records keep the proposal as it was made.
    const execution = normalizeAIExecution({ schemaVersion: 1, model: "m", provider: "meta-api", agent: { steps: [], stopReason: "answered", proposals: [proposal] } });
    expect(execution?.agent?.proposals).toEqual([proposal]);
    expect(describeProposalStep("propose_roadmap", draft([{ title: "A", steps: [step("a", "cells"), step("b", "dna")] }]), result).label).toBe("Proposed a roadmap for “Biology of aging”");
  });

  test("refuses unreachable citations, unknown or looping needs, and duplicate keys", () => {
    const error = (stages: unknown) => (tools().run("propose_roadmap", draft(stages)) as { error?: string }).error;
    expect(error([{ title: "A", steps: [step("x", "invented-doc")] }])).toContain("doesn't point at a document you can reach");
    expect(error([{ title: "A", steps: [step("x", "roadmap")] }])).toContain("other than the roadmap itself");
    expect(error([{ title: "A", steps: [step("x", "cells", ["nope"])] }])).toContain("isn't another step's key");
    expect(error([{ title: "A", steps: [step("x", "cells"), step("x", "dna")] }])).toContain("used twice");
    expect(error([{ title: "A", steps: [step("x", "cells", ["y"]), step("y", "dna", ["x"])] }])).toContain("loop back");
    expect(error([{ title: "Empty", steps: [] }])).toContain("has no steps");
  });
});

function vault(): AppState {
  const state = createEmptyState();
  for (const id of ["roadmap", "cells", "dna", "aging"]) {
    const note = createStandaloneNoteConversation({ createdAt: at, id, noteId: `${id}-note` });
    note.title = id[0].toUpperCase() + id.slice(1);
    state.conversations[id] = note;
  }
  return state;
}

const proposal: AgentRoadmapProposal = {
  id: "proposal-1", kind: "roadmap", roadmapId: "roadmap", roadmapTitle: "Roadmap", goal: "Biology of aging", summary: "",
  stages: [
    { title: "Foundations", steps: [{ key: "cells", documentId: "cells", needs: [] }, { key: "dna", documentId: "dna", needs: [] }] },
    { title: "Aging", steps: [{ key: "aging", documentId: "aging", title: "Hallmarks", needs: ["cells", "dna"] },
      { key: "drugs", documentId: "senolytics", needs: ["aging"] }, { key: "gone", documentId: "deleted", needs: [] }] },
  ],
};

describe("approving a roadmap draft", () => {
  test("turns the document into a roadmap with the draft's stages, steps and prerequisites", () => {
    const ids = roadmapDraftIds(proposal);
    const result = applyRoadmapDraft(vault(), proposal, ids, { updatedAt: at, known: (id) => id === "senolytics" })!;
    expect(result.added).toBe(4);
    expect(result.skipped).toBe(1);
    const roadmapDoc = result.state.conversations.roadmap;
    expect(roadmapDoc.nodeType).toBe("roadmap");
    const roadmap = getRoadmap(roadmapDoc);
    // The empty starting stage is replaced by the draft's stages.
    expect(roadmap.stages.map((stage) => stage.title)).toEqual(["Foundations", "Aging"]);
    expect(roadmap.nodes.map((node) => [node.target.docId, node.title ?? null])).toEqual([["cells", null], ["dna", null], ["aging", "Hallmarks"], ["senolytics", null]]);
    // Between documents on this device, prerequisites are depends-on relations; a cloud-only target is kept on the roadmap.
    expect(result.state.conversations.aging.relations?.map((relation) => relation.targetConversationId)).toEqual(["cells", "dna"]);
    expect(roadmap.nodes.find((node) => node.target.docId === "senolytics")!.dependsOn).toEqual([ids.nodes.aging]);
    const graph = buildRoadmapGraph(roadmap, result.state.conversations);
    expect([...graph.nextUp].sort()).toEqual([ids.nodes.cells, ids.nodes.dna].sort());
    // The same IDs give the same roadmap when the update runs again.
    expect(applyRoadmapDraft(vault(), proposal, ids, { updatedAt: at, known: (id) => id === "senolytics" })!.state.conversations.roadmap.roadmap).toEqual(roadmapDoc.roadmap);
  });

  test("adds after an existing roadmap's stages and reports when nothing it cites exists", () => {
    let state = vault();
    state = applyRoadmapDraft(state, proposal, roadmapDraftIds(proposal), { updatedAt: at })!.state;
    const again = applyRoadmapDraft(state, { ...proposal, stages: [{ title: "Review", steps: [{ key: "r", documentId: "cells", needs: [] }] }] },
      { stages: ["stage-review"], nodes: { r: "node-review" } }, { updatedAt: at })!;
    expect(getRoadmap(again.state.conversations.roadmap).stages.map((stage) => stage.title)).toEqual(["Foundations", "Aging", "Review"]);
    expect(applyRoadmapDraft(state, { ...proposal, stages: [{ title: "X", steps: [{ key: "x", documentId: "nowhere", needs: [] }] }] },
      { stages: ["s"], nodes: { x: "n" } }, { updatedAt: at })!.added).toBe(0);
  });
});
