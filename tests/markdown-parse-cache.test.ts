import { describe, expect, test } from "bun:test";
import { createMarkdownWorkspace, discoverMarkdownWorkspace, parseMarkdownWorkspace } from "../packages/workspace-contracts/markdown.mjs";
import { createEmptyState } from "../client/src/initialState";

function workspace() {
  const state = createEmptyState();
  const root = state.conversations[state.rootId];
  root.title = "Cached root";
  root.messages = [{ id: "m1", role: "user", createdAt: "2026-01-01T00:00:00.000Z", content: "First message" }];
  return createMarkdownWorkspace(state, "2026-01-01T00:00:00.000Z");
}

describe("Markdown parse cache", () => {
  test("repeated parses return equal, independent results", () => {
    const { manifest, files } = workspace();
    const first = parseMarkdownWorkspace(manifest, files)!;
    const second = parseMarkdownWorkspace(manifest, files)!;
    expect(second).toEqual(first);
    const id = Object.keys(first.conversations)[0];
    first.conversations[id].messages[0].content = "Changed by a caller";
    first.conversations[id].title = "Changed title";
    const third = parseMarkdownWorkspace(manifest, files)!;
    expect(third.conversations[id].messages[0].content).toBe("First message");
    expect(third.conversations[id].title).toBe("Cached root");
  });

  test("an edited file is parsed again", () => {
    const { manifest, files } = workspace();
    const path = Object.keys(files)[0];
    parseMarkdownWorkspace(manifest, files);
    const edited = { ...files, [path]: files[path].replace("First message", "Edited message") };
    const parsed = parseMarkdownWorkspace(manifest, edited)!;
    expect(Object.values(parsed.conversations)[0].messages[0].content).toBe("Edited message");
  });

  test("discovery still recognizes an exact rename among many files", () => {
    const files: Record<string, string> = {};
    for (let index = 0; index < 3000; index++) files[`Notes/${index}.md`] = `# Note ${index}\n\nBody ${index}.\n`;
    const before = discoverMarkdownWorkspace(files);
    const renamed = { ...files };
    renamed["Archive/renamed.md"] = renamed["Notes/7.md"];
    delete renamed["Notes/7.md"];
    const started = performance.now();
    const after = discoverMarkdownWorkspace(renamed, before.manifest, files);
    // Quadratic matching took seconds at this size.
    expect(performance.now() - started).toBeLessThan(1500);
    const id = before.manifest.files.find((record) => record.path === "Notes/7.md")!.id;
    expect(after.manifest.files.find((record) => record.path === "Archive/renamed.md")!.id).toBe(id);
  });
});
