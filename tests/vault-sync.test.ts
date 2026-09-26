import { describe, expect, test } from "bun:test";
import { VaultSync, pendingVaultChanges } from "../client/src/lib/vaultSync";
import { exportVault, importVault } from "../client/src/lib/vaultLocal";
import { emptyVault, type VaultFile, type VaultManifest, type VaultSnapshot, type VaultStore, type VaultTransport } from "../client/src/lib/vaultTypes";
import { createVaultService } from "../server/vault/index.mjs";
import { digest } from "../server/vault/storage.mjs";
import { createEmptyState } from "../client/src/initialState";
import { stateToVaultFiles, vaultToState } from "../client/src/lib/vaultWorkspace";

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
  const identified = (id: string, content: string) => file(`---\nmargin-chat-id: ${id}\n---\n${content}`);

  test("an older-path archive preserves the live document and both conflict copies without duplicating its identity", async () => {
    const remote = cloud(); const device = remote.device();
    const latest = identified("stable-note", "Latest user writing.");
    const older = identified("stable-note", "Older exported writing.");
    await device.edit({ "Notes/renamed.md": latest }, {});
    const imported = await device.import({ "Notes/original.md": older, "Attachments/original.bin": { content: "AP8B", encoding: "base64" } });
    expect(imported.files["Notes/renamed.md"]).toEqual(latest);
    expect(imported.files["Notes/original.md"]).toBeUndefined();
    expect(imported.conflicts).toHaveLength(1);
    expect(imported.conflicts[0]).toMatchObject({ path: "Notes/renamed.md", sourcePath: "Notes/original.md", local: older, remote: latest });
    const exported = importVault(exportVault(imported));
    const descriptor = JSON.parse(exported[`_conflicts/${imported.conflicts[0].id}/conflict.json`].content);
    expect(exported[descriptor.copy]).toEqual(older);
    expect(exported[descriptor.remoteCopy]).toEqual(latest);
    expect(exported["Attachments/original.bin"].content).toBe("AP8B");
    await device.resolve(imported.conflicts[0].id, "local");
    await device.sync();
    expect((await device.read()).files["Notes/renamed.md"]).toEqual(older);
  });

  test("a directory rename moves concurrent local edits and preserves divergent disk edits as conflicts", async () => {
    const remote = cloud(); const device = remote.device();
    const initial = identified("moving", "Original.");
    const latest = identified("moving", "Unsynced local writing.");
    const external = identified("moving", "External folder writing.");
    await device.edit({ "Old.md": initial }, {});
    await device.edit({ "Old.md": latest }, { "Old.md": initial });
    const merged = await device.edit({ "New.md": external }, { "Old.md": initial });
    expect(merged.files["Old.md"]).toBeUndefined();
    expect(merged.files["New.md"]).toEqual(latest);
    expect(merged.conflicts[0]).toMatchObject({ path: "New.md", local: external, remote: latest });
  });

  test("an invalid complete working set never replaces a durable valid snapshot", async () => {
    const remote = cloud(); const storage = store(); const device = new VaultSync(storage, remote.transport);
    const original = identified("duplicate", "Keep original.");
    await device.edit({ "Original.md": original }, {});
    const before = await device.read();
    await expect(device.edit({ "Copied.md": original }, {})).rejects.toThrow("Duplicate");
    expect(await device.read()).toEqual(before);
    const invalidCloud = new VaultSync(storage, {
      async manifest() { return { schemaVersion: 1, revision: 1, files: { "Original.md": { revision: "copy", deleted: false }, "Copied.md": { revision: "copy", deleted: false } } }; },
      async read() { return original; },
      async commit() { throw new Error("Invalid files must not upload"); },
    });
    await expect(invalidCloud.sync()).rejects.toThrow("Duplicate");
    expect(await device.read()).toEqual(before);
  });

  test("a folder rename cannot silently resurrect a locally deleted document", async () => {
    const device = cloud().device();
    const original = identified("deleted", "Recoverable renamed document.");
    await device.edit({ "Old.md": original }, {});
    await device.edit({}, { "Old.md": original });
    const merged = await device.edit({ "New.md": original }, { "Old.md": original });
    expect(merged.files["Old.md"]).toBeUndefined();
    expect(merged.files["New.md"]).toBeUndefined();
    expect(merged.conflicts[0]).toMatchObject({ path: "New.md", local: original, remote: null });
    expect((await device.resolve(merged.conflicts[0].id, "local")).files["New.md"]).toEqual(original);
  });

  test("every cloud batch keeps a renamed document's old and new paths atomic", async () => {
    const remote = cloud();
    const observer = remote.device();
    const commits: string[][] = [];
    const device = new VaultSync(store(), { ...remote.transport, async commit(changes) {
      const committed = await remote.transport.commit(changes);
      commits.push(changes.map((change) => change.path));
      // A second device can observe every manifest, including between batches.
      await observer.sync();
      return committed;
    } });
    const original = identified("renamed-across-batch", "Do not duplicate this identity.");
    await device.edit({ "Z-original.md": original }, {});
    await device.sync();
    commits.length = 0;
    const previous = (await device.read()).files;
    await device.edit({
      "A-renamed.md": original,
      ...Object.fromEntries(Array.from({ length: 40 }, (_, index) => [`M-${String(index).padStart(2, "0")}.md`, identified(`other-${index}`, "Other note")])),
    }, previous);
    await device.sync();
    expect(commits.length).toBeGreaterThan(1);
    for (const paths of commits) expect(paths.includes("A-renamed.md")).toBe(paths.includes("Z-original.md"));
    expect((await observer.read()).files["Z-original.md"]).toBeUndefined();
    expect((await observer.read()).files["A-renamed.md"].content).toBe(original.content);
    expect((await observer.read()).conflicts).toHaveLength(0);
  });

  test("a connected cycle of renames stays atomic when it exceeds the usual batch count", async () => {
    const remote = cloud(); const observer = remote.device();
    const sizes: number[] = [];
    const device = new VaultSync(store(), { ...remote.transport, async commit(changes) {
      const committed = await remote.transport.commit(changes);
      sizes.push(changes.length);
      await observer.sync();
      return committed;
    } });
    const notes = Array.from({ length: 41 }, (_, index) => identified(`cycle-${index}`, `Note ${index}.`));
    await device.edit(Object.fromEntries(notes.map((note, index) => [`Note-${index}.md`, note])), {});
    await device.sync();
    sizes.length = 0;
    await device.edit(Object.fromEntries(notes.map((_, index) => [`Note-${index}.md`, notes[(index + 1) % notes.length]])), (await device.read()).files);
    await device.sync();
    expect(sizes).toEqual([41]);
    expect((await observer.read()).files["Note-0.md"].content).toBe(notes[1].content);
    expect((await observer.read()).conflicts).toHaveLength(0);
  });

  test("a cloud rename carries offline writing automatically to the surviving document path", async () => {
    const remote = cloud(); const cloudDevice = remote.device(); const offlineDevice = remote.device();
    const original = identified("cloud-move", "Original.");
    const local = identified("cloud-move", "Offline writing.");
    await cloudDevice.edit({ "Old.md": original }, {});
    await cloudDevice.sync(); await offlineDevice.sync();
    await offlineDevice.edit({ "Old.md": local }, (await offlineDevice.read()).files);
    await cloudDevice.edit({ "Renamed.md": original }, (await cloudDevice.read()).files);
    await cloudDevice.sync();
    const merged = await offlineDevice.sync();
    expect(merged.files["Old.md"]).toBeUndefined();
    expect(merged.files["Renamed.md"].content).toBe(local.content);
    expect(merged.conflicts).toHaveLength(0);
    await offlineDevice.sync(); await cloudDevice.sync();
    expect((await cloudDevice.read()).files["Renamed.md"].content).toBe(local.content);
  });

  test("a local rename and a cloud edit preserve both versions without duplicate identities", async () => {
    const remote = cloud(); const cloudDevice = remote.device(); const offlineDevice = remote.device();
    const original = identified("local-move", "Original.");
    const updated = identified("local-move", "Updated on another device.");
    await cloudDevice.edit({ "Old.md": original }, {});
    await cloudDevice.sync(); await offlineDevice.sync();
    await offlineDevice.edit({ "Renamed.md": original }, (await offlineDevice.read()).files);
    await cloudDevice.edit({ "Old.md": updated }, (await cloudDevice.read()).files);
    await cloudDevice.sync();
    const merged = await offlineDevice.sync();
    expect(merged.files["Renamed.md"]).toBeUndefined();
    expect(merged.files["Old.md"].content).toBe(updated.content);
    expect(merged.conflicts[0]).toMatchObject({ path: "Old.md", local: { content: original.content }, remote: { content: updated.content } });
    await offlineDevice.resolve(merged.conflicts[0].id, "local");
    await offlineDevice.sync();
  });

  test("a cloud deletion conflicts with an offline rename instead of resurrecting the document", async () => {
    const remote = cloud(); const first = remote.device(); const second = remote.device();
    const original = identified("deleted-during-rename", "Original.");
    await first.edit({ "Old.md": original }, {}); await first.sync(); await second.sync();
    await second.edit({ "Renamed.md": original }, (await second.read()).files);
    await first.edit({}, (await first.read()).files); await first.sync();
    const merged = await second.sync();
    expect(merged.files["Renamed.md"]).toBeUndefined();
    expect(merged.conflicts[0]).toMatchObject({ path: "Renamed.md", local: { content: original.content }, remote: null });
    expect((await remote.transport.manifest()).files["Renamed.md"]).toBeUndefined();
  });

  test("a restored device reconciles shared identities at different paths without a common base", async () => {
    const remote = cloud(); const first = remote.device(); const restored = remote.device();
    await first.edit({ "Cloud.md": identified("restored", "Cloud copy.") }, {}); await first.sync();
    await restored.edit({ "Archive.md": identified("restored", "Older archive copy.") }, {});
    const merged = await restored.sync();
    expect(merged.files["Archive.md"]).toBeUndefined();
    expect(merged.files["Cloud.md"].content).toContain("Cloud copy.");
    expect(merged.conflicts[0]).toMatchObject({ path: "Cloud.md", local: { content: identified("restored", "Older archive copy.").content } });
    await restored.resolve(merged.conflicts[0].id, "local"); await restored.sync();
  });

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

  test("three offline devices combine independent passages without requiring recovery review", async () => {
    const remote = cloud(); const a = remote.device(); const b = remote.device(); const c = remote.device();
    const original = "Owner: Alice\n\nDate: Monday\n\nVenue: Office\n";
    await replace(a, "Plan.md", original); await a.sync(); await b.sync(); await c.sync();
    await replace(a, "Plan.md", original.replace("Alice", "Bob"));
    await replace(b, "Plan.md", original.replace("Monday", "Tuesday"));
    await replace(c, "Plan.md", original.replace("Office", "Park"));
    await a.sync(); await b.sync(); await c.sync(); await a.sync(); await b.sync();
    for (const device of [a, b, c]) {
      const snapshot = await device.read();
      expect(snapshot.files["Plan.md"].content).toBe("Owner: Bob\n\nDate: Tuesday\n\nVenue: Park\n");
      expect(snapshot.conflicts).toHaveLength(0);
      expect(pendingVaultChanges(snapshot)).toHaveLength(0);
    }
    const before = await c.read();
    await c.sync(); await c.sync();
    expect(await c.read()).toEqual(before);
    const receipts = Object.entries(before.files).filter(([path]) => /\/conflict\.json$/.test(path));
    expect(receipts).toHaveLength(2);
    for (const [, receipt] of receipts) {
      const record = JSON.parse(receipt.content);
      expect(record.conflicted).toBe(false);
      for (const key of ["baseCopy", "copy", "remoteCopy", "resultCopy"]) expect(before.files[record[key]]).toBeDefined();
    }
  });

  test("eight offline devices converge in different reconnect orders and under simultaneous uploads", async () => {
    const original = Array.from({ length: 8 }, (_, index) => `Section ${index}: original.`).join("\n\n");
    const expected = Array.from({ length: 8 }, (_, index) => `Section ${index}: device${index}.`).join("\n\n");
    for (const order of [[0, 1, 2, 3, 4, 5, 6, 7], [7, 6, 5, 4, 3, 2, 1, 0], [3, 0, 6, 2, 7, 1, 5, 4], null]) {
      const remote = cloud(); const devices = Array.from({ length: 8 }, () => remote.device());
      await replace(devices[0], "Shared.md", original); await devices[0].sync();
      await Promise.all(devices.slice(1).map((device) => device.sync()));
      for (const [index, device] of devices.entries()) {
        await replace(device, "Shared.md", original.replace(`Section ${index}: original.`, `Section ${index}: device${index}.`));
      }
      if (order) for (const index of order) await devices[index].sync();
      else {
        // A bounded busy-cloud retry can yield; the scheduled next sync must finish safely.
        const results = await Promise.allSettled(devices.map((device) => device.sync()));
        for (const result of results) if (result.status === "rejected") expect(result.reason.message).toContain("sync will retry");
      }
      for (const device of devices) await device.sync();
      for (const device of devices) await device.sync();
      for (const device of devices) {
        const snapshot = await device.read();
        expect(snapshot.files["Shared.md"].content).toBe(expected);
        expect(snapshot.conflicts).toHaveLength(0);
        expect(pendingVaultChanges(snapshot)).toHaveLength(0);
      }
      const settled = await devices[0].read();
      expect(await devices[0].sync()).toEqual(settled);
    }
  });

  test("eight conflicting devices preserve every submitted version while independent edits still combine", async () => {
    const remote = cloud(); const devices = Array.from({ length: 8 }, () => remote.device());
    const original = "Launch Friday.\n\n" + Array.from({ length: 8 }, (_, index) => `Section ${index}: original.`).join("\n\n");
    const days = ["Monday", "Tuesday", "Wednesday", "Thursday", "Saturday", "Sunday", "Tomorrow", "Today"];
    await replace(devices[0], "Shared.md", original); await devices[0].sync();
    await Promise.all(devices.slice(1).map((device) => device.sync()));
    const authored = days.map((day, index) => original.replace("Friday", day).replace(`Section ${index}: original.`, `Section ${index}: device${index}.`));
    for (const [index, device] of devices.entries()) await replace(device, "Shared.md", authored[index]);
    for (const index of [3, 0, 6, 2, 7, 1, 5, 4]) await devices[index].sync();
    for (const device of devices) await device.sync();
    const expected = "Launch Thursday.\n\n" + Array.from({ length: 8 }, (_, index) => `Section ${index}: device${index}.`).join("\n\n");
    for (const device of devices) {
      const snapshot = await device.read();
      expect(snapshot.files["Shared.md"].content).toBe(expected);
      expect(pendingVaultChanges(snapshot)).toHaveLength(0);
      const preserved = new Set(Object.values(snapshot.files).map((entry) => entry.content));
      for (const version of authored) expect(preserved.has(version)).toBe(true);
    }
  });

  test("editable document blocks merge through the app codec and survive reopening and subsequent saving", async () => {
    const remote = cloud(); const a = remote.device(); const b = remote.device();
    const state = createEmptyState(); const id = state.rootId;
    const stamp = "2026-09-25T12:00:00.000Z";
    state.conversations[id].document = { schemaVersion: 1,
      blocks: ["First paragraph.", "Second paragraph."].map((content, index) => ({
        id: `block-${index}`, kind: "markdown" as const, content, createdAt: stamp, updatedAt: stamp,
      })), prompts: [], generations: [] };
    await a.edit(stateToVaultFiles(state, {}), {}); await a.sync(); await b.sync();
    const local = structuredClone(state); local.conversations[id].document!.blocks[0].content = "First paragraph, edited on device A.";
    const other = structuredClone(state); other.conversations[id].document!.blocks[1].content = "Second paragraph, edited on device B.";
    const aFiles = (await a.read()).files; const bFiles = (await b.read()).files;
    await a.edit(stateToVaultFiles(local, aFiles), aFiles);
    await b.edit(stateToVaultFiles(other, bFiles), bFiles);
    await a.sync(); await b.sync(); await a.sync();
    for (const device of [a, b]) {
      const snapshot = await device.read();
      const reopened = vaultToState(snapshot.files, state);
      expect(reopened.conversations[id].document!.blocks.map((block) => block.content)).toEqual([
        "First paragraph, edited on device A.", "Second paragraph, edited on device B.",
      ]);
      expect(snapshot.conflicts).toHaveLength(0);
      await device.edit(stateToVaultFiles(reopened, snapshot.files), snapshot.files);
      expect(pendingVaultChanges(await device.read())).toHaveLength(0);
    }
  });

  test("an overlapping passage keeps unrelated edits and allows restoring either complete input", async () => {
    const remote = cloud(); const a = remote.device(); const b = remote.device();
    const original = "Launch Friday.\n\nOwner: Alice.\n\nVenue: Office.\n";
    const local = original.replace("Friday", "Monday").replace("Alice", "Bob");
    const synced = original.replace("Friday", "Tuesday").replace("Office", "Park");
    await replace(a, "Plan.md", original); await a.sync(); await b.sync();
    await replace(a, "Plan.md", synced); await replace(b, "Plan.md", local); await a.sync();
    const merged = await b.sync();
    expect(merged.files["Plan.md"].content).toBe("Launch Tuesday.\n\nOwner: Bob.\n\nVenue: Park.\n");
    expect(merged.conflicts).toHaveLength(1);
    const saved = merged.conflicts[0];
    expect(saved.base?.content).toBe(original);
    expect(saved.result).toEqual(merged.files["Plan.md"]);
    expect(pendingVaultChanges(merged)).toHaveLength(0);
    const fresh = remote.device();
    expect((await fresh.sync()).conflicts[0].id).toBe(saved.id);
    const restored = await b.resolve(saved.id, "remote");
    expect(restored.files["Plan.md"].content).toBe(synced);
    await b.sync(); await b.sync();
    expect((await b.read()).conflicts).toHaveLength(0);
    expect((await b.read()).dismissedRecoveryIds).toContain(saved.id);
    expect((await fresh.resolve(saved.id, "local")).files["Plan.md"].content).toBe(local);
  });

  test("recovery uploads finish before merged documents, including failure between archive batches", async () => {
    const remote = cloud(); const a = remote.device(); const localStore = store();
    let archiveBatches = 0; let interrupt = true;
    const b = new VaultSync(localStore, { ...remote.transport, async commit(changes) {
      if (changes.some((change) => change.path.startsWith("_conflicts/"))) {
        expect(changes.every((change) => change.path.startsWith("_conflicts/"))).toBe(true);
        archiveBatches++;
        if (archiveBatches === 2 && interrupt) throw new Error("Interrupted recovery upload");
      }
      return remote.transport.commit(changes);
    } });
    const original = "Owner: Alice\n\nVenue: Office\n";
    const notes = Object.fromEntries(Array.from({ length: 12 }, (_, index) => [`Note-${index}.md`, file(original)]));
    await a.edit(notes, {}); await a.sync(); await b.sync();
    await a.edit(Object.fromEntries(Object.keys(notes).map((path) => [path, file(original.replace("Alice", "Bob"))])), (await a.read()).files);
    await b.edit(Object.fromEntries(Object.keys(notes).map((path) => [path, file(original.replace("Office", "Park"))])), (await b.read()).files);
    await a.sync();
    await expect(b.sync()).rejects.toThrow("Interrupted recovery upload");
    const manifest = await remote.transport.manifest();
    expect((await remote.transport.read("Note-0.md", manifest.files["Note-0.md"])).content).toBe("Owner: Bob\n\nVenue: Office\n");
    const local = await b.read();
    expect(local.files["Note-0.md"].content).toBe("Owner: Bob\n\nVenue: Park\n");
    expect(Object.keys(local.files).filter((path) => /\/conflict\.json$/.test(path))).toHaveLength(12);
    interrupt = false;
    const reopened = new VaultSync(localStore, b.transport);
    await reopened.sync(); await a.sync();
    expect((await a.read()).files["Note-0.md"].content).toBe("Owner: Bob\n\nVenue: Park\n");
    expect(Object.keys((await reopened.read()).files).filter((path) => /\/conflict\.json$/.test(path))).toHaveLength(12);
  });

  test("a third device racing the result commit rebases automatically and converges", async () => {
    const remote = cloud(); const a = remote.device(); const c = remote.device();
    let race = false;
    const b = new VaultSync(store(), { ...remote.transport, async commit(changes) {
      if (race && changes.some((change) => change.path === "Plan.md")) { race = false; await c.sync(); }
      return remote.transport.commit(changes);
    } });
    const original = "Owner: Alice\n\nDate: Monday\n\nVenue: Office\n";
    await replace(a, "Plan.md", original); await a.sync(); await b.sync(); await c.sync();
    await replace(a, "Plan.md", original.replace("Alice", "Bob"));
    await replace(b, "Plan.md", original.replace("Monday", "Tuesday"));
    await replace(c, "Plan.md", original.replace("Office", "Park"));
    await a.sync(); race = true;
    await b.sync(); await a.sync(); await c.sync();
    for (const device of [a, b, c]) {
      expect((await device.read()).files["Plan.md"].content).toBe("Owner: Bob\n\nDate: Tuesday\n\nVenue: Park\n");
      expect(pendingVaultChanges(await device.read())).toHaveLength(0);
    }
  });

  test("a failed durable recovery save publishes neither the result nor its new base", async () => {
    const remote = cloud(); const a = remote.device(); const storage = store();
    let failSave = false; let commits = 0;
    const b = new VaultSync({ ...storage, async write(snapshot) {
      if (failSave && Object.keys(snapshot.files).some((path) => path.startsWith("_conflicts/"))) throw new Error("Storage full");
      await storage.write(snapshot);
    } }, { ...remote.transport, async commit(changes) { commits++; return remote.transport.commit(changes); } });
    const original = "Owner: Alice\n\nVenue: Office\n";
    await replace(a, "Plan.md", original); await a.sync(); await b.sync();
    await replace(a, "Plan.md", original.replace("Alice", "Bob"));
    await replace(b, "Plan.md", original.replace("Office", "Park"));
    await a.sync(); const before = await b.read(); commits = 0; failSave = true;
    await expect(b.sync()).rejects.toThrow("Storage full");
    expect(await b.read()).toEqual(before);
    expect(commits).toBe(0);
    failSave = false;
    expect((await b.sync()).files["Plan.md"].content).toBe("Owner: Bob\n\nVenue: Park\n");
  });

  test("a lost result acknowledgement is recovered without duplicating text or recovery records", async () => {
    const remote = cloud(); const a = remote.device(); const localStore = store(); let loseResponse = false;
    const b = new VaultSync(localStore, { ...remote.transport, async commit(changes) {
      const manifest = await remote.transport.commit(changes);
      if (loseResponse && changes.some((change) => change.path === "Plan.md")) {
        loseResponse = false; throw new Error("Connection closed after commit");
      }
      return manifest;
    } });
    const original = "Owner: Alice\n\nVenue: Office\n";
    await replace(a, "Plan.md", original); await a.sync(); await b.sync();
    await replace(a, "Plan.md", original.replace("Alice", "Bob"));
    await replace(b, "Plan.md", original.replace("Office", "Park"));
    await a.sync(); loseResponse = true;
    await expect(b.sync()).rejects.toThrow("Connection closed after commit");
    const reopened = new VaultSync(localStore, remote.transport);
    const recovered = await reopened.sync();
    expect(recovered.files["Plan.md"].content).toBe("Owner: Bob\n\nVenue: Park\n");
    expect(Object.keys(recovered.files).filter((path) => /\/conflict\.json$/.test(path))).toHaveLength(1);
    expect(pendingVaultChanges(recovered)).toHaveLength(0);
    expect(await reopened.sync()).toEqual(recovered);
  });

  test("another device can restore an alternative when recovery uploaded but the working result never did", async () => {
    const remote = cloud(); const a = remote.device(); let interrupt = false;
    const b = new VaultSync(store(), { ...remote.transport, async commit(changes) {
      if (interrupt && changes.some((change) => change.path === "Plan.md")) throw new Error("Device disconnected");
      return remote.transport.commit(changes);
    } });
    const original = "Launch Friday.\n\nOwner: Alice.\n";
    const local = "Launch Monday.\n\nOwner: Bob.\n";
    const synced = "Launch Tuesday.\n\nOwner: Alice.\n";
    await replace(a, "Plan.md", original); await a.sync(); await b.sync();
    await replace(a, "Plan.md", synced); await replace(b, "Plan.md", local); await a.sync(); interrupt = true;
    await expect(b.sync()).rejects.toThrow("Device disconnected");
    const fresh = remote.device(); const downloaded = await fresh.sync();
    expect(downloaded.files["Plan.md"].content).toBe(synced);
    expect(downloaded.conflicts).toHaveLength(1);
    expect((await fresh.resolve(downloaded.conflicts[0].id, "local")).files["Plan.md"].content).toBe(local);
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
