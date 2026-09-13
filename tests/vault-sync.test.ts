import { describe, expect, test } from "bun:test";
import { VaultSync, pendingVaultChanges } from "../client/src/lib/vaultSync";
import { exportVault, importVault } from "../client/src/lib/vaultLocal";
import { emptyVault, type VaultFile, type VaultManifest, type VaultSnapshot, type VaultStore, type VaultTransport } from "../client/src/lib/vaultTypes";
import { createVaultService } from "../server/vault/index.mjs";
import { digest } from "../server/vault/storage.mjs";

const file = (content: string): VaultFile => ({ content });
function deferred<T = void>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

function store(initial: VaultSnapshot | null = null): VaultStore {
  let snapshot = structuredClone(initial);
  let tail = Promise.resolve();
  return {
    async read() { return structuredClone(snapshot); },
    async write(value) { snapshot = structuredClone(value); },
    lock<T>(operation: () => Promise<T>): Promise<T> {
      const current = tail.then(operation);
      tail = current.then(() => undefined, () => undefined);
      return current;
    },
  };
}

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
  const normalize = (manifest: any): VaultManifest => ({ ...manifest, files: Object.fromEntries(Object.entries(manifest.files).map(([path, entry]: [string, any]) => [path, { ...entry, encoding: entry.encoding === "base64" ? "base64" : undefined }])) });
  const transport: VaultTransport = {
    async manifest() { return normalize((await server.status("user")).manifest); },
    async read(path, entry) {
      const { bytes } = await server.readFile({ userId: "user", path, revision: entry.revision });
      return { content: bytes.toString(entry.encoding === "base64" ? "base64" : "utf8"), ...(entry.encoding ? { encoding: entry.encoding } : {}), contentType: entry.contentType };
    },
    async commit(changes) { return normalize((await server.commit("user", changes)).manifest); },
  };
  return { server, transport, device: () => new VaultSync(store(), transport) };
}

async function replace(device: VaultSync, path: string, content: string | null) {
  const previous = (await device.read()).files;
  const next = { ...previous };
  if (content === null) delete next[path]; else next[path] = file(content);
  return device.edit(next, previous);
}

describe("multi-device Markdown sync", () => {
  test("offline edits to different notes converge without replacing the other device's files", async () => {
    const remote = cloud(); const computer = remote.device(); const phone = remote.device();
    await computer.edit({ "a.md": file("A0"), "b.md": file("B0") }, {});
    await computer.sync(); await phone.sync();
    await replace(computer, "a.md", "A1 offline on computer");
    await replace(phone, "b.md", "B1 offline on phone");
    await computer.sync(); await phone.sync(); await computer.sync();
    expect((await phone.read()).files["a.md"].content).toBe("A1 offline on computer");
    expect((await computer.read()).files["b.md"].content).toBe("B1 offline on phone");
    expect((await phone.read()).conflicts).toHaveLength(0);
    expect(pendingVaultChanges(await computer.read())).toHaveLength(0);
  });

  test("same-note offline edits retain both revisions in portable conflict copies", async () => {
    const remote = cloud(); const computer = remote.device(); const phone = remote.device();
    await replace(computer, "note.md", "base"); await computer.sync(); await phone.sync();
    await replace(computer, "note.md", "computer edit"); await replace(phone, "note.md", "phone edit");
    await computer.sync(); const conflicted = await phone.sync();
    expect(conflicted.files["note.md"].content).toBe("computer edit");
    expect(conflicted.conflicts).toHaveLength(1);
    expect(conflicted.conflicts[0].local?.content).toBe("phone edit");
    expect(Object.entries(conflicted.files).some(([path, value]) => path.startsWith("_conflicts/") && value.content === "phone edit")).toBe(true);
    await phone.resolve(conflicted.conflicts[0].id, "local"); await phone.sync(); await computer.sync();
    expect((await computer.read()).files["note.md"].content).toBe("phone edit");
  });

  test("a source named conflict.json keeps its local JSON separately from the conflict descriptor", async () => {
    const remote = cloud(); const computer = remote.device(); const phone = remote.device();
    const path = "Settings/conflict.json";
    const local = JSON.stringify({ source: "phone", keep: "all authored JSON" });
    const incoming = JSON.stringify({ source: "computer" });
    await replace(computer, path, JSON.stringify({ source: "base" })); await computer.sync(); await phone.sync();
    await replace(computer, path, incoming); await replace(phone, path, local); await computer.sync();
    const conflicted = await phone.sync();
    const id = conflicted.conflicts[0].id;
    const descriptorPath = `_conflicts/${id}/conflict.json`;
    const copyPath = `_conflicts/${id}/local/conflict.json`;
    expect(JSON.parse(conflicted.files[descriptorPath].content)).toMatchObject({ path, copy: copyPath });
    expect(conflicted.files[copyPath].content).toBe(local);
    expect(conflicted.files[path].content).toBe(incoming);
    const exported = importVault(exportVault(conflicted));
    expect(exported[copyPath].content).toBe(local);
    const fresh = remote.device(); await fresh.sync();
    expect((await fresh.read()).files[copyPath].content).toBe(local);
    expect(JSON.parse((await fresh.read()).files[descriptorPath].content).copy).toBe(copyPath);
  });

  test("an unchanged stale device downloads newer content without uploading the old workspace", async () => {
    const remote = cloud(); const source = remote.device(); const stale = remote.device();
    await replace(source, "note.md", "old"); await source.sync(); await stale.sync();
    await replace(source, "note.md", "new"); await source.sync();
    const before = (await remote.transport.manifest()).revision;
    await stale.sync();
    expect((await stale.read()).files["note.md"].content).toBe("new");
    expect((await remote.transport.manifest()).revision).toBe(before);
  });

  test("a later edit can be kept when dismissing an older conflict without losing recovery copies", async () => {
    const remote = cloud(); const a = remote.device(); const b = remote.device();
    await replace(a, "note.md", "base"); await a.sync(); await b.sync();
    await replace(a, "note.md", "remote"); await replace(b, "note.md", "offline"); await a.sync();
    const conflict = (await b.sync()).conflicts[0];
    await replace(b, "note.md", "newer intentional edit");
    await expect(b.resolve(conflict.id, "local")).rejects.toThrow("changed again");
    const kept = await b.resolve(conflict.id, "current");
    expect(kept.conflicts).toHaveLength(0);
    expect(kept.files["note.md"].content).toBe("newer intentional edit");
    expect(Object.entries(kept.files).some(([path, value]) => path.startsWith("_conflicts/") && value.content === "offline")).toBe(true);
    await b.sync(); await a.sync();
    expect((await a.read()).files["note.md"].content).toBe("newer intentional edit");
  });

  test("deletions propagate while an offline edit of a deleted note is preserved as a conflict", async () => {
    const remote = cloud(); const a = remote.device(); const b = remote.device(); const idle = remote.device();
    await replace(a, "note.md", "base"); await a.sync(); await b.sync(); await idle.sync();
    await replace(a, "note.md", null); await replace(b, "note.md", "offline text"); await a.sync();
    await idle.sync(); expect((await idle.read()).files["note.md"]).toBeUndefined();
    const conflict = await b.sync();
    expect(conflict.files["note.md"]).toBeUndefined();
    expect(conflict.conflicts[0].local?.content).toBe("offline text");
    expect(conflict.conflicts[0].remote).toBeNull();
    expect((await remote.transport.manifest()).files["note.md"].deleted).toBe(true);
  });

  test("typing saves immediately while a manifest request is pending", async () => {
    const remote = cloud(); const storage = store();
    const requested = deferred(); const release = deferred(); let first = true;
    const device = new VaultSync(storage, { ...remote.transport, async manifest() {
      if (first) { first = false; requested.resolve(); await release.promise; }
      return remote.transport.manifest();
    } });
    const syncing = device.sync(); await requested.promise;
    await replace(device, "note.md", "saved while offline fetch waits");
    expect((await storage.read())?.files["note.md"].content).toBe("saved while offline fetch waits");
    release.resolve(); await syncing;
    expect(pendingVaultChanges(await device.read())).toHaveLength(0);
  });

  test("typing during upload remains pending against the acknowledged body and uploads next", async () => {
    const remote = cloud(); const storage = store();
    const requested = deferred(); const release = deferred(); const sent: any[] = []; let blocked = true;
    const device = new VaultSync(storage, { ...remote.transport, async commit(changes) {
      sent.push(structuredClone(changes));
      if (blocked) { blocked = false; requested.resolve(); await release.promise; }
      return remote.transport.commit(changes);
    } });
    await replace(device, "note.md", "first draft");
    const syncing = device.sync(); await requested.promise;
    await replace(device, "note.md", "continued typing");
    expect((await storage.read())?.files["note.md"].content).toBe("continued typing");
    release.resolve(); await syncing;
    expect(sent.map((batch) => batch.find((item: any) => item.path === "note.md")?.content)).toEqual(["first draft", "continued typing"]);
    expect(sent[0][0].baseRevision).toBeNull(); expect(sent[1][0].baseRevision).toBeTruthy();
    expect((await device.read()).conflicts).toHaveLength(0);
    expect((await remote.server.readFile({ userId: "user", path: "note.md" })).bytes.toString()).toBe("continued typing");
  });

  test("failed uploads keep pending content durable across a new sync instance", async () => {
    const remote = cloud(); const storage = store();
    const offline = new VaultSync(storage, { ...remote.transport, async commit() { throw new Error("offline"); } });
    await replace(offline, "note.md", "durable pending edit");
    await expect(offline.sync()).rejects.toThrow("offline");
    expect(pendingVaultChanges((await storage.read())!)).toHaveLength(1);
    const reopened = new VaultSync(storage, remote.transport); await reopened.sync();
    expect(pendingVaultChanges(await reopened.read())).toHaveLength(0);
    expect((await reopened.read()).files["note.md"].content).toBe("durable pending edit");
  });

  test("a delayed manifest does not roll back another tab's newer downloaded revision", async () => {
    const remote = cloud(); const source = remote.device(); const storage = store();
    await replace(source, "note.md", "old"); await source.sync();
    const tab = new VaultSync(storage, remote.transport); await tab.sync();
    const requested = deferred(); const release = deferred(); let first = true;
    const delayed = new VaultSync(storage, { ...remote.transport, async manifest() {
      const value = await remote.transport.manifest();
      if (first) { first = false; requested.resolve(); await release.promise; }
      return value;
    } });
    const syncing = delayed.sync(); await requested.promise;
    await replace(source, "note.md", "new"); await source.sync(); await tab.sync();
    release.resolve(); await syncing;
    expect((await delayed.read()).files["note.md"].content).toBe("new");
    expect((await delayed.read()).conflicts).toHaveLength(0);
  });

  test("a delayed commit acknowledgement cannot undo a later tab's base or content", async () => {
    const remote = cloud(); const storage = store();
    const committed = deferred(); const release = deferred(); let first = true;
    const delayed = new VaultSync(storage, { ...remote.transport, async commit(changes) {
      const response = await remote.transport.commit(changes);
      if (first) { first = false; committed.resolve(); await release.promise; }
      return response;
    } });
    await replace(delayed, "note.md", "first"); const syncing = delayed.sync(); await committed.promise;
    const tab = new VaultSync(storage, remote.transport); await tab.sync();
    await replace(tab, "note.md", "newer tab edit"); await tab.sync();
    const currentRevision = (await tab.read()).base["note.md"].revision;
    release.resolve(); await syncing;
    const final = await delayed.read();
    expect(final.files["note.md"].content).toBe("newer tab edit");
    expect(final.base["note.md"].revision).toBe(currentRevision);
    expect(pendingVaultChanges(final)).toHaveLength(0);
  });

  test("a downloaded portable vault initializes another device without dropping arbitrary Markdown or attachment bytes", async () => {
    const remote = cloud(); const original = remote.device();
    await original.edit({ "Journal/day.md": file("---\ntitle: Journal\n---\n\n# Ordinary Markdown"), "Attachments/photo.bin": { content: "AP8B", encoding: "base64" } }, {});
    const imported = importVault(exportVault(await original.read()));
    const fresh = remote.device(); await fresh.edit(imported, {}); await fresh.sync();
    const phone = remote.device(); await phone.sync();
    expect((await phone.read()).files["Journal/day.md"].content).toBe(imported["Journal/day.md"].content);
    expect((await phone.read()).files["Attachments/photo.bin"].content).toBe("AP8B");
    expect((await phone.read()).conflicts).toHaveLength(0);
  });
});
