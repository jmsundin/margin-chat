import { describe, expect, test } from "bun:test";
import * as browser from "@margin-chat/workspace-contracts/browser";
import * as server from "@margin-chat/workspace-contracts/server";
import { normalizeRoadmap, readFrontmatterValues, decodeReadableMarkdown } from "@margin-chat/workspace-contracts";
import { createEmptyState, createStandaloneNoteConversation } from "../client/src/initialState";
import { mergeVaultFile } from "../client/src/lib/vaultMerge";
import { createMarkdownWorkspace, discoverMarkdownWorkspace, parseMarkdownWorkspace } from "../client/src/lib/workspaceMarkdown";
import { hydratePersistedState as normalizeAppState } from "../client/src/lib/appState";
import { applyRoadmapChange, buildRoadmapGraph, getRoadmap, makeRoadmapDocument } from "../client/src/lib/roadmap";
import type { AppState, Roadmap } from "../client/src/types";

const at = "2026-11-04T12:00:00.000Z";

function vault(titles: string[]) {
  const state = createEmptyState();
  for (const title of ["Roadmap", ...titles]) {
    const id = title.toLowerCase().replace(/\s+/g, "-");
    const note = createStandaloneNoteConversation({ createdAt: at, id, noteId: `${id}-note` });
    note.title = title;
    state.conversations[id] = note;
  }
  return state;
}

const roadmapFixture = (): Roadmap => ({
  version: 1,
  stages: [{ id: "basics", title: "Basics" }, { id: "core", title: "Core" }, { id: "deep", title: "Going deeper" }],
  nodes: [
    { id: "n-cells", target: { docId: "cells" }, stage: "basics", order: 0, status: "done", proof: "Can explain mitosis" },
    { id: "n-dna", target: { docId: "dna" }, stage: "basics", order: 1 },
    { id: "n-aging", target: { docId: "aging" }, stage: "core", order: 0, status: "learning" },
    { id: "n-block", target: { docId: "aging", blockId: "block-1" }, title: "Telomeres", stage: "deep", order: 0, dependsOn: ["n-aging"] },
  ],
});

function roadmapState() {
  const state = vault(["Cells", "DNA", "Aging"]);
  state.conversations.roadmap = { ...makeRoadmapDocument(state.conversations.roadmap, at), roadmap: roadmapFixture() };
  state.conversations.aging = { ...state.conversations.aging, relations: [{ type: "depends-on", targetConversationId: "cells", origin: "user" }] };
  return state;
}

describe("roadmap registry", () => {
  test("normalizes the stored shape and drops malformed entries", () => {
    expect(normalizeRoadmap(null)).toBeUndefined();
    expect(normalizeRoadmap({ version: 2, stages: [], nodes: [] })).toBeUndefined();
    const roadmap = normalizeRoadmap({
      version: 1,
      stages: [{ id: "a", title: "  First\nstage " }, { id: "a", title: "Duplicate" }, { title: "No id" }],
      nodes: [
        { id: "x", target: { docId: "doc" }, stage: "a", order: 0, status: "not-started", dependsOn: ["x", "y", "missing"] },
        { id: "y", target: { docId: "doc2", blockId: "bad id!" }, stage: "a", order: 1, status: "bogus" },
        { id: "z", target: {}, stage: "a", order: 2 },
        { id: "x", target: { docId: "again" }, stage: "a", order: 3 },
      ],
    })!;
    expect(roadmap.stages).toEqual([{ id: "a", title: "First stage" }]);
    expect(roadmap.nodes).toEqual([
      { id: "x", target: { docId: "doc" }, stage: "a", order: 0, dependsOn: ["y"] },
      { id: "y", target: { docId: "doc2" }, stage: "a", order: 1 },
    ]);
  });

  test("survives Markdown, readable Markdown and workspace document round trips", () => {
    const state = roadmapState();
    const markdown = browser.createMarkdownWorkspace(state, at);
    const path = markdown.manifest.files.find((record) => record.id === "roadmap")!.path;
    expect(readFrontmatterValues(decodeReadableMarkdown(markdown.files[path])).type).toBe("roadmap");
    for (const parse of [browser.parseMarkdownWorkspace, server.parseMarkdownWorkspace]) {
      const restored = parse(markdown.manifest, markdown.files)!;
      expect(restored.conversations.roadmap.nodeType).toBe("roadmap");
      expect(restored.conversations.roadmap.roadmap).toEqual(roadmapFixture());
      // Reading and writing again changes no bytes.
      expect(browser.createMarkdownWorkspace(restored, at, markdown).files[path]).toBe(markdown.files[path]);
    }
    const document = browser.createWorkspaceDocument(state);
    expect(browser.createAppStateFromWorkspaceDocument(document)!.conversations.roadmap.roadmap).toEqual(roadmapFixture());
    expect(normalizeAppState(JSON.parse(JSON.stringify(state)))!.conversations.roadmap.roadmap).toEqual(roadmapFixture());
  });

  test("statuses changed on two devices merge without a conflict", () => {
    const state = roadmapState();
    const base = createMarkdownWorkspace(state, at);
    const path = base.manifest.files.find((record) => record.id === "roadmap")!.path;
    const edit = (nodeId: string, status: "done" | "skipped", updatedAt: string) => {
      const next = parseMarkdownWorkspace(base.manifest, base.files)!;
      const changed = applyRoadmapChange(next, "roadmap", { kind: "status", nodeId, status }, updatedAt).state;
      return createMarkdownWorkspace(changed, at, base).files[path];
    };
    const result = mergeVaultFile(path, { content: base.files[path] }, { content: edit("n-dna", "done", "2026-11-05T00:00:00.000Z") },
      { content: edit("n-aging", "skipped", "2026-11-06T00:00:00.000Z") });
    expect(result.conflicted).toBe(false);
    const workspace = discoverMarkdownWorkspace({ ...base.files, [path]: result.file!.content }, base.manifest);
    const merged = parseMarkdownWorkspace(workspace.manifest, workspace.files)!;
    const statuses = Object.fromEntries(getRoadmap(merged.conversations.roadmap).nodes.map((node) => [node.id, node.status ?? "not-started"]));
    expect(statuses).toEqual({ "n-cells": "done", "n-dna": "done", "n-aging": "skipped", "n-block": "not-started" });
  });
});

describe("roadmap graph", () => {
  test("layers by prerequisites, including depends-on between target documents", () => {
    const state = roadmapState();
    const graph = buildRoadmapGraph(getRoadmap(state.conversations.roadmap), state.conversations);
    expect(graph.edges).toEqual([
      { from: "n-aging", to: "n-cells", source: "relation" },
      { from: "n-block", to: "n-aging", source: "local" },
    ]);
    expect(graph.stages.map((stage) => stage.rows.map((row) => row.nodeIds))).toEqual([[["n-cells", "n-dna"]], [["n-aging"]], [["n-block"]]]);
    expect(graph.finished).toBe(1);
    expect([...graph.nextUp].sort()).toEqual(["n-aging", "n-dna"]);
    // The block no longer exists, so it is a tombstone and never next up.
    expect(graph.missing.has("n-block")).toBe(true);
  });

  test("finishing a prerequisite moves exactly its dependents into Next Up", () => {
    let state: AppState = roadmapState();
    state.conversations.aging.document = { blocks: [{ id: "block-1", kind: "markdown", content: "Telomeres shorten.", createdAt: at, updatedAt: at, authorship: "user" }] } as never;
    const nextUp = () => [...buildRoadmapGraph(getRoadmap(state.conversations.roadmap), state.conversations).nextUp].sort();
    expect(nextUp()).toEqual(["n-aging", "n-dna"]);
    state = applyRoadmapChange(state, "roadmap", { kind: "status", nodeId: "n-aging", status: "done" }, at).state;
    expect(nextUp()).toEqual(["n-block", "n-dna"]);
    state = applyRoadmapChange(state, "roadmap", { kind: "status", nodeId: "n-cells", status: "not-started" }, at).state;
    expect(nextUp()).toEqual(["n-block", "n-cells", "n-dna"]);
  });

  test("refuses a prerequisite that would make a loop and names it", () => {
    const state = roadmapState();
    const result = applyRoadmapChange(state, "roadmap", { kind: "add-prerequisite", nodeId: "n-cells", prerequisiteId: "n-block" }, at);
    expect(result.state).toBe(state);
    expect(result.error).toContain("“Cells” needs “Telomeres” needs “Aging” needs “Cells”");
  });

  test("a prerequisite between whole documents is written as depends-on, and removed the same way", () => {
    let state: AppState = roadmapState();
    state = applyRoadmapChange(state, "roadmap", { kind: "add-prerequisite", nodeId: "n-dna", prerequisiteId: "n-cells" }, at).state;
    expect(state.conversations.dna.relations).toEqual([{ type: "depends-on", targetConversationId: "cells", origin: "user", createdAt: at }]);
    expect(getRoadmap(state.conversations.roadmap).nodes.find((node) => node.id === "n-dna")!.dependsOn).toBeUndefined();
    state = applyRoadmapChange(state, "roadmap", { kind: "remove-prerequisite", nodeId: "n-dna", prerequisiteId: "n-cells" }, at).state;
    expect(state.conversations.dna.relations).toBeUndefined();
  });

  test("a loop in a hand-edited file still draws, ignoring the closing edge", () => {
    const state = roadmapState();
    state.conversations.cells = { ...state.conversations.cells, relations: [{ type: "depends-on", targetConversationId: "aging", origin: "user" }] };
    const graph = buildRoadmapGraph(getRoadmap(state.conversations.roadmap), state.conversations);
    expect(graph.cycleEdges).toHaveLength(1);
    expect(graph.stages.flatMap((stage) => stage.rows.flatMap((row) => row.nodeIds)).sort()).toEqual(["n-aging", "n-block", "n-cells", "n-dna"]);
  });

  test("edits keep stages and order deterministic", () => {
    let state: AppState = roadmapState();
    state = applyRoadmapChange(state, "roadmap", { kind: "move-node", nodeId: "n-dna", direction: -1 }, at).state;
    let graph = buildRoadmapGraph(getRoadmap(state.conversations.roadmap), state.conversations);
    expect(graph.stages[0].rows[0].nodeIds).toEqual(["n-dna", "n-cells"]);
    expect(applyRoadmapChange(state, "roadmap", { kind: "remove-stage", stageId: "basics" }, at).error).toBeTruthy();
    state = applyRoadmapChange(state, "roadmap", { kind: "remove-node", nodeId: "n-aging" }, at).state;
    graph = buildRoadmapGraph(getRoadmap(state.conversations.roadmap), state.conversations);
    expect(graph.roadmap.nodes.find((node) => node.id === "n-block")!.dependsOn).toBeUndefined();
    state = applyRoadmapChange(state, "roadmap", { kind: "add-node", stageId: "core", target: { docId: "dna" }, nodeId: "n-new" }, at).state;
    expect(getRoadmap(state.conversations.roadmap).nodes.at(-1)).toEqual({ id: "n-new", target: { docId: "dna" }, stage: "core", order: 0 });
  });
});
