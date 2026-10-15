import { describe, expect, test } from "bun:test";
import { describeHeldFiles, folderDeletionsToHold } from "../client/src/lib/folderDeletionGuard";

const note = (id: string) => ({
  content: `---\nmargin-chat-id: "${id}"\ntitle: "${id}"\nupdated: "2026-10-01T00:00:00.000Z"\n---\n# ${id}\n\nBody of ${id}.\n`,
  contentType: "text/markdown; charset=utf-8",
});
function vault(count: number, prefix = "") {
  return Object.fromEntries(Array.from({ length: count }, (_, index) => [`${prefix}note-${index}.md`, note(`note-${index}`)]));
}

describe("folder deletion guard", () => {
  test("an emptied folder is held", () => {
    const expected = vault(40);
    expect(folderDeletionsToHold({}, expected)).toHaveLength(40);
  });

  test("a few deletions by hand go through", () => {
    const expected = vault(40);
    const next = { ...expected };
    for (const path of ["note-1.md", "note-2.md", "note-3.md"]) delete next[path];
    expect(folderDeletionsToHold(next, expected)).toEqual([]);
  });

  test("more than ten deletions are held even in a large vault", () => {
    const expected = vault(200);
    const next = { ...expected };
    for (let index = 0; index < 11; index++) delete next[`note-${index}.md`];
    expect(folderDeletionsToHold(next, expected)).toHaveLength(11);
  });

  test("over a fifth of a small vault is held, but one or two files are not", () => {
    const expected = vault(10);
    const three = { ...expected };
    for (const path of ["note-0.md", "note-1.md", "note-2.md"]) delete three[path];
    expect(folderDeletionsToHold(three, expected)).toEqual(["note-0.md", "note-1.md", "note-2.md"]);
    const two = { ...expected };
    for (const path of ["note-0.md", "note-1.md"]) delete two[path];
    expect(folderDeletionsToHold(two, expected)).toEqual([]);
  });

  test("moving notes into a subfolder is not a deletion", () => {
    const expected = vault(30);
    expect(folderDeletionsToHold(vault(30, "Archive/"), expected)).toEqual([]);
  });

  test("moved images are matched by their bytes", () => {
    const images = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`photo-${index}.png`,
      { content: btoa(`image ${index}`), encoding: "base64" as const, contentType: "image/png" }]));
    const moved = Object.fromEntries(Object.entries(images).map(([path, file]) => [`Photos/${path}`, file]));
    expect(folderDeletionsToHold(moved, images)).toEqual([]);
    expect(folderDeletionsToHold({}, images)).toHaveLength(12);
  });

  test("the settings file never counts", () => {
    const expected = { ...vault(2), "workspace.json": { content: "{}", contentType: "application/json" } };
    expect(folderDeletionsToHold({}, expected)).toEqual([]);
  });

  test("names a few of the missing files", () => {
    expect(describeHeldFiles(["Trips/Japan.md", "Budget.md"])).toBe("Japan and Budget");
    expect(describeHeldFiles(["a.md", "b.md", "c.md", "d.md", "e.md"])).toBe("a, b, c and 2 more");
  });
});
