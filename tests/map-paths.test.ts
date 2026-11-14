import { describe, expect, test } from "bun:test";
import { createEmptyState, createStandaloneNoteConversation } from "../client/src/initialState";
import { applyRoadmapChange, getRoadmap } from "../client/src/lib/roadmap";
import { buildMapPath, createMapPath, listMapPaths, pathNameFromGoal, stepAround } from "../client/src/lib/mapPaths";

const at = "2026-11-14T12:00:00.000Z";

function vault(titles: string[]) {
  const state = createEmptyState();
  for (const title of titles) {
    const id = title.toLowerCase().replace(/\W+/g, "-");
    const note = createStandaloneNoteConversation({ createdAt: at, id, noteId: `${id}-note` });
    note.title = title;
    state.conversations[id] = note;
  }
  return state;
}

describe("paths on the Map", () => {
  test("a path made by clicking notes keeps their order and chains each step to the one before", () => {
    const state = vault(["Lipid panel", "ApoB", "Statins"]);
    state.activeConversationId = "apob";
    const next = createMapPath(state, { id: "path", noteId: "path-note", title: "Lower my ApoB", docIds: ["lipid-panel", "apob", "statins", "apob"], createdAt: at,
      stageId: "stage-a", nodeIds: ["n1", "n2", "n3", "n4"] });
    expect(next.activeConversationId).toBe("apob");
    expect(next.conversations.path.nodeType).toBe("roadmap");
    expect(getRoadmap(next.conversations.path).nodes.map((node) => node.target.docId)).toEqual(["lipid-panel", "apob", "statins"]);
    const path = buildMapPath(next.conversations.path, next.conversations);
    expect(path.name).toBe("Lower my ApoB");
    expect(path.steps.map((step) => [step.number, step.title])).toEqual([[1, "Lipid panel"], [2, "ApoB"], [3, "Statins"]]);
    expect(path.arrows).toEqual([{ from: "lipid-panel", to: "apob" }, { from: "apob", to: "statins" }]);
    expect(path.steps[1].needs).toEqual(["lipid-panel"]);
    expect(path.steps[1].unlocks).toEqual(["statins"]);
    expect(path.nextUpDocId).toBe("lipid-panel");
    // Replaying the same call gives the same path.
    expect(createMapPath(state, { id: "path", noteId: "path-note", title: "Lower my ApoB", docIds: ["lipid-panel", "apob", "statins"], createdAt: at, stageId: "stage-a", nodeIds: ["n1", "n2", "n3"] }).conversations.path.roadmap)
      .toEqual(next.conversations.path.roadmap);
  });

  test("progress, next up and stepping follow statuses", () => {
    let state = createMapPath(vault(["A", "B", "C"]), { id: "p", noteId: "pn", title: "Path", docIds: ["a", "b", "c"], createdAt: at, stageId: "s", nodeIds: ["na", "nb", "nc"] });
    state = applyRoadmapChange(state, "p", { kind: "status", nodeId: "na", status: "done" }, at).state;
    const path = buildMapPath(state.conversations.p, state.conversations);
    expect([path.finished, path.total, path.nextUpDocId]).toEqual([1, 3, "b"]);
    expect(stepAround(path, null, 1)).toBe("b");
    expect(stepAround(path, "b", 1)).toBe("c");
    expect(stepAround(path, "c", 1)).toBe("c");
    expect(stepAround(path, "a", -1)).toBe("a");
    expect(listMapPaths(state.conversations)).toEqual([{ id: "p", name: "Path", finished: 1, total: 3 }]);
  });

  test("a step whose note was deleted drops out of the path", () => {
    const state = createMapPath(vault(["A", "B"]), { id: "p", noteId: "pn", title: "Path", docIds: ["a", "b"], createdAt: at, stageId: "s", nodeIds: ["na", "nb"] });
    const { b: _gone, ...rest } = state.conversations;
    const path = buildMapPath(state.conversations.p, rest);
    expect(path.steps.map((step) => step.docId)).toEqual(["a"]);
    expect(path.arrows).toEqual([]);
  });

  test("a drafted path is named from its goal or link", () => {
    expect(pathNameFromGoal("  Get my sleep   in order ")).toBe("Get my sleep in order");
    expect(pathNameFromGoal("https://roadmap.sh/ai/roadmap/fastapi-development-s56nq")).toBe("Fastapi development");
    expect(pathNameFromGoal("https://roadmap.sh/python")).toBe("Python");
  });
});
