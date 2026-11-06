import { afterEach, expect, test } from "bun:test";
import { mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createJournalVaultStore } from "../client/src/lib/vaultLocal";
import { emptyVault } from "../client/src/lib/vaultTypes";
import { asFileSystemDirectoryHandle, openNodeVaultDirectory } from "../packages/vault-sync/node";

const folders: string[] = [];
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });

/** The desktop app's journal store: the browser's format over a folder in the app's data directory. */
async function nodeStore(dataDir: string) {
  let tail = Promise.resolve();
  return createJournalVaultStore({
    openRoot: async () => asFileSystemDirectoryHandle(await (await openNodeVaultDirectory(dataDir)).getDirectoryHandle("vault", { create: true })),
    lock<T>(operation: () => Promise<T>) { const next = tail.then(operation); tail = next.then(() => undefined, () => undefined); return next; },
  });
}

test("the journal store keeps a device's vault copy in a plain folder, with the same checkpoint, journal and history layout as the browser", async () => {
  const dataDir = await mkdtemp(path.join(tmpdir(), "margin-journal-"));
  folders.push(dataDir);
  const store = await nodeStore(dataDir);
  expect(await store.read()).toBeNull();
  const snapshot = { ...emptyVault(), remoteRevision: 3, files: { "Note.md": { content: "# Note\n" }, "Attachments/a/x.bin": { content: "AAEC", encoding: "base64" as const, contentType: "application/octet-stream" } },
    base: { "Note.md": { revision: "r1", file: { content: "# Note\n" } } } };
  await store.lock(() => store.write(snapshot));
  const saved = await store.read();
  expect(saved?.files["Note.md"].content).toBe("# Note\n");
  expect(saved?.files["Attachments/a/x.bin"]).toEqual({ content: "AAEC", encoding: "base64", contentType: "application/octet-stream" });
  expect(saved?.remoteRevision).toBe(3);
  const root = path.join(dataDir, "vault");
  expect((await readdir(root)).sort()).toEqual(expect.arrayContaining(["history", "vault-journal.json"]));
  expect((await readdir(path.join(root, "history"))).length).toBe(2);

  // A second save is a journal segment; a fresh store reads both back.
  await store.lock(() => store.write({ ...snapshot, files: { ...snapshot.files, "Second.md": { content: "two" } } }));
  const reopened = await nodeStore(dataDir);
  const again = await reopened.read();
  expect(Object.keys(again!.files).sort()).toEqual(["Attachments/a/x.bin", "Note.md", "Second.md"]);
  expect(await readdir(path.join(root, "journal"))).toHaveLength(1);
});
