import { describe, expect, test } from "bun:test";
import { normalizeRoadmap } from "@margin-chat/workspace-contracts";
import { createEmptyState, createStandaloneNoteConversation } from "../client/src/initialState";
import { applyRoadmapChange, getRoadmap } from "../client/src/lib/roadmap";
import { buildMapPath, createMapPath } from "../client/src/lib/mapPaths";
import { layoutCourse } from "../client/src/components/MapRoadmapCourse";

const at = "2026-11-15T01:00:00.000Z";

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

/** A path in two stages: three lessons, then two. */
function course() {
  let state = vault(["Python Basics", "Web Concepts", "Path Operations", "SQL Databases", "Docker"]);
  state = createMapPath(state, { id: "path", noteId: "path-note", title: "FastAPI", createdAt: at, stageId: "s1", stageTitle: "Start here",
    docIds: ["python-basics", "web-concepts", "path-operations"], nodeIds: ["n1", "n2", "n3"] });
  state = applyRoadmapChange(state, "path", { kind: "add-stage", title: "Ship it", stageId: "s2" }, at).state;
  state = applyRoadmapChange(state, "path", { kind: "add-node", stageId: "s2", target: { docId: "sql-databases" }, nodeId: "n4" }, at).state;
  state = applyRoadmapChange(state, "path", { kind: "add-node", stageId: "s2", target: { docId: "docker" }, nodeId: "n5" }, at).state;
  return state;
}

const overlaps = (a: { x: number; y: number; width: number; height: number }, b: typeof a) =>
  a.x < b.x + b.width && b.x < a.x + a.width && a.y < b.y + b.height && b.y < a.y + a.height;

describe("Learn: a roadmap as a course", () => {
  test("stages run down one spine in order, lessons sit beside their stage, and nothing overlaps", () => {
    const path = buildMapPath(course().conversations.path, course().conversations);
    for (const width of [900, 600, 360]) {
      const layout = layoutCourse(path, width);
      expect(layout.narrow).toBe(width < 560);
      expect(layout.stages.map((stage) => [stage.number, stage.title, stage.total])).toEqual([[1, "Start here", 3], [2, "Ship it", 2]]);
      expect(layout.stages[0].y).toBeLessThan(layout.stages[1].y);
      expect(layout.lessons).toHaveLength(5);
      const boxes = [...layout.stages, ...layout.lessons];
      boxes.forEach((a, index) => boxes.slice(index + 1).forEach((b) => expect(overlaps(a, b)).toBe(false)));
      for (const box of boxes) {
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(width);
        expect(box.y + box.height).toBeLessThanOrEqual(layout.height);
      }
      // Every lesson of the second stage comes after the first stage's lessons.
      const lastOfFirst = Math.max(...layout.lessons.filter((lesson) => lesson.stageId === "s1").map((lesson) => lesson.y));
      expect(Math.min(...layout.lessons.filter((lesson) => lesson.stageId === "s2").map((lesson) => lesson.y))).toBeGreaterThan(lastOfFirst);
      expect(layout.spine).toHaveLength(1);
    }
    const wide = layoutCourse(path, 900);
    // On a wide pane lessons alternate left and right of the spine.
    expect(wide.lessons.filter((lesson) => lesson.stageId === "s1").map((lesson) => lesson.side)).toEqual([-1, -1, 1]);
  });

  test("an optional lesson is kept on save, drawn as optional, and never marked next", () => {
    let state = course();
    state = applyRoadmapChange(state, "path", { kind: "optional", nodeId: "n1", optional: true }, at).state;
    expect(getRoadmap(state.conversations.path).nodes.find((node) => node.id === "n1")?.optional).toBe(true);
    expect(normalizeRoadmap(JSON.parse(JSON.stringify(state.conversations.path.roadmap)))?.nodes[0].optional).toBe(true);
    const path = buildMapPath(state.conversations.path, state.conversations);
    expect(path.steps[0].optional).toBe(true);
    expect(path.nextUpDocId).toBe("web-concepts");
    state = applyRoadmapChange(state, "path", { kind: "optional", nodeId: "n1", optional: false }, at).state;
    expect("optional" in getRoadmap(state.conversations.path).nodes[0]).toBe(false);
    expect(buildMapPath(state.conversations.path, state.conversations).nextUpDocId).toBe("python-basics");
  });

  test("when only optional lessons are left, the next one is still marked", () => {
    let state = course();
    for (const id of ["n1", "n2", "n3", "n4"]) state = applyRoadmapChange(state, "path", { kind: "status", nodeId: id, status: "done" }, at).state;
    state = applyRoadmapChange(state, "path", { kind: "optional", nodeId: "n5", optional: true }, at).state;
    expect(buildMapPath(state.conversations.path, state.conversations).nextUpDocId).toBe("docker");
  });
});
