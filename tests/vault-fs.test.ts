import { describe, expect, test } from "bun:test";
import { assertVaultFsPath, createMemoryVaultFs, decodeVaultFsText, isVaultFsPath } from "@margin-chat/vault-sync";
import { fsAccessVaultFs, isVaultFs, toVaultFs } from "../client/src/lib/vaultFsAccess";
import { createMarkdownWorkspace, discoverMarkdownWorkspace, parseMarkdownWorkspace } from "../client/src/lib/workspaceMarkdown";
import { LocalDirectoryConflictError, localDirectorySignature, readDirectoryWorkspace, writeConnectedDirectoryWorkspace } from "../client/src/lib/workspaceStorage";
import { describeVaultFs } from "./helpers/vaultFsConformance";

/** A folder behind the browser's File System Access handles, held in memory. */
function directoryHandle(initial: Record<string, string | Uint8Array>) {
  const files = new Map<string, { bytes: Uint8Array; lastModified: number }>();
  let clock = Date.now() - 60_000;
  const encode = (value: string | Uint8Array) => typeof value === "string" ? new TextEncoder().encode(value) : value;
  for (const [path, bytes] of Object.entries(initial)) files.set(path, { bytes: encode(bytes), lastModified: clock += 1000 });
  let removed = false;
  function missing() { return new DOMException("Missing", "NotFoundError"); }
  const isFolder = (prefix: string) => prefix === "" || [...files.keys()].some((path) => path.startsWith(prefix));
  function directory(prefix = ""): FileSystemDirectoryHandle {
    return {
      kind: "directory", name: prefix ? prefix.slice(0, -1).split("/").at(-1) : "vault",
      async *entries() {
        if (removed || !isFolder(prefix)) throw missing();
        const names = new Map<string, boolean>();
        for (const path of files.keys()) if (path.startsWith(prefix)) {
          const rest = path.slice(prefix.length).split("/");
          names.set(rest[0], rest.length === 1);
        }
        for (const [name, isFile] of names) yield [name, isFile ? fileHandle(prefix + name) : directory(`${prefix}${name}/`)];
      },
      async getDirectoryHandle(name: string, options?: { create?: boolean }) {
        if (files.has(prefix + name)) throw new DOMException("A file", "TypeMismatchError");
        if (!options?.create && !isFolder(`${prefix}${name}/`)) throw missing();
        return directory(`${prefix}${name}/`);
      },
      async getFileHandle(name: string, options?: { create?: boolean }) {
        const path = prefix + name;
        if (!files.has(path)) {
          if (!options?.create) throw missing();
          files.set(path, { bytes: new Uint8Array(), lastModified: clock += 1000 });
        }
        return fileHandle(path);
      },
      async removeEntry(name: string) { if (!files.delete(prefix + name)) throw missing(); },
    } as unknown as FileSystemDirectoryHandle;
  }
  function fileHandle(path: string): FileSystemFileHandle {
    return {
      kind: "file", name: path.split("/").at(-1),
      async getFile() {
        const entry = files.get(path);
        if (!entry) throw missing();
        return new File([new Uint8Array(entry.bytes)], path.split("/").at(-1)!, { lastModified: entry.lastModified });
      },
      async createWritable() {
        let pending: Uint8Array | null = null;
        return {
          async write(content: string | ArrayBuffer) { pending = typeof content === "string" ? encode(content) : new Uint8Array(content); },
          async close() { files.set(path, { bytes: pending ?? new Uint8Array(), lastModified: clock += 1000 }); },
          async abort() { pending = null; },
        };
      },
    } as unknown as FileSystemFileHandle;
  }
  return {
    handle: directory(), files,
    write(path: string, contents: string) { files.set(path, { bytes: encode(contents), lastModified: clock += 1000 }); },
    remove(path: string) { files.delete(path); },
    removeFolder() { removed = true; },
  };
}

describeVaultFs("in-memory folder", async (files) => {
  const fs = createMemoryVaultFs(files);
  return { fs, outside: { write: (path, contents) => fs.put(path, contents), remove: (path) => fs.remove(path) } };
});

describeVaultFs("browser folder (File System Access)", async (files) => {
  const folder = directoryHandle(files);
  return { fs: fsAccessVaultFs(folder.handle), outside: folder };
});

describe("vault folder paths", () => {
  test("accepts only paths inside the folder", () => {
    for (const path of ["A.md", "Notes/B.md", ".margin-chat/history/x/conflict.json", "Café ✓.md"]) expect(isVaultFsPath(path)).toBe(true);
    for (const path of ["", "/A.md", "../A.md", "a/../b", "a/./b", "a//b", "a\\b", "a\u0000b", "a/"]) expect(isVaultFsPath(path)).toBe(false);
    expect(assertVaultFsPath("", true)).toBe("");
    expect(() => assertVaultFsPath("")).toThrow(TypeError);
  });

  test("decodes text the way File.text() does", async () => {
    const withMark = new Uint8Array([0xef, 0xbb, 0xbf, 0x48, 0x69, 0xff]);
    expect(decodeVaultFsText(withMark)).toBe(await new Blob([withMark]).text());
  });
});

describe("browser folder adapter", () => {
  test("a moved or deleted folder is missing, not empty", async () => {
    const folder = directoryHandle({ "A.md": "a" });
    const fs = fsAccessVaultFs(folder.handle);
    folder.removeFolder();
    expect(await fs.availability()).toBe("missing");
  });

  test("a handle kept from a listing still finds a file replaced since", async () => {
    const folder = directoryHandle({ "Notes/A.md": "a" });
    const fs = fsAccessVaultFs(folder.handle);
    for await (const _ of fs.list("Notes")) { /* keeps the file's handle */ }
    folder.remove("Notes/A.md");
    expect(await fs.read("Notes/A.md")).toBeNull();
    folder.write("Notes/A.md", "back");
    expect(new TextDecoder().decode((await fs.read("Notes/A.md"))?.bytes)).toBe("back");
  });

  test("a VaultFs passes through; a handle is wrapped", () => {
    const memory = createMemoryVaultFs();
    expect(toVaultFs(memory)).toBe(memory);
    const handle = directoryHandle({}).handle;
    expect(isVaultFs(handle)).toBe(false);
    expect(isVaultFs(toVaultFs(handle))).toBe(true);
  });

  test("without a folder observer the browser adapter can't watch, so callers poll", () => {
    expect(fsAccessVaultFs(directoryHandle({}).handle).watch?.(() => {})).toBeNull();
  });
});

describe("in-memory folder", () => {
  test("tells watchers what another app changed", async () => {
    const fs = createMemoryVaultFs({ "A.md": "a" });
    const seen: Array<string[] | null> = [];
    const stop = fs.watch!((paths) => seen.push(paths));
    fs.put("B.md", "b");
    await fs.writeAtomic("C.md", "c");
    stop();
    fs.remove("A.md");
    expect(seen).toEqual([["B.md"], ["C.md"]]);
  });

  test("a missing or refused folder can't be read", async () => {
    const fs = createMemoryVaultFs({ "A.md": "a" });
    fs.setAvailability("missing");
    expect(await fs.availability()).toBe("missing");
    await expect(fs.read("A.md")).rejects.toThrow();
    fs.setAvailability("available");
    expect(await fs.read("A.md")).not.toBeNull();
  });
});

describe("folder sync over any VaultFs", () => {
  // The same scan and write code the browser folder uses, on a folder that is not a browser handle.
  test("reads, writes and refuses to overwrite another app's edit", async () => {
    const original = discoverMarkdownWorkspace({ "Note.md": "Original content.", "Notes/Other.md": "Other." });
    const fs = createMemoryVaultFs(original.files);
    const read = await readDirectoryWorkspace(fs, "user", original.manifest, original.files);
    expect(Object.keys(read.workspace.files).sort()).toEqual(["Note.md", "Notes/Other.md"]);

    const state = parseMarkdownWorkspace(read.workspace.manifest, read.workspace.files)!;
    const id = read.workspace.manifest.files.find((file) => file.path === "Note.md")!.id;
    state.conversations[id].notes![0].content = "Application change.";
    const desired = createMarkdownWorkspace(state, undefined, read.workspace);
    const before = await localDirectorySignature(fs);
    await writeConnectedDirectoryWorkspace(fs, "user", desired, read.workspace);
    expect(decodeVaultFsText(fs.files.get("Note.md")!.bytes)).toContain("Application change.");
    expect(await localDirectorySignature(fs)).not.toBe(before);

    fs.put("Note.md", "External change.");
    await expect(writeConnectedDirectoryWorkspace(fs, "user", read.workspace, desired)).rejects.toBeInstanceOf(LocalDirectoryConflictError);
    expect(decodeVaultFsText(fs.files.get("Note.md")!.bytes)).toBe("External change.");
  });
});
