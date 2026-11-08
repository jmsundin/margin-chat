import { describe, expect, test } from "bun:test";
import { parseStepGrid, renderStepGridFence, stepGridReply } from "../client/src/lib/stepGrid";
import { VISUALIZE_PASSAGE_PROMPT } from "../client/src/lib/documentAI";

const PATHS = {
  title: "How many ways to each cell?",
  rows: 3, cols: 3,
  steps: [
    { caption: "Edges have one way each.", set: [[0, 0, 1], [0, 1, 1], [0, 2, 1], [1, 0, 1], [2, 0, 1]] },
    { caption: "Above + left.", set: [[1, 1, 2]], focus: [[1, 1]], arrows: [{ from: [0, 1], to: [1, 1] }, { from: [1, 0], to: [1, 1] }] },
    { caption: "Last cell: 3 + 3 = 6.", set: [[1, 2, 3], [2, 1, 3], [2, 2, 6]], focus: [[2, 2]], arrows: [{ from: [1, 2], to: [2, 2] }, { from: [2, 1], to: [2, 2] }] },
  ],
};

describe("stepped grids", () => {
  test("values carry into later steps, and each step knows which cells it changed", () => {
    const grid = parseStepGrid(JSON.stringify(PATHS))!;
    expect(grid.rows).toBe(3);
    expect(grid.steps[0].values[1][1]).toBe("");
    expect(grid.steps[2].values).toEqual([["1", "1", "1"], ["1", "2", "3"], ["1", "3", "6"]]);
    expect(grid.steps[1].changed).toEqual([[1, 1]]);
    expect(grid.steps[2].arrows).toHaveLength(2);
  });

  test("a full grid per step works, and the size is read from it", () => {
    const grid = parseStepGrid({ steps: [{ caption: "a", grid: [[1, 2], [3, 4]] }, { caption: "b", grid: [[1, 2], [3, 9]] }] })!;
    expect([grid.rows, grid.cols]).toEqual([2, 2]);
    expect(grid.steps[1].changed).toEqual([[1, 1]]);
  });

  test("cells, arrows and sizes outside the grid are dropped or clamped", () => {
    const grid = parseStepGrid({ rows: 40, cols: 2, steps: [{ set: [[0, 5, "x"], [-1, 0, "y"], [1.5, 0, "z"], [0, 0, "ok"]], focus: [[9, 9]], arrows: [{ from: [0, 0], to: [0, 0] }, { from: [0, 0], to: [50, 1] }] }] })!;
    expect(grid.rows).toBe(12);
    expect(grid.steps[0].values[0]).toEqual(["ok", ""]);
    expect(grid.steps[0].focus).toEqual([]);
    expect(grid.steps[0].arrows).toEqual([]);
    expect(grid.steps[0].caption).toBe("Step 1");
  });

  test("anything that isn't a grid is null", () => {
    expect(parseStepGrid("not json")).toBeNull();
    expect(parseStepGrid({ rows: 2, cols: 2 })).toBeNull();
    expect(parseStepGrid({ rows: 0, cols: 2, steps: [{}] })).toBeNull();
    expect(parseStepGrid([1, 2])).toBeNull();
  });

  test("a Visualize reply becomes one tidy stepgrid fence that reads back the same", () => {
    const reply = stepGridReply(`Here you go:\n\`\`\`json\n${JSON.stringify(PATHS)}\n\`\`\`\nHope it helps.`)!;
    expect(reply.startsWith("```stepgrid\n")).toBe(true);
    expect(reply).not.toContain("Hope it helps");
    const again = parseStepGrid(reply.slice("```stepgrid\n".length, -"\n```".length));
    expect(again).toEqual(parseStepGrid(PATHS));
  });

  test("a Mermaid reply is not taken for a grid", () => {
    expect(stepGridReply("```mermaid\nflowchart TD\n  A{Is it?} --> B\n```")).toBeNull();
  });

  test("renders a stepper and one picture per step, escaping the AI's words", () => {
    const html = renderStepGridFence(JSON.stringify({ ...PATHS, title: "<img src=x onerror=alert(1)>" }));
    expect(html).toContain('class="stepgrid-block is-staged"');
    expect(html.match(/diagram-stage-view/g)).toHaveLength(3);
    expect(html).toContain("Step <span class=\"diagram-stage-number\">1</span>/3");
    expect(html).toContain("data-replay");
    expect(html).not.toContain("<img");
    expect(html).toContain("<svg");
  });

  test("a broken grid shows its source, and a half-streamed one says it is drawing", () => {
    expect(renderStepGridFence('{"rows": 2, "steps": []}')).toContain("couldn't be drawn");
    expect(renderStepGridFence('{"rows": 2, "ste')).toContain("Drawing the step grid");
  });

  test("Visualize offers the stepped grid and still the staged Mermaid diagram", () => {
    expect(VISUALIZE_PASSAGE_PROMPT).toContain("```stepgrid");
    expect(VISUALIZE_PASSAGE_PROMPT).toContain("```mermaid");
    expect(VISUALIZE_PASSAGE_PROMPT).toContain("%% stage:");
  });
});
