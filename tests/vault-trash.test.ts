import { describe, expect, test } from "bun:test";
import { VaultSync, pendingVaultChanges } from "../client/src/lib/vaultSync";
import { emptyVault, type VaultFile, type VaultSnapshot, type VaultStore } from "../client/src/lib/vaultTypes";
import { TRASH_DAYS, listTrash, moveDeletionsToTrash, purgeExpiredTrash, restoreFromTrash, trashTitle } from "../client/src/lib/vaultTrash";
import { folderDeletionsToHold } from "../client/src/lib/folderDeletionGuard";
import { createVaultService } from "../server/vault/index.mjs";
import { digest } from "../server/vault/storage.mjs";

const doc = (id: string, title = id): VaultFile => ({
  content: `---\nmargin-chat-id: "${id}"\ntitle: "${title}"\nupdated: "2026-10-01T00:00:00.000Z"\n---\n# ${title}\n\nBody of ${id}.\n`,
  contentType: "text/markdown; charset=utf-8",
});
const image = (text: string): VaultFile => ({ content: btoa(text), encoding: "base64", contentType: "image/png" });

function vault(files: Record<string, VaultFile>): VaultSnapshot {
  return { ...emptyVault(), files: { ...files } };
}
function memoryStore(initial: VaultSnapshot): VaultStore {
  let snapshot = structuredClone(initial);
  let tail = Promise.resolve();
  return {
    async read() { return structuredClone(snapshot); },
    async write(value) { snapshot = structuredClone(value); },
    lock<T>(operation: () => Promise<T>) { const run = tail.then(operation); tail = run.then(() => undefined, () => undefined); return run; },
  };
}
const transport = { manifest: async () => { throw new Error("offline"); }, read: async () => { throw new Error("offline"); }, commit: async () => { throw new Error("offline"); } } as any;

describe("vault trash", () => {
  test("a deleted document is copied into the trash with its title", () => {
    const before = { "Trip.md": doc("trip", "Trip to Japan"), "Budget.md": doc("budget") };
    const snapshot = vault({ "Budget.md": before["Budget.md"] });
    const entry = moveDeletionsToTrash(snapshot, before, { "Budget.md": before["Budget.md"] }, before, new Date("2026-10-15T02:00:00Z"))!;
    expect(entry.files).toEqual([{ path: "Trip.md", copy: expect.stringMatching(/^\.margin-chat\/trash\/20261015T020000Z-[0-9a-f]{8}\/1-Trip\.md$/), title: "Trip to Japan" }]);
    expect(snapshot.files[entry.files[0].copy]).toEqual(before["Trip.md"]);
    expect(snapshot.files["Trip.md"]).toBeUndefined();
    expect(listTrash(snapshot.files)).toEqual([entry]);
  });

  test("documents deleted together are one entry", () => {
    const before = { "Trip.md": doc("trip"), "Trip note.md": doc("trip-note"), "photo.png": image("bytes") };
    const snapshot = vault({});
    const entry = moveDeletionsToTrash(snapshot, before, {}, before)!;
    expect(entry.files.map((file) => file.path)).toEqual(["Trip note.md", "Trip.md", "photo.png"]);
    expect(snapshot.files[entry.files[2].copy]).toEqual(before["photo.png"]);
  });

  test("renames and moves are not deletions", () => {
    const before = { "Trip.md": doc("trip"), "photo.png": image("bytes") };
    const next = { "Archive/Trip.md": before["Trip.md"], "Archive/photo.png": before["photo.png"] };
    const snapshot = vault(next);
    expect(moveDeletionsToTrash(snapshot, before, next, before)).toBeNull();
    expect(Object.keys(snapshot.files).sort()).toEqual(["Archive/Trip.md", "Archive/photo.png"]);
  });

  test("Margin Chat's own files and settings are not trashed", () => {
    const before = { "workspace.json": { content: "{}" }, ".margin-chat/history/x/conflict.json": { content: "{}" }, "Attachments/a/raw.bin": image("a") };
    const snapshot = vault({});
    expect(moveDeletionsToTrash(snapshot, before, {}, before)).toBeNull();
  });

  test("a deletion the edit did not ask for, such as a concurrent edit winning, is left alone", () => {
    const before = { "Trip.md": doc("trip") };
    const snapshot = vault({ "Trip.md": doc("trip", "Edited elsewhere") });
    expect(moveDeletionsToTrash(snapshot, before, {}, before)).toBeNull();
  });

  test("restore puts files back and removes the entry", () => {
    const before = { "Notes/Trip.md": doc("trip") };
    const snapshot = vault({});
    const entry = moveDeletionsToTrash(snapshot, before, {}, before)!;
    expect(restoreFromTrash(snapshot, entry.key)).toEqual(["Notes/Trip.md"]);
    expect(snapshot.files).toEqual({ "Notes/Trip.md": before["Notes/Trip.md"] });
    expect(() => restoreFromTrash(snapshot, entry.key)).toThrow(/no longer in Recently deleted/);
  });

  test("restore never overwrites a file now at that path", () => {
    const before = { "Trip.md": doc("trip"), "photo.png": image("old") };
    const snapshot = vault({});
    const entry = moveDeletionsToTrash(snapshot, before, {}, before)!;
    snapshot.files["Trip.md"] = doc("another-trip", "A different trip");
    snapshot.files["photo.png"] = image("new");
    expect(restoreFromTrash(snapshot, entry.key).sort()).toEqual(["Trip (restored).md", "photo (restored).png"]);
    expect(snapshot.files["Trip.md"].content).toContain("A different trip");
    expect(snapshot.files["photo.png"]).toEqual(image("new"));
  });

  test("a document already back in the vault is not restored twice", () => {
    const before = { "Trip.md": doc("trip") };
    const snapshot = vault({});
    const entry = moveDeletionsToTrash(snapshot, before, {}, before)!;
    snapshot.files["Elsewhere/Trip.md"] = before["Trip.md"];
    expect(restoreFromTrash(snapshot, entry.key)).toEqual([]);
    expect(listTrash(snapshot.files)).toEqual([]);
  });

  test("entries older than the trash keeps them are purged", () => {
    const before = { "Old.md": doc("old"), "New.md": doc("new") };
    const snapshot = vault({});
    const now = Date.parse("2026-10-15T00:00:00Z");
    moveDeletionsToTrash(snapshot, { "Old.md": before["Old.md"] }, {}, before, new Date(now - (TRASH_DAYS + 1) * 86_400_000));
    const recent = moveDeletionsToTrash(snapshot, { "New.md": before["New.md"] }, {}, before, new Date(now - 86_400_000))!;
    expect(purgeExpiredTrash(snapshot, now)).toBe(1);
    expect(listTrash(snapshot.files).map((entry) => entry.key)).toEqual([recent.key]);
    expect(Object.keys(snapshot.files).every((path) => path.includes(recent.key))).toBe(true);
  });

  test("titles fall back to the first heading, then the file name", () => {
    expect(trashTitle("a.md", { content: "# Plain heading\n\nText" })).toBe("Plain heading");
    expect(trashTitle("Folder/Untitled idea.md", { content: "Just text" })).toBe("Untitled idea");
    expect(trashTitle("scan.pdf", { content: "", encoding: "base64" })).toBe("scan.pdf");
  });

  test("emptying the trash folder by hand is not held as a mass deletion", () => {
    const before = { "Trip.md": doc("trip") };
    const snapshot = vault({});
    for (let index = 0; index < 12; index++) moveDeletionsToTrash(snapshot, { [`n${index}.md`]: doc(`n${index}`) }, {}, { [`n${index}.md`]: doc(`n${index}`) });
    const expected = { ...snapshot.files, ...before };
    expect(folderDeletionsToHold(before, expected)).toEqual([]);
  });
});

describe("vault engine trash", () => {
  test("app deletions land in Recently deleted, upload before the deletion, and restore", async () => {
    const files = { "Trip.md": doc("trip"), "Budget.md": doc("budget") };
    const synced = vault(files);
    synced.base = Object.fromEntries(Object.entries(files).map(([path, file], index) => [path, { revision: `r${index}`, file }]));
    const engine = new VaultSync(memoryStore(synced), transport);
    const after = await engine.edit({ "Budget.md": files["Budget.md"] }, files);
    const [entry] = listTrash(after.files);
    expect(entry.files.map((file) => file.path)).toEqual(["Trip.md"]);
    const pending = pendingVaultChanges(after);
    expect(pending.some((change) => change.path === "Trip.md" && change.content === null)).toBe(true);
    expect(pending.some((change) => change.path === entry.files[0].copy && change.content !== null)).toBe(true);

    const { snapshot, restored } = await engine.restoreDeleted(entry.key);
    expect(restored).toEqual(["Trip.md"]);
    expect(snapshot.files["Trip.md"]).toEqual(files["Trip.md"]);
    expect(listTrash(snapshot.files)).toEqual([]);
  });

  test("purging writes only when something expired", async () => {
    const files = { "Trip.md": doc("trip") };
    const engine = new VaultSync(memoryStore(vault(files)), transport);
    await engine.edit({}, files);
    expect(await engine.purgeTrash()).toBe(0);
    expect(await engine.purgeTrash(Date.now() + (TRASH_DAYS + 1) * 86_400_000)).toBe(1);
    expect(Object.keys((await engine.read()).files)).toEqual([]);
  });

  test("a deletion synced to the cloud keeps its copy there, and another device can restore it", async () => {
    const objects = new Map<string, Buffer>();
    const server = createVaultService({ storage: {
      kind: "memory",
      async read(key: string) { const bytes = objects.get(key); return bytes ? { bytes, etag: digest(bytes) } : null; },
      async putImmutable(key: string, bytes: Buffer) { objects.set(key, Buffer.from(bytes)); },
      async compareAndSwap(key: string, bytes: Buffer, expected: string | null) {
        if ((objects.has(key) ? digest(objects.get(key)) : null) !== expected) return false;
        objects.set(key, Buffer.from(bytes)); return true;
      },
    } });
    const normalize = (manifest: any) => ({ ...manifest, files: Object.fromEntries(Object.entries(manifest.files).map(([path, entry]: [string, any]) => [path, { ...entry, encoding: entry.encoding === "base64" ? "base64" : undefined }])) });
    const cloud = {
      async manifest() { return normalize((await server.status("user")).manifest); },
      async read(path: string, entry: any) {
        const { bytes } = await server.readFile({ userId: "user", path, revision: entry.revision });
        return { content: bytes.toString(entry.encoding === "base64" ? "base64" : "utf8"), ...(entry.encoding ? { encoding: entry.encoding } : {}), contentType: entry.contentType };
      },
      async commit(changes: any) { const { manifest, previousRevision } = await server.commit("user", changes); return { ...normalize(manifest), previousRevision }; },
    } as any;
    const laptop = new VaultSync(memoryStore(emptyVault()), cloud);
    const files = { "Trip.md": doc("trip"), "Budget.md": doc("budget") };
    await laptop.edit(files, {});
    await laptop.sync();
    await laptop.edit({ "Budget.md": files["Budget.md"] }, (await laptop.read()).files);
    await laptop.sync();
    const manifest = (await server.status("user")).manifest;
    expect(manifest.files["Trip.md"].deleted).toBe(true);
    expect(Object.keys(manifest.files).some((path) => path.startsWith(".margin-chat/trash/") && !manifest.files[path].deleted)).toBe(true);

    const phone = new VaultSync(memoryStore(emptyVault()), cloud);
    await phone.sync();
    const [entry] = listTrash((await phone.read()).files);
    expect(entry.files[0].title).toBe("trip");
    await phone.restoreDeleted(entry.key);
    await phone.sync();
    const restored = (await server.status("user")).manifest;
    expect(restored.files["Trip.md"].deleted).toBe(false);
    expect(Object.entries(restored.files).filter(([path, item]: [string, any]) => path.startsWith(".margin-chat/trash/") && !item.deleted)).toEqual([]);
  });
});
