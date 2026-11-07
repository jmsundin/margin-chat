import { describe, expect, test } from "bun:test";
import { parseDiagramStages } from "../client/src/lib/mermaidDiagrams";
import { VISUALIZE_PASSAGE_PROMPT } from "../client/src/lib/documentAI";

const STAGED = [
  "flowchart LR",
  "%% stage: The drug",
  "  R[Rapamycin] --> M[mTOR blocked]",
  "%% stage 2: What it changes",
  "  M --> A[More autophagy]",
  "%% Stage:",
  "  A --> L[Longer life]",
].join("\n");

describe("staged diagrams", () => {
  test("each stage draws the header and every stage up to it, without the markers", () => {
    const stages = parseDiagramStages(STAGED)!;
    expect(stages.map((stage) => stage.title)).toEqual(["The drug", "What it changes", "Stage 3"]);
    expect(stages[0].source).toBe("flowchart LR\n  R[Rapamycin] --> M[mTOR blocked]");
    expect(stages[1].source).toBe("flowchart LR\n  R[Rapamycin] --> M[mTOR blocked]\n  M --> A[More autophagy]");
    expect(stages[2].source).not.toContain("%%");
    expect(stages[2].source.endsWith("A --> L[Longer life]")).toBe(true);
  });

  test("a diagram with fewer than two stage markers is an ordinary diagram", () => {
    expect(parseDiagramStages("flowchart LR\n  A --> B")).toBeNull();
    expect(parseDiagramStages("flowchart LR\n%% stage: Only\n  A --> B")).toBeNull();
    expect(parseDiagramStages("flowchart LR\n%% stages are explained below\n  A --> B\n%% stages again")).toBeNull();
  });

  test("Visualize asks for stage markers the parser reads", () => {
    expect(VISUALIZE_PASSAGE_PROMPT).toContain("%% stage:");
    expect(VISUALIZE_PASSAGE_PROMPT).toContain("```mermaid");
  });
});
