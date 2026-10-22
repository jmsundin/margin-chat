import { describe, expect, test } from "bun:test";
import { findMermaidFences, getMermaidConfig, isMermaidDiagramPassage, mermaidDiagramReply, replaceMermaidFence } from "../client/src/lib/mermaidDiagrams";

describe("Mermaid fences", () => {
  const markdown = "Intro\n```mermaid\nflowchart TD\n  A --> B\n```\ntext\n~~~~ Mermaid\nsequenceDiagram\n~~~~";

  test("finds each fence's diagram source", () => {
    expect(findMermaidFences(markdown).map((fence) => fence.source)).toEqual(["flowchart TD\n  A --> B", "sequenceDiagram"]);
    expect(findMermaidFences("```js\nconst a = 1;\n```")).toEqual([]);
  });

  test("swaps one diagram and keeps the fence lines and the text around it", () => {
    const [first, second] = findMermaidFences(markdown);
    expect(replaceMermaidFence(markdown, first, "flowchart LR\n  A --> C\n")).toBe("Intro\n```mermaid\nflowchart LR\n  A --> C\n```\ntext\n~~~~ Mermaid\nsequenceDiagram\n~~~~");
    expect(replaceMermaidFence(markdown, second, "pie")).toBe("Intro\n```mermaid\nflowchart TD\n  A --> B\n```\ntext\n~~~~ Mermaid\npie\n~~~~");
  });

  test("a fence an AI answer hasn't closed yet runs to the end", () => {
    const open = "```mermaid\nflowchart TD";
    const [fence] = findMermaidFences(open);
    expect(fence.source).toBe("flowchart TD");
    expect(replaceMermaidFence(open, fence, "flowchart LR")).toBe("```mermaid\nflowchart LR");
  });

  test("a shorter fence inside a longer one doesn't close it", () => {
    const nested = "````mermaid\nflowchart TD\n```\n  A --> B\n````";
    expect(findMermaidFences(nested)[0].source).toBe("flowchart TD\n```\n  A --> B");
  });

  test("knows the whole fence, fence lines included", () => {
    const [first] = findMermaidFences(markdown);
    expect(markdown.slice(first.start, first.end)).toBe("```mermaid\nflowchart TD\n  A --> B\n```");
  });

  test("a passage is a diagram only when it is exactly one Mermaid fence", () => {
    expect(isMermaidDiagramPassage("```mermaid\nflowchart TD\n  A --> B\n```")).toBe(true);
    expect(isMermaidDiagramPassage("\n```mermaid\npie\n```\n")).toBe(true);
    expect(isMermaidDiagramPassage("Intro\n```mermaid\npie\n```")).toBe(false);
    expect(isMermaidDiagramPassage("```js\nx\n```")).toBe(false);
    expect(isMermaidDiagramPassage(undefined)).toBe(false);
  });

  test("an AI reply for a diagram keeps only the diagram", () => {
    const fence = "```mermaid\nflowchart TD\n  A --> B\n```";
    expect(mermaidDiagramReply(`Here you go:\n\n${fence}\n\nI added B.`)).toBe(fence);
    expect(mermaidDiagramReply("```\nflowchart TD\n  A --> B\n```")).toBe(fence);
    expect(mermaidDiagramReply("flowchart TD\n  A --> B\n")).toBe(fence);
  });
});


test("diagrams use the Clean look: the base theme in the app's colors, light and dark", () => {
  const light = getMermaidConfig("light"), dark = getMermaidConfig("dark");
  for (const [config, background] of [[light, "#ffffff"], [dark, "#171717"]] as const) {
    expect(config.theme).toBe("base");
    expect(config.themeVariables?.background).toBe(background);
    // Edge labels are drawn in the page color the frame uses.
    expect(config.themeVariables?.edgeLabelBackground).toBe(background);
    expect(config.themeCSS).toContain(".node rect { rx: 10px; ry: 10px; }");
    // Pie slices, mind map branches and chart series get the app palette, not shades of the node color.
    expect(config.themeVariables?.pie1).not.toBe(config.themeVariables?.pie2);
    expect(config.themeVariables?.cScale0).toBe(config.themeVariables?.pie1);
  }
  expect(light.darkMode).toBe(false);
  expect(dark.darkMode).toBe(true);
  expect(light.securityLevel).toBe("strict");
});
