import { describe, expect, test } from "bun:test";
import { createEmptyState } from "../client/src/initialState";
import { VaultSync } from "../client/src/lib/vaultSync";
import { emptyVault, type VaultManifest, type VaultSnapshot, type VaultStore, type VaultTransport } from "../client/src/lib/vaultTypes";
import { stateToVaultFiles, vaultToState, workspaceFromVault } from "../client/src/lib/vaultWorkspace";
import { createVaultService } from "../server/vault/index.mjs";
import { digest } from "../server/vault/storage.mjs";
import { titleMarkdownPath } from "../packages/workspace-contracts/markdownPaths.mjs";

const now = "2026-09-26T12:00:00.000Z";
function state(id = "document", title = "Original plan", content = "Original paragraph.") {
  const result = createEmptyState();
  const conversation = { ...result.conversations[result.rootId], id, title, createdAt: now, updatedAt: now,
    document: { schemaVersion: 1 as const, blocks: [{ id: `${id}-block`, kind: "markdown" as const, content, createdAt: now, updatedAt: now }], prompts: [], generations: [] } };
  result.conversations = { [id]: conversation };
  result.activeConversationId = id;
  result.rootId = id;
  return result;
}
function store(): VaultStore {
  let snapshot: VaultSnapshot = emptyVault();
  let tail = Promise.resolve();
  return { async read() { return structuredClone(snapshot); }, async write(next) { snapshot = structuredClone(next); },
    lock<T>(operation: () => Promise<T>) { const current = tail.then(operation); tail = current.then(() => undefined, () => undefined); return current; } };
}
function cloud() {
  const objects = new Map<string, Buffer>();
  const server = createVaultService({ storage: { kind: "memory",
    async read(key: string) { const bytes = objects.get(key); return bytes ? { bytes, etag: digest(bytes) } : null; },
    async putImmutable(key: string, bytes: Buffer) { objects.set(key, Buffer.from(bytes)); },
    async compareAndSwap(key: string, bytes: Buffer, expected: string | null) {
      if ((objects.has(key) ? digest(objects.get(key)) : null) !== expected) return false;
      objects.set(key, Buffer.from(bytes)); return true;
    } } });
  const normalize = (manifest: any): VaultManifest => ({ ...manifest, files: Object.fromEntries(Object.entries(manifest.files)
    .map(([path, entry]: [string, any]) => [path, { ...entry, encoding: entry.encoding === "base64" ? "base64" : undefined }])) });
  const commits: string[][] = [];
  const transport: VaultTransport = {
    async manifest() { return normalize((await server.status("user")).manifest); },
    async read(path, entry) { const { bytes } = await server.readFile({ userId: "user", path, revision: entry.revision });
      return { content: bytes.toString(entry.encoding === "base64" ? "base64" : "utf8"), ...(entry.encoding ? { encoding: entry.encoding } : {}) }; },
    async commit(changes) { commits.push(changes.map((change) => change.path)); return normalize((await server.commit("user", changes)).manifest); },
  };
  return { commits, transport, device: () => new VaultSync(store(), transport) };
}
async function edit(device: VaultSync, mutate: (current: ReturnType<typeof state>) => void) {
  const snapshot = await device.read();
  const current = vaultToState(snapshot.files, createEmptyState());
  mutate(current);
  await device.edit(stateToVaultFiles(current, snapshot.files), snapshot.files);
}
function record(snapshot: VaultSnapshot, id = "document") {
  return workspaceFromVault(snapshot.files).manifest.files.find((item) => item.id === id)!;
}
function body(snapshot: VaultSnapshot, id = "document") {
  return vaultToState(snapshot.files, createEmptyState()).conversations[id];
}

describe("title filenames across devices and portable imports", () => {
  test("a cloud title rename carries concurrent offline content and publishes both paths atomically", async () => {
    const remote = cloud(); const desktop = remote.device(); const offline = remote.device();
    await desktop.edit(stateToVaultFiles(state(), {}), {}); await desktop.sync(); await offline.sync();
    const oldPath = record(await desktop.read()).path;
    await edit(desktop, (current) => { current.conversations.document.title = "Renamed project 東京"; });
    await edit(offline, (current) => { current.conversations.document.document!.blocks[0].content = "Offline writing must survive."; });
    const renamedPath = record(await desktop.read()).path;
    expect(renamedPath).toBe(titleMarkdownPath("Chats", "Renamed project 東京", "document"));
    const renameCommitsStart = remote.commits.length;
    await desktop.sync();
    const renameCommits = remote.commits.slice(renameCommitsStart);
    expect(renameCommits.some((paths) => paths.includes(oldPath))).toBe(true);
    for (const paths of renameCommits) expect(paths.includes(oldPath)).toBe(paths.includes(renamedPath));
    await offline.sync(); await desktop.sync();
    for (const device of [desktop, offline]) {
      const snapshot = await device.read();
      expect(snapshot.files[oldPath]).toBeUndefined();
      expect(record(snapshot).path).toBe(renamedPath);
      expect(body(snapshot).title).toBe("Renamed project 東京");
      expect(body(snapshot).document!.blocks[0].content).toBe("Offline writing must survive.");
      expect(workspaceFromVault(snapshot.files).manifest.files).toHaveLength(1);
    }
  });

  test("a local title rename racing with a cloud edit remains managed for the next title change", async () => {
    const remote = cloud(); const desktop = remote.device(); const offline = remote.device();
    await desktop.edit(stateToVaultFiles(state(), {}), {}); await desktop.sync(); await offline.sync();
    await edit(desktop, (current) => { current.conversations.document.document!.blocks[0].content = "Cloud paragraph."; });
    await edit(offline, (current) => { current.conversations.document.title = "Offline title"; });
    await desktop.sync(); await offline.sync();
    expect(body(await offline.read()).document!.blocks[0].content).toBe("Cloud paragraph.");
    expect(body(await offline.read()).title).toBe("Offline title");
    await edit(offline, (current) => { current.conversations.document.title = "Next intended title"; });
    expect(record(await offline.read()).path).toBe(titleMarkdownPath("Chats", "Next intended title", "document"));
  });

  test("two offline documents with the same title remain separate after both devices synchronize", async () => {
    const remote = cloud(); const first = remote.device(); const second = remote.device();
    await first.edit(stateToVaultFiles(state("first", "Shared title", "First document content."), {}), {});
    await second.edit(stateToVaultFiles(state("second", "Shared title", "Second document content."), {}), {});
    expect(record(await first.read(), "first").path.toLowerCase()).not.toBe(record(await second.read(), "second").path.toLowerCase());
    await first.sync(); await second.sync(); await first.sync();
    for (const device of [first, second]) {
      const snapshot = await device.read();
      expect(workspaceFromVault(snapshot.files).manifest.files.map((item) => item.id).sort()).toEqual(["first", "second"]);
      expect(body(snapshot, "first").document!.blocks[0].content).toBe("First document content.");
      expect(body(snapshot, "second").document!.blocks[0].content).toBe("Second document content.");
      expect(snapshot.conflicts).toEqual([]);
    }
  });

  test("managed path ownership survives cloud hydration without a sidecar file registry", async () => {
    const remote = cloud(); const original = remote.device();
    await original.edit(stateToVaultFiles(state(), {}), {}); await original.sync();
    const fresh = remote.device(); await fresh.sync();
    const before = await fresh.read();
    expect(JSON.parse(before.files["workspace.json"].content).files).toEqual([]);
    expect(record(before).managedPath).toBe(record(before).path);
    await edit(fresh, (current) => { current.conversations.document.title = "Fresh device title"; });
    const after = await fresh.read();
    expect(record(after).path).toBe(titleMarkdownPath("Chats", "Fresh device title", "document"));
    expect(record(after).aliases).toContain(record(before).path);
    await fresh.sync(); await original.sync();
    expect(record(await original.read()).path).toBe(record(after).path);
  });

  test("header aliases preserve child relationships while a title rename spans cloud batches", async () => {
    const remote = cloud(); const observer = remote.device();
    let monitor = false;
    let observations = 0;
    const writer = new VaultSync(store(), { ...remote.transport, async commit(changes) {
      const manifest = await remote.transport.commit(changes);
      if (monitor) {
        await observer.sync();
        const current = vaultToState((await observer.read()).files, createEmptyState());
        expect(Object.keys(current.conversations)).toHaveLength(45);
        for (let index = 0; index < 44; index++) expect(current.conversations[`child-${index}`].parentId).toBe("parent");
        observations++;
      }
      return manifest;
    } });
    const initial = state("parent", "Z original parent");
    for (let index = 0; index < 44; index++) {
      const id = `child-${index}`;
      const child = state(id, `Child ${index}`).conversations[id];
      initial.conversations[id] = { ...child, parentId: "parent" };
      initial.conversations.parent.childIds.push(id);
    }
    await writer.edit(stateToVaultFiles(initial, {}), {}); await writer.sync(); await observer.sync();
    await edit(writer, (current) => { current.conversations.parent.title = "A renamed parent"; });
    monitor = true;
    await writer.sync();
    expect(observations).toBeGreaterThan(1);
  });

  test("an externally chosen custom path survives reopening and a later app title change", async () => {
    const remote = cloud(); const original = remote.device();
    await original.edit(stateToVaultFiles(state(), {}), {}); await original.sync();
    const before = await original.read();
    const oldPath = record(before).path;
    const customPath = "Research/My chosen filename.md";
    const renamed = { ...before.files, [customPath]: before.files[oldPath] }; delete renamed[oldPath];
    await original.edit(renamed, before.files); await original.sync();
    const reopened = remote.device(); await reopened.sync();
    expect(record(await reopened.read()).path).toBe(customPath);
    await edit(reopened, (current) => { current.conversations.document.title = "Changed in application"; });
    const after = await reopened.read();
    expect(record(after).path).toBe(customPath);
    expect(after.files[oldPath]).toBeUndefined();
    expect(body(after).title).toBe("Changed in application");
  });

  test("an older title archive collides by identity and retains the live title path and both writings", async () => {
    const remote = cloud(); const device = remote.device();
    const archive = stateToVaultFiles(state(), {});
    await device.edit(archive, {}); await device.sync();
    const oldPath = record(await device.read()).path;
    await edit(device, (current) => { current.conversations.document.title = "Current title"; current.conversations.document.document!.blocks[0].content = "Latest writing."; });
    const live = await device.read();
    const imported = await device.import(archive);
    expect(record(imported).path).toBe(record(live).path);
    expect(imported.files[oldPath]).toBeUndefined();
    expect(body(imported).document!.blocks[0].content).toBe("Latest writing.");
    expect(workspaceFromVault(imported.files).manifest.files).toHaveLength(1);
    expect(imported.conflicts.some((item) => item.path === record(live).path && item.sourcePath === oldPath
      && item.local?.content.includes("Original paragraph.") && item.remote?.content.includes("Latest writing."))).toBe(true);
  });

  test.each([{ external: false }, { external: true }])("restoring an older title archive retains current filename ownership: %j", async ({ external }) => {
    const remote = cloud(); const device = remote.device();
    const archive = stateToVaultFiles(state(), {});
    await device.edit(archive, {}); await device.sync();
    await edit(device, (current) => { current.conversations.document.title = "Current title"; });
    const customPath = "Archive/My chosen restored document.md";
    if (external) {
      const before = await device.read();
      const previousPath = record(before).path;
      const renamed = { ...before.files, [customPath]: before.files[previousPath] }; delete renamed[previousPath];
      await device.edit(renamed, before.files);
    }
    const imported = await device.import(archive);
    const conflict = imported.conflicts.find((item) => item.path === record(imported).path)!;
    await device.resolve(conflict.id, "local");
    expect(body(await device.read()).document!.blocks[0].content).toBe("Original paragraph.");
    await edit(device, (current) => { current.conversations.document.title = "Restored then renamed"; });
    expect(record(await device.read()).path).toBe(external ? customPath : titleMarkdownPath("Chats", "Restored then renamed", "document"));
  });
});
