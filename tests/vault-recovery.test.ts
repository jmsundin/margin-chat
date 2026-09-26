import { describe, expect, test } from "bun:test";
import { recoverVaultAlternatives } from "../client/src/lib/vaultRecovery";
import { emptyVault, type VaultFile } from "../client/src/lib/vaultTypes";

const descriptorPath = "_conflicts/recovery-1/conflict.json";
function recovery() {
  const snapshot = emptyVault();
  const versions: Record<string, VaultFile> = {
    local: { content: "Local writing", contentType: "text/markdown" },
    remote: { content: "Cloud writing", contentType: "text/plain" },
    base: { content: "Shared ancestor", contentType: "text/markdown; charset=utf-8" },
    result: { content: "Selected writing", contentType: "text/markdown" },
  };
  const path = (role: string) => `_conflicts/recovery-1/${role}/one.md`;
  const descriptor = {
    path: "Notes/one.md", sourcePath: "Notes/old.md", createdAt: "2026-09-25T12:00:00.000Z",
    automatic: true, conflicted: true, baseKnown: true,
    copy: path("local"), remoteCopy: path("remote"), baseCopy: path("base"), resultCopy: path("result"),
    localDeleted: false, remoteDeleted: false, resultDeleted: false,
    localEncoding: "utf8", remoteEncoding: "utf8", baseEncoding: "utf8", resultEncoding: "utf8",
  };
  snapshot.files[descriptor.path] = { content: "Newer writing must remain current" };
  for (const [role, file] of Object.entries(versions)) snapshot.files[path(role)] = file;
  function writeDescriptor(changes: Record<string, unknown> = {}) {
    snapshot.files[descriptorPath] = { content: JSON.stringify({ ...descriptor, ...changes }), contentType: "application/json" };
  }
  writeDescriptor();
  return { snapshot, descriptor, versions, writeDescriptor };
}

describe("portable automatic recovery alternatives", () => {
  test("hydrates complete copies with metadata without changing working content or the descriptor", () => {
    const { snapshot, descriptor, versions } = recovery();
    const originalFiles = structuredClone(snapshot.files);
    recoverVaultAlternatives(snapshot);
    expect(snapshot.conflicts).toEqual([{
      id: "recovery-1", path: descriptor.path, sourcePath: descriptor.sourcePath,
      createdAt: descriptor.createdAt, automatic: true, ...versions,
    }]);
    expect(snapshot.files).toEqual(originalFiles);
    expect(snapshot.conflicts[0].local).not.toBe(snapshot.files[descriptor.copy]);
  });

  test("waits for every referenced version when cloud recovery arrives in separate batches", () => {
    for (const role of ["copy", "remoteCopy", "baseCopy", "resultCopy"] as const) {
      const { snapshot, descriptor } = recovery();
      const version = snapshot.files[descriptor[role]];
      delete snapshot.files[descriptor[role]];
      recoverVaultAlternatives(snapshot);
      expect(snapshot.conflicts).toEqual([]);
      snapshot.files[descriptor[role]] = version;
      recoverVaultAlternatives(snapshot);
      expect(snapshot.conflicts).toHaveLength(1);
    }
  });

  test("repeated scans deduplicate existing records and respect dismissed IDs", () => {
    const { snapshot } = recovery();
    recoverVaultAlternatives(snapshot);
    const existing = snapshot.conflicts[0];
    recoverVaultAlternatives(snapshot);
    expect(snapshot.conflicts).toEqual([existing]);
    expect(snapshot.conflicts[0]).toBe(existing);
    snapshot.conflicts = [];
    snapshot.dismissedRecoveryIds = ["recovery-1"];
    recoverVaultAlternatives(snapshot);
    expect(snapshot.conflicts).toEqual([]);
  });

  test("preserves deleted originals, a deleted result, and a known absent ancestor", () => {
    const { snapshot, descriptor, writeDescriptor } = recovery();
    writeDescriptor({ copy: null, localDeleted: true, resultCopy: null, resultDeleted: true, baseCopy: null });
    delete snapshot.files[descriptor.copy];
    delete snapshot.files[descriptor.resultCopy];
    delete snapshot.files[descriptor.baseCopy];
    recoverVaultAlternatives(snapshot);
    expect(snapshot.conflicts[0]).toMatchObject({ local: null, result: null, base: null });
    expect(snapshot.files[descriptor.path].content).toBe("Newer writing must remain current");
  });

  test("does not invent an ancestor when the original record had no common base", () => {
    const { snapshot, writeDescriptor } = recovery();
    writeDescriptor({ baseKnown: false, baseCopy: null, remoteDeleted: true, remoteCopy: null });
    recoverVaultAlternatives(snapshot);
    expect(snapshot.conflicts).toHaveLength(1);
    expect(snapshot.conflicts[0].remote).toBeNull();
    expect(Object.hasOwn(snapshot.conflicts[0], "base")).toBe(false);
  });

  test("uses original binary encoding and MIME metadata instead of interpreting bytes as text", () => {
    const { snapshot, descriptor, writeDescriptor } = recovery();
    for (const reference of [descriptor.copy, descriptor.remoteCopy, descriptor.baseCopy, descriptor.resultCopy]) {
      snapshot.files[reference] = { content: "AP8B", encoding: "base64", contentType: "application/octet-stream" };
    }
    writeDescriptor({ localEncoding: "base64", remoteEncoding: "base64", baseEncoding: "base64", resultEncoding: "base64" });
    recoverVaultAlternatives(snapshot);
    expect(snapshot.conflicts).toHaveLength(1);
    for (const role of ["local", "remote", "base", "result"] as const) {
      expect(snapshot.conflicts[0][role]).toEqual({ content: "AP8B", encoding: "base64", contentType: "application/octet-stream" });
    }
  });

  test.each([
    ["parent traversal", { copy: "_conflicts/recovery-1/local/../remote/one.md" }],
    ["another recovery", { copy: "_conflicts/recovery-2/local/one.md" }],
    ["another version role", { copy: "_conflicts/recovery-1/remote/one.md" }],
    ["working file reference", { copy: "Notes/one.md" }],
    ["invalid target", { path: "../one.md" }],
    ["recovery target", { path: "_CONFLICTS/other/local/one.md" }],
    ["invalid source", { sourcePath: "Notes/../one.md" }],
    ["contradictory deletion", { localDeleted: true }],
    ["missing deletion copy", { resultCopy: null }],
    ["contradictory ancestor", { baseKnown: false }],
    ["wrong encoding", { localEncoding: "base64" }],
    ["invalid timestamp", { createdAt: "not a date" }],
    ["nonboolean status", { localDeleted: "false" }],
    ["legacy record", { automatic: false }],
    ["fully resolved merge", { conflicted: false }],
  ])("ignores %s without changing working files", (_name, changes) => {
    const { snapshot, writeDescriptor } = recovery();
    writeDescriptor(changes as Record<string, unknown>);
    const originalFiles = structuredClone(snapshot.files);
    recoverVaultAlternatives(snapshot);
    expect(snapshot.conflicts).toEqual([]);
    expect(snapshot.files).toEqual(originalFiles);
  });

  test.each(["{invalid", "null", "[]", "42"])("ignores malformed descriptor %s", (content) => {
    const { snapshot } = recovery();
    snapshot.files[descriptorPath].content = content;
    recoverVaultAlternatives(snapshot);
    expect(snapshot.conflicts).toEqual([]);
  });

  test("ignores encoded descriptors and invalid archive identities", () => {
    const { snapshot } = recovery();
    snapshot.files[descriptorPath].encoding = "base64";
    recoverVaultAlternatives(snapshot);
    expect(snapshot.conflicts).toEqual([]);
    delete snapshot.files[descriptorPath].encoding;
    snapshot.files["_conflicts/../conflict.json"] = snapshot.files[descriptorPath];
    delete snapshot.files[descriptorPath];
    recoverVaultAlternatives(snapshot);
    expect(snapshot.conflicts).toEqual([]);
  });
});
