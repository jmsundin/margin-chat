import { createHash } from "node:crypto";

/**
 * Jobs are opt-in. Add a new immutable id/version when a deployment needs a
 * backfill; never change an already executed job to make it run again.
 * execute receives { userId, client, database, vaultService } and MUST be
 * idempotent: a crash after its effects but before its receipt can repeat it.
 * Include the text of imported job-specific helpers in sources when relevant.
 * Do not register shell commands or handlers received from a release manifest.
 */
export function definePersistenceJob({ id, version, execute, sources = [], requiresVault = false }) {
  if (!/^[a-z][a-z0-9-]{0,119}$/u.test(id ?? "") ||
      !Number.isSafeInteger(version) || version < 1 || typeof execute !== "function" ||
      !Array.isArray(sources) || sources.some((source) => typeof source !== "string")) {
    throw new Error("A persistence job requires a stable id, positive version, and a static handler.");
  }
  const checksum = createHash("sha256")
    .update(JSON.stringify({ id, version, requiresVault, execute: execute.toString(), sources }))
    .digest("hex");
  return Object.freeze({ id, version, checksum, execute, requiresVault });
}

const vaultProjectionV1 = definePersistenceJob({
  id: "vault-projection-v1",
  version: 1,
  requiresVault: true,
  // Explicitly selecting this job also initializes unmigrated legacy workspaces
  // and originals through the existing vault service. Empty accounts are valid.
  async execute({ userId, vaultService }) {
    const result = await vaultService.rebuild(userId);
    if (result?.projection?.status !== "ready") {
      throw new Error("Vault projection is pending; this account must be retried.");
    }
  },
});

export const PERSISTENCE_JOB_REGISTRY = Object.freeze({
  [vaultProjectionV1.id]: vaultProjectionV1,
});

// Normal deployments never trigger a content rebuild implicitly.
export const DEFAULT_RELEASE_JOB_IDS = Object.freeze([]);
