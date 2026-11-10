import { describe, expect, test } from "bun:test";
import { VaultSync } from "../client/src/lib/vaultSync";
import { diffWords, listDocumentVersions, versionText } from "../client/src/lib/versionHistory";
import type { VaultFile, VaultManifest, VaultSnapshot, VaultStore, VaultTransport } from "../client/src/lib/vaultTypes";
import { createVaultService } from "../server/vault/index.mjs";
import { digest } from "../server/vault/storage.mjs";

const doc = (id: string, body: string): VaultFile => ({ content: `---\nmargin-chat-id: ${id}\n---\n${body}` });

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
      return { content: bytes.toString("utf8"), contentType: entry.contentType };
    },
    async commit(changes) {
      const { manifest, previousRevision } = await server.commit("user", changes);
      return { ...normalize(manifest), previousRevision };
    },
  };
  return { device: () => new VaultSync(store(), transport) };
}

async function write(device: VaultSync, path: string, value: VaultFile) {
  const previous = (await device.read()).files;
  return device.edit({ ...previous, [path]: value }, previous);
}

async function clash() {
  const remote = cloud(); const computer = remote.device(); const phone = remote.device();
  await write(computer, "Plan.md", doc("plan", "We meet on Monday.\n")); await computer.sync(); await phone.sync();
  await write(computer, "Plan.md", doc("plan", "We meet on Tuesday.\n"));
  await write(phone, "Plan.md", doc("plan", "We meet on Friday.\n"));
  await computer.sync();
  const snapshot = await phone.sync();
  return { phone, snapshot };
}

describe("version history", () => {
  test("a clash lists the kept wording and the other device's wording for that document only", async () => {
    const { snapshot } = await clash();
    expect(snapshot.conflicts).toHaveLength(1);
    const records = listDocumentVersions(snapshot.files, "plan", "Plan.md");
    expect(records).toHaveLength(1);
    expect(records[0].reason).toBe("clash");
    const texts = records[0].versions.map((version) => [version.role, versionText("Plan.md", version.file)]);
    expect(texts).toContainEqual(["kept", "We meet on Tuesday."]);
    expect(texts).toContainEqual(["device", "We meet on Friday."]);
    // Versions identical to one already listed are not repeated.
    expect(new Set(records[0].versions.map((version) => version.file.content)).size).toBe(records[0].versions.length);
    expect(listDocumentVersions(snapshot.files, "other", "Other.md")).toHaveLength(0);
    // A renamed document still finds its versions by identity.
    expect(listDocumentVersions(snapshot.files, "plan", "Renamed.md")).toHaveLength(1);
  });

  test("restoring a version brings its text back and keeps the replaced text as a version", async () => {
    const { phone, snapshot } = await clash();
    const friday = listDocumentVersions(snapshot.files, "plan", "Plan.md")[0].versions.find((version) => version.role === "device")!;
    const restored = await phone.restoreVersion("Plan.md", friday.file);
    expect(versionText("Plan.md", restored.files["Plan.md"])).toBe("We meet on Friday.");
    const records = listDocumentVersions(restored.files, "plan", "Plan.md");
    expect(records).toHaveLength(2);
    const before = records.find((record) => record.reason === "restore")!;
    expect(before.versions.map((version) => [version.role, versionText("Plan.md", version.file)])).toEqual([["before-restore", "We meet on Tuesday."]]);
    // The restore is an ordinary change, so it reaches the other devices.
    await phone.sync();
    // Restoring the text the document already has changes nothing.
    const again = await phone.restoreVersion("Plan.md", restored.files["Plan.md"]);
    expect(listDocumentVersions(again.files, "plan", "Plan.md")).toHaveLength(2);
  });

  test("only a document's text can be restored", async () => {
    const { phone } = await clash();
    await expect(phone.restoreVersion("Missing.md", doc("x", "x"))).rejects.toThrow("Only a document's text can be restored.");
  });

  test("word differences show what restoring would add and take out", () => {
    const meet = diffWords("We meet on Tuesday.", "We meet on Friday.");
    expect(meet[0]).toEqual({ kind: "same", text: "We meet on " });
    expect(meet.slice(1).map((part) => part.kind).sort()).toEqual(["added", "removed"]);
    const parts = diffWords("one two three", "one 2 three four");
    expect(parts.filter((part) => part.kind !== "added").map((part) => part.text).join("")).toBe("one two three");
    expect(parts.filter((part) => part.kind !== "removed").map((part) => part.text).join("")).toBe("one 2 three four");
    expect(diffWords("same", "same")).toEqual([{ kind: "same", text: "same" }]);
    const big = diffWords("a b c", "x y z", 1);
    expect(big).toEqual([{ kind: "removed", text: "a b c" }, { kind: "added", text: "x y z" }]);
  });
});

describe("word differences", () => {
  test("nearby changed words read as one old phrase and one new phrase", () => {
    expect(diffWords("We meet on Friday on a call.", "We meet on Tuesday at the cafe.")).toEqual([
      { kind: "same", text: "We meet on " }, { kind: "removed", text: "Friday on a call." }, { kind: "added", text: "Tuesday at the cafe." },
    ]);
    for (const [from, to] of [["a b c d", "a x c y"], ["keep this", "x keep y this z"], ["one two", "three"]]) {
      const parts = diffWords(from, to);
      expect(parts.filter((part) => part.kind !== "added").map((part) => part.text).join("")).toBe(from);
      expect(parts.filter((part) => part.kind !== "removed").map((part) => part.text).join("")).toBe(to);
    }
  });
});
