import { createHash } from "node:crypto";

const NEON_API = "https://console.neon.tech/api/v2";
const sha256 = (bytes) => createHash("sha256").update(bytes).digest("hex");
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const identifier = (value, label) => {
  if (typeof value !== "string" || !/^[a-z0-9-]{1,60}$/.test(value)) throw new Error(`Invalid ${label}.`);
  return value;
};
const releaseIdentifier = (value) => {
  if (typeof value !== "string" || !/^[a-zA-Z0-9][a-zA-Z0-9._-]{0,99}$/.test(value)) throw new Error("Invalid release ID.");
  return value;
};

/** The REST API is used so CI requires only an explicit project-scoped API key. */
export function createNeonReleaseProvider({ config, env = process.env, fetchImpl = fetch, sleep = delay, now = Date.now, timeoutMs = 300_000, pollMs = 1_000, onBranch = () => {} }) {
  const projectId = identifier(config?.projectId, "Neon project ID");
  const productionBranchId = identifier(config?.productionBranchId, "production branch ID");
  for (const key of ["databaseName", "roleName"]) {
    if (typeof config[key] !== "string" || !config[key].trim()) throw new Error(`Missing Neon ${key}.`);
  }
  if (!env.NEON_API_KEY) throw new Error("NEON_API_KEY is required.");
  if (config.recoveryBranchProtected !== undefined && typeof config.recoveryBranchProtected !== "boolean") throw new Error("recoveryBranchProtected must be a boolean.");
  if (!(timeoutMs > 0) || !(pollMs > 0 && pollMs <= 60_000)) throw new Error("Invalid Neon polling limits.");
  let validated = false;
  async function request(path, { method = "GET", body } = {}) {
    let response;
    try {
      response = await fetchImpl(`${NEON_API}/projects/${projectId}${path}`, {
        method,
        headers: { Authorization: `Bearer ${env.NEON_API_KEY}`, Accept: "application/json", ...(body ? { "Content-Type": "application/json" } : {}) },
        ...(body ? { body: JSON.stringify(body) } : {}),
        signal: AbortSignal.timeout(Math.min(timeoutMs, 30_000)),
      });
    } catch {
      // Provider error payloads can contain connection strings; never forward them.
      throw new Error(`Neon ${method} request failed or timed out; inspect retained release resources before retrying.`);
    }
    if (!response.ok) {
      let errorCode;
      try { errorCode = (await response.json())?.code; } catch { /* Non-JSON errors keep the HTTP fallback. */ }
      // Only translate known codes into local text. Arbitrary provider messages
      // and other response fields may contain credentials or connection strings.
      const guidance = errorCode === "BRANCHES_LIMIT_EXCEEDED"
        ? " BRANCHES_LIMIT_EXCEEDED: Neon branch capacity is exhausted. A fresh release needs two free branch slots for recovery and rehearsal. Review retained release branches and remove only those no longer needed, or increase the project branch limit; then retry. No branches were automatically deleted."
        : "";
      throw new Error(`Neon ${method} request returned HTTP ${response.status}.${guidance}`);
    }
    try { return await response.json(); }
    catch { throw new Error("Neon returned an invalid JSON response."); }
  }
  function assertBranch(branch, expected = {}) {
    if (!branch || typeof branch.id !== "string" || branch.project_id !== projectId) throw new Error("Neon branch project identity mismatch.");
    identifier(branch.id, "Neon branch ID");
    for (const [key, value] of Object.entries(expected)) {
      if (branch[key] !== value) throw new Error(`Neon branch ${key} mismatch.`);
    }
    return branch;
  }
  async function getBranch(branchId) {
    identifier(branchId, "Neon branch ID");
    return assertBranch((await request(`/branches/${branchId}`)).branch, { id: branchId });
  }
  async function validateProduction() {
    const project = (await request("")).project;
    if (!project || project.id !== projectId || (config.projectName && project.name !== config.projectName)) throw new Error("Neon project identity mismatch.");
    const branch = await getBranch(productionBranchId);
    if (config.productionBranchName && branch.name !== config.productionBranchName) throw new Error("Neon production branch name mismatch.");
    if (branch.current_state !== "ready") throw new Error("Neon production branch is not ready.");
    validated = true;
    return { project: { id: project.id, name: project.name, historyRetentionSeconds: project.history_retention_seconds }, branch };
  }
  async function findBranch(name) {
    let cursor;
    const seen = new Set();
    const matches = [];
    do {
      const query = new URLSearchParams({ search: name, limit: "1000", ...(cursor ? { cursor } : {}) });
      const result = await request(`/branches?${query}`);
      if (!Array.isArray(result.branches)) throw new Error("Neon returned an invalid branch list.");
      matches.push(...result.branches.filter((branch) => branch.name === name));
      cursor = result.pagination?.next ?? result.pagination?.cursor;
      if (cursor && seen.has(cursor)) throw new Error("Neon returned a repeated branch cursor.");
      if (cursor) seen.add(cursor);
    } while (cursor);
    if (matches.length > 1) throw new Error("Neon returned multiple branches for the release name.");
    return matches[0] ?? null;
  }
  async function waitForBranch(branchId, operations = []) {
    const deadline = now() + timeoutMs;
    const pending = new Set(operations.map((operation) => operation.id));
    while (now() < deadline) {
      for (const operationId of pending) {
        if (!operationId || !/^[a-zA-Z0-9-]+$/.test(operationId)) throw new Error("Neon returned an invalid operation ID.");
        const operation = (await request(`/operations/${operationId}`)).operation;
        if (!operation || operation.id !== operationId || operation.project_id !== projectId) throw new Error("Neon operation identity mismatch.");
        if (["failed", "cancelled", "canceled", "error"].includes(operation.status)) throw new Error("Neon branch operation failed; retained resources require inspection.");
        if (operation.branch_id && operation.branch_id !== branchId) throw new Error("Neon operation branch identity mismatch.");
        if (["finished", "skipped"].includes(operation.status)) pending.delete(operationId);
      }
      const branch = await getBranch(branchId);
      if (["broken", "failed", "deleted"].includes(branch.current_state)) throw new Error("Neon branch is not usable.");
      if (branch.current_state === "ready" && pending.size === 0) return branch;
      await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
    }
    throw new Error("Timed out waiting for Neon branch readiness; branches are retained for inspection.");
  }
  async function ensureBranch({ name, protected: isProtected, parentLsn, compute }) {
    const expected = { name, parent_id: productionBranchId, protected: isProtected, init_source: "parent-data", ...(parentLsn ? { parent_lsn: parentLsn } : {}) };
    let branch = await findBranch(name);
    let operations = [];
    if (!branch) {
      try {
        const result = await request("/branches", {
          method: "POST",
          body: { branch: { name, parent_id: productionBranchId, protected: isProtected, init_source: "parent-data", ...(parentLsn ? { parent_lsn: parentLsn } : {}) }, ...(compute ? { endpoints: [{ type: "read_write" }] } : {}) },
        });
        branch = result.branch;
        operations = result.operations ?? [];
      } catch (error) {
        // POST is not inherently idempotent. Reconcile by exact unique name;
        // never replay an uncertain creation request inside this invocation.
        branch = await findBranch(name);
        if (!branch) throw error;
      }
    }
    assertBranch(branch, expected);
    // Persist resource identity before polling: a later timeout or second-branch
    // failure must not hide the already retained recovery checkpoint.
    await onBranch(compute ? "rehearsal" : "recovery", { id: branch.id, name: branch.name, project_id: branch.project_id,
      parent_id: branch.parent_id, parent_lsn: branch.parent_lsn, protected: branch.protected, current_state: branch.current_state });
    return assertBranch(await waitForBranch(branch.id, operations), expected);
  }
  async function ensureReleaseBranches(releaseId) {
    releaseIdentifier(releaseId);
    if (!validated) await validateProduction();
    const suffix = `${releaseId.slice(0,30)}-${sha256(releaseId).slice(0,12)}`;
    const recovery = await ensureBranch({ name: `release-recovery-${suffix}`, protected: config.recoveryBranchProtected ?? true, compute: false });
    if (!recovery.parent_lsn) throw new Error("Recovery branch did not expose its production snapshot LSN.");
    const rehearsal = await ensureBranch({ name: `release-rehearsal-${suffix}`, protected: false, parentLsn: recovery.parent_lsn, compute: true });
    return { recovery, rehearsal };
  }
  async function connectionUri(branchId, { pooled = false } = {}) {
    await getBranch(branchId);
    const query = new URLSearchParams({ branch_id: branchId, database_name: config.databaseName, role_name: config.roleName, pooled: String(pooled) });
    const { uri } = await request(`/connection_uri?${query}`);
    let parsed;
    try { parsed = new URL(uri); } catch { throw new Error("Neon returned an invalid database connection URI."); }
    if (!["postgres:", "postgresql:"].includes(parsed.protocol) || !parsed.hostname.endsWith(".neon.tech") ||
        decodeURIComponent(parsed.pathname.slice(1)) !== config.databaseName || decodeURIComponent(parsed.username) !== config.roleName ||
        (!pooled && parsed.hostname.split(".")[0].endsWith("-pooler"))) throw new Error("Neon database connection identity mismatch.");
    return uri;
  }
  return { validateProduction, getBranch, ensureReleaseBranches, connectionUri };
}

function tokenStoreId(token, label) {
  // Matches @vercel/blob's read-write token store-ID resolution. CI must not
  // silently fall back to OIDC or tokens from an unrelated deployment project.
  const match = typeof token === "string" && /^vercel_blob_rw_([a-zA-Z0-9]+)_([^\s]+)$/.exec(token);
  if (!match) throw new Error(`${label} must be an explicit Vercel Blob read-write token.`);
  return match[1].toLowerCase();
}

export function validateBlobStoreTokens({ sourceToken, backupToken, rehearsalToken }) {
  const result = { sourceStoreId: tokenStoreId(sourceToken, "BLOB_READ_WRITE_TOKEN"), backupStoreId: tokenStoreId(backupToken, "BACKUP_BLOB_READ_WRITE_TOKEN") };
  if (rehearsalToken !== undefined) result.rehearsalStoreId = tokenStoreId(rehearsalToken, "REHEARSAL_BLOB_READ_WRITE_TOKEN");
  if (new Set(Object.values(result)).size !== Object.values(result).length) throw new Error("Production, backup, and rehearsal Blob stores must be distinct stores.");
  return result;
}

function strongEtag(etag) {
  if (typeof etag !== "string" || !etag || etag.startsWith("W/")) throw new Error("Blob did not return a strong ETag.");
  return etag;
}

function safeBlobPathname(value) {
  return typeof value === "string" && value.length > 0 && !value.startsWith("/") &&
    !/[\\\u0000-\u001f\u007f]/.test(value) && !value.split("/").some((part) => !part || part === "." || part === "..");
}

/** Parallel Blob requests. Vercel's Hobby limits are 20 reads and 15 writes per
 * second; each copy is about three requests, so this stays near those limits
 * and rate-limited requests wait and retry. Pro allows five times more. */
export const BLOB_CONCURRENCY = 8;
const BLOB_REQUEST_TIMEOUT_MS = 60_000;
const BLOB_RATE_LIMIT_ATTEMPTS = 8;

/** Runs `task` over `items` with at most `limit` in flight, keeping input order.
 * After the first failure no new item starts; the first error is thrown. */
export async function mapLimit(items, limit, task) {
  const results = new Array(items.length);
  let next = 0;
  let failed = false;
  const worker = async () => {
    while (!failed && next < items.length) {
      const index = next++;
      try { results[index] = await task(items[index], index); }
      catch (error) { failed = true; throw error; }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, Math.min(limit, items.length)) }, worker));
  return results;
}

const isRateLimited = (error) => error?.constructor?.name === "BlobServiceRateLimited" || /\b429\b|too many requests/iu.test(error?.message ?? "");

/** Wraps the SDK so each attempt gets a fresh timeout and rate-limited requests
 * back off (honoring Retry-After) instead of failing the release. */
function retryingBlobSdk(sdk, sleep) {
  const call = (method) => async (...args) => {
    for (let attempt = 1; ; attempt += 1) {
      const options = { ...args.at(-1), abortSignal: AbortSignal.timeout(BLOB_REQUEST_TIMEOUT_MS) };
      try { return await sdk[method](...args.slice(0, -1), options); }
      catch (error) {
        if (attempt >= BLOB_RATE_LIMIT_ATTEMPTS || !isRateLimited(error)) throw error;
        await sleep(error.retryAfter > 0 ? error.retryAfter * 1000 : Math.min(30_000, 250 * 2 ** attempt + Math.floor(Math.random() * 250)));
      }
    }
  };
  return { get: call("get"), put: call("put"), list: call("list") };
}

function progressReporter(onProgress, label, total) {
  let done = 0;
  const step = Math.max(1, Math.ceil(total / 10));
  return () => {
    done += 1;
    if (done === total || done % step === 0) onProgress?.(`${label}: ${done}/${total} files`);
  };
}

async function readBlob(sdk, token, pathname, { allowMissing = false } = {}) {
  let result;
  try {
    result = await sdk.get(pathname, { token, access: "private", useCache: false, headers: { "accept-encoding": "identity" } });
  } catch (error) {
    if (allowMissing && error.name === "BlobNotFoundError") return null;
    throw new Error("Private Blob read failed; inspect store access and retry.");
  }
  if (!result && allowMissing) return null;
  if (!result || result.statusCode !== 200 || !result.stream || result.blob?.pathname !== pathname) throw new Error("Blob returned an invalid or missing object.");
  const etag = strongEtag(result.blob.etag);
  let bytes;
  try { bytes = Buffer.from(await new Response(result.stream).arrayBuffer()); }
  catch { throw new Error("Private Blob response body was interrupted; retry the release."); }
  if (bytes.length !== result.blob.size) throw new Error("Blob object length verification failed.");
  return { bytes, etag, contentType: result.blob.contentType || "application/octet-stream" };
}

async function listBlobs(sdk, token, prefix) {
  const objects = new Map();
  const cursors = new Set();
  let cursor;
  do {
    let result;
    try { result = await sdk.list({ token, prefix, cursor, limit: 1000, mode: "expanded" }); }
    catch { throw new Error("Blob listing failed; inspect store access and retry."); }
    if (!Array.isArray(result.blobs)) throw new Error("Blob returned an invalid listing.");
    for (const blob of result.blobs) {
      if (!safeBlobPathname(blob.pathname) || !blob.pathname.startsWith(prefix) || objects.has(blob.pathname)) throw new Error("Blob listing contains an invalid or duplicate pathname.");
      objects.set(blob.pathname, { pathname: blob.pathname, etag: strongEtag(blob.etag), size: blob.size });
    }
    cursor = result.hasMore ? result.cursor : undefined;
    if (result.hasMore && (!cursor || cursors.has(cursor))) throw new Error("Blob listing returned an invalid pagination cursor.");
    if (cursor) cursors.add(cursor);
  } while (cursor);
  return objects;
}

async function putVerified(sdk, token, pathname, bytes, contentType) {
  try {
    await sdk.put(pathname, bytes, { token, access: "private", addRandomSuffix: false, allowOverwrite: false, contentType, ...(bytes.length > 4 * 1024 * 1024 ? { multipart: true } : {}) });
  } catch {
    // A prior attempt may have completed the immutable upload. Only accept
    // replay when reading it back proves its body and content type are exact.
  }
  const stored = await readBlob(sdk, token, pathname);
  if (sha256(stored.bytes) !== sha256(bytes) || stored.contentType !== contentType) throw new Error("Blob copy verification failed; existing objects were left unchanged.");
  return stored;
}

const vaultManifestPath = /^(vaults\/v1\/[^/]+\/)(?:manifest\.json|history\/([a-f0-9]{64})\.json)$/;
const vaultShardPath = /^vaults\/v1\/[^/]+\/shards\/([a-f0-9]{64})\.json$/;
const isVaultManifest = (pathname) => vaultManifestPath.test(pathname);
const isObject = (value) => !!value && typeof value === "object" && !Array.isArray(value);

/** A vault root: a schema 1 manifest listing every file, or a schema 2 root
 * naming the content digest of each shard of the file list. */
function parseVaultRoot(pathname, bytes) {
  const [, root, historyDigest] = vaultManifestPath.exec(pathname) ?? [];
  if (!root) throw new Error("Invalid stored vault manifest pathname.");
  if (historyDigest && sha256(bytes) !== historyDigest) throw new Error("Immutable vault history manifest does not match its content-addressed pathname.");
  let manifest;
  try { manifest = JSON.parse(bytes.toString("utf8")); } catch { throw new Error("Stored vault manifest is invalid JSON."); }
  if (![1, 2].includes(manifest?.schemaVersion) || !Number.isSafeInteger(manifest.revision) || manifest.revision < 0 ||
      !isObject(manifest.schemaVersion === 1 ? manifest.files : manifest.shards)) throw new Error("Unsupported stored vault manifest format.");
  if (manifest.schemaVersion === 2) {
    for (const [id, shard] of Object.entries(manifest.shards)) {
      if (!/^[a-f0-9]{2}$/.test(id) || !isObject(shard) || !/^[a-f0-9]{64}$/.test(shard.digest)) throw new Error("Unsupported stored vault manifest format.");
    }
  }
  return { root, manifest };
}

/** Shard objects referenced by schema 2 roots. */
function vaultShardReferences(manifestBodies) {
  const shards = new Set();
  for (const [pathname, bytes] of manifestBodies) {
    const { root, manifest } = parseVaultRoot(pathname, bytes);
    if (manifest.schemaVersion === 2) for (const shard of Object.values(manifest.shards)) shards.add(`${root}shards/${shard.digest}.json`);
  }
  return shards;
}

function verifyShard(pathname, bytes) {
  const match = vaultShardPath.exec(pathname);
  if (match && sha256(bytes) !== match[1]) throw new Error("Immutable vault file list shard does not match its content-addressed pathname.");
}

function vaultReferences(manifestBodies, shardBodies = new Map()) {
  const references = new Map();
  const reference = (root, files) => {
    for (const [path, entry] of Object.entries(files)) {
      if (!safeBlobPathname(path) || !entry || !/^[a-f0-9]{64}$/.test(entry.revision) || typeof entry.deleted !== "boolean") throw new Error("Stored vault manifest contains an invalid revision.");
      if (entry.deleted) continue;
      if (!["utf8", "base64"].includes(entry.encoding) || typeof entry.contentType !== "string" || !entry.contentType || !Number.isSafeInteger(entry.size) || entry.size < 0) throw new Error("Stored vault manifest contains invalid immutable body metadata.");
      const bodyPathname = `${root}files/${sha256(path)}/${entry.revision}`;
      const previous = references.get(bodyPathname);
      if (previous && ["encoding", "contentType", "size"].some((key) => previous[key] !== entry[key])) throw new Error("Stored vault manifests disagree about immutable revision metadata.");
      references.set(bodyPathname, { revision: entry.revision, encoding: entry.encoding, contentType: entry.contentType, size: entry.size });
    }
  };
  for (const [pathname, bytes] of manifestBodies) {
    const { root, manifest } = parseVaultRoot(pathname, bytes);
    if (manifest.schemaVersion === 1) {
      reference(root, manifest.files);
      continue;
    }
    for (const [id, shard] of Object.entries(manifest.shards)) {
      const shardPathname = `${root}shards/${shard.digest}.json`;
      const shardBytes = shardBodies.get(shardPathname);
      if (!shardBytes) throw new Error("Vault backup is missing a file list shard referenced by a manifest.");
      verifyShard(shardPathname, shardBytes);
      let value;
      try { value = JSON.parse(shardBytes.toString("utf8")); } catch { throw new Error("Stored vault file list shard is invalid JSON."); }
      if (value?.schemaVersion !== 1 || value.shard !== id || !isObject(value.files) ||
          Object.keys(value.files).some((path) => sha256(path).slice(0, 2) !== id)) throw new Error("Unsupported stored vault file list shard.");
      references.set(shardPathname, { shard: true });
      reference(root, value.files);
    }
  }
  return references;
}

function verifyImmutableRevision(pathname, stored, expected) {
  const match = /^vaults\/v1\/[^/]+\/files\/[a-f0-9]{64}\/([a-f0-9]{64})$/.exec(pathname);
  if (!match) return null;
  // Vault revisions include encoding/content-type metadata before the bytes.
  // Historical objects no longer referenced by the manifest still have their
  // content type; their original encoding is one of the two supported values.
  const revisions = Object.fromEntries(["utf8", "base64"].map((encoding) => [encoding,
    sha256(Buffer.concat([Buffer.from(`${encoding}\n${stored.contentType}\n`), stored.bytes]))]));
  if (!Object.values(revisions).includes(match[1])) throw new Error("Immutable vault revision body does not match its content-addressed pathname.");
  if (expected && (revisions[expected.encoding] !== expected.revision || stored.contentType !== expected.contentType || stored.bytes.length !== expected.size)) throw new Error("Immutable vault revision does not match its captured manifest metadata.");
  return { ...revisions, contentType: stored.contentType, size: stored.bytes.length };
}

function validateVaultReferences(manifestBodies, shardBodies, objects, revisionChecks) {
  for (const [pathname, entry] of vaultReferences(manifestBodies, shardBodies)) {
    if (!objects.has(pathname)) throw new Error("Vault backup is missing an immutable revision referenced by a manifest.");
    if (entry.shard) continue;
    const check = revisionChecks.get(pathname);
    if (!check || check[entry.encoding] !== entry.revision || check.contentType !== entry.contentType || check.size !== entry.size) throw new Error("Immutable vault revision does not match its captured manifest metadata.");
  }
}

function validateInventory(inventory, { releaseId, sourceStoreId, backupStoreId } = {}) {
  if (!inventory || inventory.schemaVersion !== 1 || inventory.state !== "complete" || !Array.isArray(inventory.objects)) throw new Error("Invalid Blob backup inventory.");
  if ((releaseId && inventory.releaseId !== releaseId) || (sourceStoreId && inventory.sourceStoreId !== sourceStoreId) || (backupStoreId && inventory.backupStoreId !== backupStoreId)) throw new Error("Blob backup inventory identity mismatch.");
  releaseIdentifier(inventory.releaseId);
  const seen = new Set();
  for (const object of inventory.objects) {
    if (!object || !safeBlobPathname(object.pathname) || seen.has(object.pathname) ||
        !/^[a-f0-9]{64}$/.test(object.sha256) || !Number.isSafeInteger(object.size) || object.size < 0 || typeof object.contentType !== "string" ||
        object.backupPathname !== `releases/${inventory.releaseId}/objects/${sha256(object.pathname)}/${object.sha256}`) throw new Error("Invalid object in Blob backup inventory.");
    strongEtag(object.sourceEtag);
    strongEtag(object.backupEtag);
    seen.add(object.pathname);
  }
  return inventory;
}

async function verifyInventoryObjects(sdk, token, inventory, { visit, concurrency = BLOB_CONCURRENCY, onProgress, label = "Blob backup check" } = {}) {
  const manifests = new Map();
  const shards = new Map();
  const revisionChecks = new Map();
  const paths = new Map(inventory.objects.map((object) => [object.pathname, object]));
  const progress = progressReporter(onProgress, label, inventory.objects.length);
  await mapLimit(inventory.objects, concurrency, async (object) => {
    const stored = await readBlob(sdk, token, object.backupPathname);
    if (stored.etag !== object.backupEtag || stored.bytes.length !== object.size || sha256(stored.bytes) !== object.sha256 || stored.contentType !== object.contentType) throw new Error("Blob backup integrity verification failed.");
    if (isVaultManifest(object.pathname)) manifests.set(object.pathname, stored.bytes);
    if (vaultShardPath.test(object.pathname)) {
      verifyShard(object.pathname, stored.bytes);
      shards.set(object.pathname, stored.bytes);
    }
    const check = verifyImmutableRevision(object.pathname, stored);
    if (check) revisionChecks.set(object.pathname, check);
    if (visit) await visit(object, stored);
    progress();
  });
  validateVaultReferences(manifests, shards, paths, revisionChecks);
}

/** Full-object backup, with the private inventory committed only after verification.
 * Each user's captured manifest pins immutable body revisions while writes
 * continue. Other objects are captured at their individual uncached reads.
 * Neither the complete store nor DB/Blob share one atomic point in time.
 */
export async function backupBlobStore({ releaseId, sourceToken, backupToken, sourcePrefix = "", sdk, now = () => new Date(), concurrency = BLOB_CONCURRENCY, sleep = delay, onProgress }) {
  releaseIdentifier(releaseId);
  if (typeof sourcePrefix !== "string" || (sourcePrefix && !safeBlobPathname(sourcePrefix.replace(/\/$/, "")))) throw new Error("Invalid Blob backup source prefix.");
  const identities = validateBlobStoreTokens({ sourceToken, backupToken });
  const blob = retryingBlobSdk(sdk ?? await import("@vercel/blob"), sleep);
  const prefix = `releases/${releaseId}`;
  const inventoryPathname = `${prefix}/inventory.json`;
  const summarize = (inventory, bytes) => ({ inventory, inventoryPathname, inventorySha256: sha256(bytes), prefix, objectCount: inventory.objects.length, totalBytes: inventory.objects.reduce((sum, object) => sum + object.size, 0), ...identities });
  const existing = await readBlob(blob, backupToken, inventoryPathname, { allowMissing: true });
  if (existing) {
    let inventory;
    try { inventory = JSON.parse(existing.bytes.toString("utf8")); } catch { throw new Error("Invalid existing Blob backup inventory."); }
    validateInventory(inventory, { releaseId, ...identities });
    if (inventory.sourcePrefix !== sourcePrefix) throw new Error("Blob backup source prefix mismatch.");
    await verifyInventoryObjects(blob, backupToken, inventory, { concurrency, onProgress });
    return summarize(inventory, existing.bytes);
  }
  const startedAt = now().toISOString();
  const listed = await listBlobs(blob, sourceToken, sourcePrefix);
  const manifests = new Map();
  const shards = new Map();
  const captured = new Map();
  const revisionChecks = new Map();
  // Pin each mutable manifest once and capture listed immutable history before
  // copying bodies. A writer may advance live manifests without invalidating
  // either captured graph; history can reference revisions absent from listing.
  const manifestPathnames = [...listed.keys()].filter(isVaultManifest).sort();
  const manifestRecords = await mapLimit(manifestPathnames, concurrency, async (pathname) => ({ ...await readBlob(blob, sourceToken, pathname), capturedAt: now().toISOString() }));
  manifestPathnames.forEach((pathname, index) => {
    captured.set(pathname, manifestRecords[index]);
    manifests.set(pathname, manifestRecords[index].bytes);
  });
  // Sharded roots name immutable file list shards, which may postdate the listing.
  const shardPathnames = [...vaultShardReferences(manifests)].sort();
  const shardRecords = await mapLimit(shardPathnames, concurrency, async (pathname) => {
    const record = await readBlob(blob, sourceToken, pathname, { allowMissing: true });
    if (!record) throw new Error("Vault backup is missing a file list shard referenced by a manifest.");
    return { ...record, capturedAt: now().toISOString() };
  });
  shardPathnames.forEach((pathname, index) => {
    captured.set(pathname, shardRecords[index]);
    shards.set(pathname, shardRecords[index].bytes);
  });
  const references = vaultReferences(manifests, shards);
  // A commit may have added revisions after their listing page was read but
  // before its manifest was captured. Fetch the manifest's full closure directly.
  const pathnames = [...new Set([...listed.keys(), ...references.keys()])].sort();
  const progress = progressReporter(onProgress, "Blob backup", pathnames.length);
  const objects = await mapLimit(pathnames, concurrency, async (pathname) => {
    const current = captured.get(pathname) ?? await readBlob(blob, sourceToken, pathname, { allowMissing: references.has(pathname) });
    if (!current) throw new Error("Vault backup is missing an immutable revision referenced by a manifest.");
    verifyShard(pathname, current.bytes);
    const capturedAt = current.capturedAt ?? now().toISOString();
    const check = verifyImmutableRevision(pathname, current, references.get(pathname));
    if (check) revisionChecks.set(pathname, check);
    const digest = sha256(current.bytes);
    const backupPathname = `${prefix}/objects/${sha256(pathname)}/${digest}`;
    const copied = await putVerified(blob, backupToken, backupPathname, current.bytes, current.contentType);
    // Captured bodies are only needed until their copy is verified.
    captured.delete(pathname);
    progress();
    return { pathname, sourceEtag: current.etag, capturedAt, backupPathname, backupEtag: copied.etag, sha256: digest, size: current.bytes.length, contentType: current.contentType };
  });
  validateVaultReferences(manifests, shards, new Map(objects.map((object) => [object.pathname, object])), revisionChecks);
  const inventory = { schemaVersion: 1, state: "complete", releaseId, ...identities, sourcePrefix, startedAt, completedAt: now().toISOString(),
    consistency: "Per-user captured manifests with verified immutable revisions; other objects captured individually. No global point-in-time or atomic database/Blob snapshot.", objects };
  const bytes = Buffer.from(`${JSON.stringify(inventory, null, 2)}\n`);
  await putVerified(blob, backupToken, inventoryPathname, bytes, "application/json");
  return summarize(inventory, bytes);
}

/** Restore a backup into a mandatory isolated prefix of a third private store.
 * Existing target objects must match exactly; this never overwrites live data.
 */
export async function restoreBlobBackup({ inventory, backupToken, targetToken, targetPrefix, sdk, concurrency = BLOB_CONCURRENCY, sleep = delay, onProgress }) {
  validateInventory(inventory);
  const { sourceStoreId: targetStoreId, backupStoreId } = validateBlobStoreTokens({ sourceToken: targetToken, backupToken });
  if (backupStoreId !== inventory.backupStoreId || targetStoreId === inventory.sourceStoreId) throw new Error("Blob restore must target an isolated store distinct from production and backup.");
  if (!safeBlobPathname(targetPrefix)) throw new Error("Blob restore requires a safe, nonempty isolated target prefix.");
  const blob = retryingBlobSdk(sdk ?? await import("@vercel/blob"), sleep);
  // One read of each backup object both verifies it and copies it. Manifests
  // are written only after the whole snapshot verified, so no restored manifest
  // can refer to an object that is missing or corrupt in the rehearsal store.
  const manifests = [];
  await verifyInventoryObjects(blob, backupToken, inventory, { concurrency, onProgress, label: "Blob restore", visit: async (object, stored) => {
    if (isVaultManifest(object.pathname)) manifests.push([object, stored.bytes]);
    else await putVerified(blob, targetToken, `${targetPrefix}/${object.pathname}`, stored.bytes, object.contentType);
  } });
  manifests.sort(([a], [b]) => a.pathname.localeCompare(b.pathname));
  await mapLimit(manifests, concurrency, ([object, bytes]) => putVerified(blob, targetToken, `${targetPrefix}/${object.pathname}`, bytes, object.contentType));
  return { objectCount: inventory.objects.length, targetStoreId, targetPrefix };
}
