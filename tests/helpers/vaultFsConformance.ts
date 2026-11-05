import { describe, expect, test } from "bun:test";
import { isVaultFsError, type VaultFs } from "@margin-chat/vault-sync";

/**
 * The behaviour every VaultFs adapter shares (packages/vault-sync/index.d.mts). `create` makes a folder holding
 * `files`, and `outside` (when given) edits it the way another app would.
 */
export function describeVaultFs(label: string, create: (files: Record<string, string | Uint8Array>) => Promise<{
  fs: VaultFs;
  outside?: { write(path: string, contents: string): Promise<void> | void; remove(path: string): Promise<void> | void };
}>) {
  const text = (bytes: Uint8Array | undefined) => new TextDecoder().decode(bytes);
  async function names(fs: VaultFs, directory: string) {
    const listed: string[] = [];
    for await (const entry of fs.list(directory)) listed.push(`${entry.kind}:${entry.name}`);
    return listed.sort();
  }

  describe(`${label} (VaultFs)`, () => {
    test("lists one level at a time, folders and files apart", async () => {
      const { fs } = await create({ "One.md": "1", "Notes/Two.md": "2", "Notes/Deep/Three.md": "3" });
      expect(await names(fs, "")).toEqual(["directory:Notes", "file:One.md"]);
      expect(await names(fs, "Notes")).toEqual(["directory:Deep", "file:Two.md"]);
      expect(await names(fs, "Notes/Deep")).toEqual(["file:Three.md"]);
    });

    test("listing a missing folder is NotFoundError, never an empty listing", async () => {
      const { fs } = await create({ "One.md": "1" });
      const error = await names(fs, "Nowhere").catch((caught) => caught);
      expect(isVaultFsError(error, "NotFoundError")).toBe(true);
    });

    test("reads bytes with the stat of the same snapshot", async () => {
      const { fs } = await create({ "Notes/Two.md": "Second." });
      const read = await fs.read("Notes/Two.md");
      expect(text(read?.bytes)).toBe("Second.");
      expect(read?.stat.size).toBe(7);
      expect(await fs.stat("Notes/Two.md")).toEqual(read!.stat);
      expect(await fs.read("Missing.md")).toBeNull();
      expect(await fs.stat("Notes/Missing.md")).toBeNull();
    });

    test("writes text as UTF-8 and bytes as they are, creating folders", async () => {
      const { fs } = await create({});
      await fs.writeAtomic("New/Folder/Note.md", "Café");
      await fs.writeAtomic("Attachments/a/pic.png", new Uint8Array([0, 255, 7]));
      expect(text((await fs.read("New/Folder/Note.md"))?.bytes)).toBe("Café");
      expect([...(await fs.read("Attachments/a/pic.png"))!.bytes]).toEqual([0, 255, 7]);
      await fs.writeAtomic("New/Folder/Note.md", "Replaced");
      expect(text((await fs.read("New/Folder/Note.md"))?.bytes)).toBe("Replaced");
    });

    test("moves a file and refuses to move over another", async () => {
      const { fs } = await create({ "A.md": "a", "B.md": "b" });
      await fs.move("A.md", "Moved/A.md");
      expect(await fs.read("A.md")).toBeNull();
      expect(text((await fs.read("Moved/A.md"))?.bytes)).toBe("a");
      const error = await fs.move("Moved/A.md", "B.md").catch((caught) => caught);
      expect(error).toBeInstanceOf(Error);
      expect(text((await fs.read("B.md"))?.bytes)).toBe("b");
    });

    test("deletes a file; deleting a missing one is NotFoundError", async () => {
      const { fs } = await create({ "A.md": "a" });
      await fs.delete("A.md");
      expect(await fs.read("A.md")).toBeNull();
      expect(isVaultFsError(await fs.delete("A.md").catch((caught) => caught), "NotFoundError")).toBe(true);
    });

    test("rejects paths that could leave the folder", async () => {
      const { fs } = await create({ "A.md": "a" });
      for (const path of ["../A.md", "/etc/passwd", "Notes/../../A.md", "a\\b.md", "./A.md", "A//B.md", ""]) {
        await expect(fs.read(path)).rejects.toThrow();
        await expect(fs.writeAtomic(path, "x")).rejects.toThrow();
      }
    });

    test("sees changes another app makes", async () => {
      const { fs, outside } = await create({ "A.md": "a" });
      if (!outside) return;
      await outside.write("A.md", "edited elsewhere");
      await outside.write("B.md", "added elsewhere");
      expect(text((await fs.read("A.md"))?.bytes)).toBe("edited elsewhere");
      expect(await names(fs, "")).toEqual(["file:A.md", "file:B.md"]);
      await outside.remove("A.md");
      expect(await fs.read("A.md")).toBeNull();
    });

    test("an existing folder is available", async () => {
      const { fs } = await create({ "A.md": "a" });
      expect(await fs.availability()).toBe("available");
    });
  });
}
