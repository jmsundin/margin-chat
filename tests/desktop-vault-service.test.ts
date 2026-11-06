import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createDesktopVaultService, type SyncStatus } from "../packages/vault-sync/desktopVaultService";
import { VaultSync } from "../client/src/lib/vaultSync";
import { emptyVault, type VaultFile, type VaultManifest, type VaultSnapshot, type VaultStore, type VaultTransport } from "../client/src/lib/vaultTypes";
import { createVaultService } from "../server/vault/index.mjs";
import { digest } from "../server/vault/storage.mjs";

const folders: string[] = [];
async function tempFolder(prefix: string) {
  const folder = await mkdtemp(path.join(tmpdir(), prefix));
  folders.push(folder);
  return folder;
}
afterEach(async () => { await Promise.all(folders.splice(0).map((folder) => rm(folder, { recursive: true, force: true }))); });

function memoryStore(): VaultStore {
  let snapshot: VaultSnapshot | null = null;
  let tail = Promise.resolve();
  return {
    async read() { return structuredClone(snapshot); },
    async write(value) { snapshot = structuredClone(value); },
    lock<T>(operation: () => Promise<T>) { const next = tail.then(operation); tail = next.then(() => undefined, () => undefined); return next; },
  };
}

/** The real cloud vault service over an in-memory object store, with a switch to take it offline and a commit counter. */
function cloud() {
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
  const normalize = (manifest: any): VaultManifest => ({ ...manifest, files: Object.fromEntries(Object.entries(manifest.files).map(([p, entry]: [string, any]) => [p, { ...entry, encoding: entry.encoding === "base64" ? "base64" : undefined }])) });
  const state = { offline: false, commits: 0 };
  const guard = () => { if (state.offline) throw new TypeError("Failed to fetch"); };
  const transport: VaultTransport = {
    async manifest() { guard(); return normalize((await server.status("user")).manifest); },
    async read(p, entry) {
      guard();
      const { bytes } = await server.readFile({ userId: "user", path: p, revision: entry.revision });
      return { content: bytes.toString(entry.encoding === "base64" ? "base64" : "utf8"), ...(entry.encoding ? { encoding: entry.encoding } : {}), contentType: entry.contentType };
    },
    async commit(changes) {
      guard();
      state.commits += 1;
      const { manifest, previousRevision } = await server.commit("user", changes);
      return { ...normalize(manifest), previousRevision };
    },
  };
  const files = async () => {
    const manifest = normalize((await server.status("user")).manifest);
    const live: Record<string, VaultFile> = {};
    for (const [p, entry] of Object.entries(manifest.files)) if (!entry.deleted) live[p] = await transport.read(p, entry);
    return live;
  };
  return { transport, state, files, phone: () => new VaultSync(memoryStore(), transport) };
}

async function desktop(vault: string | null, remote: ReturnType<typeof cloud> | null, extra: Partial<Parameters<typeof createDesktopVaultService>[0]> = {}) {
  const dataDir = await tempFolder("margin-journal-");
  const statuses: SyncStatus[] = [];
  let changes = 0;
  const service = await createDesktopVaultService({
    journalDir: path.join(dataDir, "vaults", "user"), userId: "user",
    folder: vault ? { id: "vault-1", name: path.basename(vault), path: vault } : null,
    transport: remote?.transport ?? null,
    onStatus: (status) => statuses.push(status), onChanged: () => { changes += 1; },
    intervalMs: 60_000, ...extra,
  });
  await service.refresh();
  return { service, statuses, dataDir, changes: () => changes, last: () => statuses.at(-1)! };
}

const names = async (folder: string) => (await readdir(folder)).filter((name) => !name.startsWith(".") && !name.startsWith("margin-chat-workspace-") && name !== "workspace.json").sort();
const stamped = (text: string) => /^---\n[\s\S]*margin-chat-id:/u.test(text);

describe("the desktop vault service runs the vault from the main process", () => {
  test("a file dropped into the folder reaches the cloud and another device, and gets its identity header in place", async () => {
    const vault = await tempFolder("margin-vault-");
    const remote = cloud();
    const { service, last } = await desktop(vault, remote);
    expect(last()).toMatchObject({ state: "synced", pending: 0, attention: null, cloud: true, folder: { name: path.basename(vault) } });

    await writeFile(path.join(vault, "Dropped.md"), "# Dropped\n\nFrom Finder.\n");
    await mkdir(path.join(vault, "Papers"));
    await writeFile(path.join(vault, "Papers", "paper.pdf"), "%PDF-1.4");
    await writeFile(path.join(vault, "notes.txt"), "unsupported");
    service.folderChanged();
    await service.refresh();

    const inCloud = await remote.files();
    expect(Object.keys(inCloud).filter((p) => !p.startsWith(".margin-chat/") && p !== "workspace.json").sort()).toEqual(["Dropped.md", "Papers/paper.pdf"]);
    expect(stamped(inCloud["Dropped.md"].content)).toBe(true);
    expect(inCloud["Dropped.md"].content).toContain("From Finder.");
    expect(stamped(await readFile(path.join(vault, "Dropped.md"), "utf8"))).toBe(true);
    expect(await readFile(path.join(vault, "notes.txt"), "utf8")).toBe("unsupported");
    expect(await service.unsupportedFiles()).toEqual(["notes.txt"]);

    const phone = remote.phone();
    await phone.sync();
    expect((await phone.read()).files["Dropped.md"].content).toContain("From Finder.");
    expect((await phone.read()).files["Papers/paper.pdf"]).toMatchObject({ encoding: "base64" });
    await service.refresh();
    expect(last().state).toBe("synced");
    await service.close();
  });

  test("a cloud change pulled to the folder costs no upload; an in-app edit costs exactly one", async () => {
    const vault = await tempFolder("margin-vault-");
    const remote = cloud();
    const phone = remote.phone();
    await phone.edit({ "From phone.md": { content: "---\nmargin-chat-id: phone-1\n---\nTyped on the train.\n" } }, {});
    await phone.sync();
    const { service } = await desktop(vault, remote);
    expect(await readFile(path.join(vault, "From phone.md"), "utf8")).toContain("Typed on the train.");
    const before = remote.state.commits;
    service.folderChanged();
    await service.refresh();
    await service.refresh();
    expect(remote.state.commits).toBe(before);

    const snapshot = await service.engine("read") as VaultSnapshot;
    const edited = { ...snapshot.files["From phone.md"], content: snapshot.files["From phone.md"].content.replace("Typed on the train.", "Typed on the train, then edited at home.") };
    await service.engine("edit", { "From phone.md": edited }, { "From phone.md": snapshot.files["From phone.md"] });
    await service.refresh();
    expect(remote.state.commits).toBe(before + 1);
    expect(await readFile(path.join(vault, "From phone.md"), "utf8")).toContain("then edited at home");
    await phone.sync();
    expect((await phone.read()).files["From phone.md"].content).toContain("then edited at home");
    await service.close();
  });

  test("offline edits wait on this computer and drain when the cloud is back; edits on both sides to the same note merge without markers", async () => {
    const vault = await tempFolder("margin-vault-");
    const remote = cloud();
    const phone = remote.phone();
    const original = "---\nmargin-chat-id: shared-1\n---\n<user id=\"a\">First paragraph.</user>\n\n<user id=\"b\">Second paragraph.</user>\n";
    await phone.edit({ "Shared.md": { content: original } }, {});
    await phone.sync();
    const { service, last } = await desktop(vault, remote);
    expect(await readFile(path.join(vault, "Shared.md"), "utf8")).toContain("Second paragraph.");

    remote.state.offline = true;
    await writeFile(path.join(vault, "Shared.md"), original.replace("First paragraph.", "First paragraph, edited at home."));
    service.folderChanged();
    await service.refresh();
    expect(last().state).toBe("offline");
    expect(last().pending).toBeGreaterThan(0);
    // Meanwhile the phone edits another block of the same note and syncs.
    const phoneSnapshot = await phone.read();
    await phone.edit({ "Shared.md": { content: original.replace("Second paragraph.", "Second paragraph, edited on the train.") } }, { "Shared.md": phoneSnapshot.files["Shared.md"] });
    remote.state.offline = false;
    await phone.sync();
    remote.state.offline = true;
    await service.refresh();
    expect(last().state).toBe("offline");

    remote.state.offline = false;
    await service.refresh();
    expect(last()).toMatchObject({ state: "synced", pending: 0 });
    const merged = await readFile(path.join(vault, "Shared.md"), "utf8");
    expect(merged).toContain("edited at home");
    expect(merged).toContain("edited on the train");
    expect(merged).not.toContain("<<<<");
    await phone.sync();
    expect((await phone.read()).files["Shared.md"].content).toBe(merged);
    await service.close();
  });

  test("a burst of deletions in the folder is held until answered, while a small deletion flows through with a trash copy", async () => {
    const vault = await tempFolder("margin-vault-");
    const remote = cloud();
    for (let index = 0; index < 14; index += 1) await writeFile(path.join(vault, `Note ${index}.md`), `---\nmargin-chat-id: note-${index}\n---\nNote ${index}\n`);
    const { service, last } = await desktop(vault, remote);
    expect(Object.keys(await remote.files()).filter((p) => p.endsWith(".md"))).toHaveLength(14);

    for (let index = 0; index < 12; index += 1) await rm(path.join(vault, `Note ${index}.md`));
    service.folderChanged();
    await service.refresh();
    expect(last()).toMatchObject({ state: "attention", attention: { kind: "deletion-hold" } });
    expect(last().held?.paths).toHaveLength(12);
    expect(Object.keys(await remote.files()).filter((p) => p.endsWith(".md"))).toHaveLength(14);
    // Cloud sync keeps going while held: a new note from the phone still lands in the folder.
    const phone = remote.phone();
    await phone.edit({ "Meanwhile.md": { content: "---\nmargin-chat-id: meanwhile\n---\nStill syncing.\n" } }, {});
    await phone.sync();
    await service.refresh();
    expect(last().state).toBe("attention");

    await service.resolveHeldDeletion("restore");
    expect(last()).toMatchObject({ state: "synced", attention: null, held: null });
    expect((await names(vault)).filter((name) => name.startsWith("Note "))).toHaveLength(14);
    expect(await names(vault)).toContain("Meanwhile.md");

    await rm(path.join(vault, "Note 0.md"));
    await rm(path.join(vault, "Note 1.md"));
    service.folderChanged();
    await service.refresh();
    expect(last().state).toBe("synced");
    const inCloud = await remote.files();
    expect(Object.keys(inCloud).filter((p) => /^Note \d+\.md$/u.test(p))).toHaveLength(12);
    const trashed = Object.keys(inCloud).filter((p) => p.startsWith(".margin-chat/trash/"));
    expect(trashed.some((p) => p.endsWith("/deleted.json"))).toBe(true);
    expect(trashed.some((p) => p.endsWith("Note 0.md"))).toBe(true);
    expect(await readdir(path.join(vault, ".margin-chat", "trash"))).toHaveLength(1);
    await service.close();
  });

  test("a folder that goes missing is never read as empty: nothing is deleted, status says so, and it recovers when the folder is back", async () => {
    const parent = await tempFolder("margin-parent-");
    const vault = path.join(parent, "Vault");
    await mkdir(vault);
    await writeFile(path.join(vault, "Keep.md"), "---\nmargin-chat-id: keep\n---\nKeep me.\n");
    const remote = cloud();
    const { service, last } = await desktop(vault, remote);
    expect(Object.keys(await remote.files())).toContain("Keep.md");

    await rename(vault, path.join(parent, "Elsewhere"));
    service.folderChanged();
    await service.refresh();
    expect(last()).toMatchObject({ state: "attention", attention: { kind: "folder-missing" } });
    expect(Object.keys(await remote.files())).toContain("Keep.md");
    // An edit from another device still syncs into the journal while the folder is away.
    const phone = remote.phone();
    await phone.edit({ "While away.md": { content: "---\nmargin-chat-id: away\n---\nSynced anyway.\n" } }, {});
    await phone.sync();
    await service.refresh();
    expect(last().attention?.kind).toBe("folder-missing");

    await rename(path.join(parent, "Elsewhere"), vault);
    await service.refresh();
    expect(last()).toMatchObject({ state: "synced", attention: null });
    expect(await names(vault)).toEqual(["Keep.md", "While away.md"]);
    await service.close();
  });

  test("without cloud sync the folder still gets the watcher-and-versioning treatment, and pausing stops the loop", async () => {
    const vault = await tempFolder("margin-vault-");
    const { service, last } = await desktop(vault, null);
    expect(last()).toMatchObject({ state: "local", cloud: false });
    await writeFile(path.join(vault, "Local.md"), "# Local only\n");
    service.folderChanged();
    await service.refresh();
    expect(stamped(await readFile(path.join(vault, "Local.md"), "utf8"))).toBe(true);
    const snapshot = await service.snapshot();
    expect(snapshot.files["Local.md"].content).toContain("# Local only");
    service.pause(true);
    expect(last()).toMatchObject({ state: "paused", paused: true });
    service.pause(false);
    await service.refresh();
    expect(last().state).toBe("local");
    await service.close();
  });

  test("the journal in the app's data folder outlives the service: a restart converges without duplicates", async () => {
    const vault = await tempFolder("margin-vault-");
    const remote = cloud();
    const first = await desktop(vault, remote);
    await writeFile(path.join(vault, "Persist.md"), "# Persist\n");
    first.service.folderChanged();
    await first.service.refresh();
    const stampedOnDisk = await readFile(path.join(vault, "Persist.md"), "utf8");
    await first.service.close();

    const second = await createDesktopVaultService({
      journalDir: path.join(first.dataDir, "vaults", "user"), userId: "user", folder: { id: "vault-1", name: path.basename(vault), path: vault }, transport: remote.transport, intervalMs: 60_000,
    });
    const commits = remote.state.commits;
    await second.refresh();
    expect(remote.state.commits).toBe(commits);
    expect(await readFile(path.join(vault, "Persist.md"), "utf8")).toBe(stampedOnDisk);
    expect(Object.keys(await remote.files()).filter((p) => p.endsWith(".md"))).toEqual(["Persist.md"]);
    expect(await names(vault)).toEqual(["Persist.md"]);
    await second.close();
  });
});
