import { validVaultPath, type VaultFile, type VaultSnapshot } from "./vaultTypes";

function documentPath(value: unknown): value is string {
  return typeof value === "string" && validVaultPath(value) && !/^_conflicts(?:\/|$)/i.test(value);
}

/** Recovery descriptors are portable UI metadata, never instructions to change a working file. */
export function recoverVaultAlternatives(snapshot: VaultSnapshot): void {
  const seen = new Set([...snapshot.conflicts.map((conflict) => conflict.id), ...(snapshot.dismissedRecoveryIds ?? [])]);
  for (const [descriptorPath, file] of Object.entries(snapshot.files)) {
    const match = /^_conflicts\/([^/]+)\/conflict\.json$/.exec(descriptorPath);
    if (!match || !validVaultPath(descriptorPath) || file.encoding || seen.has(match[1])) continue;
    let descriptor: Record<string, unknown>;
    try {
      const parsed: unknown = JSON.parse(file.content);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
      descriptor = parsed as Record<string, unknown>;
    } catch { continue; }
    if (descriptor.automatic !== true || descriptor.conflicted !== true || !documentPath(descriptor.path)
      || typeof descriptor.createdAt !== "string" || !Number.isFinite(Date.parse(descriptor.createdAt))
      || typeof descriptor.baseKnown !== "boolean" || typeof descriptor.localDeleted !== "boolean"
      || typeof descriptor.remoteDeleted !== "boolean" || typeof descriptor.resultDeleted !== "boolean"
      || (descriptor.sourcePath !== undefined && !documentPath(descriptor.sourcePath))) continue;

    const prefix = `_conflicts/${match[1]}/`;
    function copy(role: string, reference: unknown, deleted: boolean, encoding: unknown): VaultFile | null | undefined {
      if (encoding !== "utf8" && encoding !== "base64") return undefined;
      if (deleted) return reference === null && encoding === "utf8" ? null : undefined;
      if (typeof reference !== "string" || !validVaultPath(reference) || !reference.startsWith(`${prefix}${role}/`)
        || !Object.hasOwn(snapshot.files, reference)) return undefined;
      const source = snapshot.files[reference];
      if ((source.encoding ?? "utf8") !== encoding) return undefined;
      return { ...source };
    }

    const local = copy("local", descriptor.copy, descriptor.localDeleted, descriptor.localEncoding);
    const remote = copy("remote", descriptor.remoteCopy, descriptor.remoteDeleted, descriptor.remoteEncoding);
    const result = copy("result", descriptor.resultCopy, descriptor.resultDeleted, descriptor.resultEncoding);
    const base = copy("base", descriptor.baseCopy, descriptor.baseCopy === null, descriptor.baseEncoding);
    if (local === undefined || remote === undefined || result === undefined || base === undefined
      || (!descriptor.baseKnown && descriptor.baseCopy !== null)) continue;
    snapshot.conflicts.push({ id: match[1], path: descriptor.path, local, remote, result,
      automatic: true, createdAt: descriptor.createdAt,
      ...(descriptor.baseKnown ? { base } : {}),
      ...(typeof descriptor.sourcePath === "string" ? { sourcePath: descriptor.sourcePath } : {}),
    });
    seen.add(match[1]);
  }
}
