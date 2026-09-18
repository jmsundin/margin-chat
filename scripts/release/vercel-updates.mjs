import { readFile } from "node:fs/promises";

const PROJECT_FIELDS = ["framework", "buildCommand", "installCommand", "outputDirectory", "devCommand", "nodeVersion"];
const RESERVED_ENV = new Set(["DATABASE_URL", "BLOB_READ_WRITE_TOKEN", "BLOB_STORE_ID", "VAULT_STORAGE_DIR", "VAULT_STORAGE_PREFIX", "DB_SCHEMA_MODE", "MARGIN_RELEASE_SHA", "API_KEY_ENCRYPTION_KEY"]);
const isObject = (value) => value && typeof value === "object" && !Array.isArray(value);

export function parseVercelUpdates(input, vercelConfig = {}, env = {}) {
  if (!isObject(input) || input.schemaVersion !== 1 || Object.keys(input).some((key) => !["schemaVersion", "project", "environment"].includes(key))) {
    throw new Error("Invalid vercel.updates.json schema; expected schemaVersion, project, and environment.");
  }
  if (!isObject(input.project) || !Array.isArray(input.environment)) throw new Error("Vercel updates require a project object and environment array.");
  const project = Object.fromEntries(PROJECT_FIELDS.filter((key) => Object.hasOwn(vercelConfig, key)).map((key) => [key, vercelConfig[key]]));
  for (const [key, value] of Object.entries(input.project)) {
    if (!PROJECT_FIELDS.includes(key)) throw new Error(`Unsupported Vercel project setting: ${key}`);
    if (Object.hasOwn(vercelConfig, key) && vercelConfig[key] !== value) throw new Error(`Update ${key} in vercel.json; it overrides the project setting.`);
    project[key] = value;
  }
  for (const [key, value] of Object.entries(project)) {
    if ((value !== null && typeof value !== "string") || (typeof value === "string" && value.length > 256) ||
      (key === "nodeVersion" && (typeof value !== "string" || !/^\d+\.x$/u.test(value)))) throw new Error(`Invalid Vercel project setting: ${key}`);
  }
  const names = new Set();
  const missing = [];
  const environment = input.environment.map((entry) => {
    if (!isObject(entry) || Object.keys(entry).some((key) => !["key", "value", "fromEnv", "type"].includes(key)) ||
      typeof entry.key !== "string" || !/^[A-Z_][A-Z0-9_]*$/u.test(entry.key)) throw new Error("Invalid Vercel environment declaration.");
    if (names.has(entry.key)) throw new Error(`Duplicate Vercel environment key: ${entry.key}`);
    names.add(entry.key);
    if (RESERVED_ENV.has(entry.key) || entry.key.startsWith("VERCEL_")) throw new Error(`${entry.key} is managed by the release runner or needs a dedicated persistence transition.`);
    const fromEnv = Object.hasOwn(entry, "fromEnv");
    if (fromEnv === Object.hasOwn(entry, "value")) throw new Error(`Declare exactly one of value or fromEnv for ${entry.key}.`);
    const type = entry.type ?? (fromEnv ? "encrypted" : "plain");
    if (!["plain", "encrypted", "sensitive"].includes(type) || (!fromEnv && type !== "plain") || (fromEnv && type === "plain")) {
      throw new Error(`Use fromEnv with encrypted/sensitive type for secrets; value with plain type for public configuration (${entry.key}).`);
    }
    if (fromEnv && (typeof entry.fromEnv !== "string" || !/^[A-Z_][A-Z0-9_]*$/u.test(entry.fromEnv))) throw new Error(`Invalid fromEnv for ${entry.key}.`);
    const value = fromEnv ? env[entry.fromEnv] : entry.value;
    if (fromEnv && (typeof value !== "string" || !value.length)) missing.push(entry.fromEnv);
    else if (typeof value !== "string") throw new Error(`Environment value must be a string (${entry.key}).`);
    return { key: entry.key, value, type, target: ["production"] };
  });
  return { project, environment, missing: [...new Set(missing)] };
}

export async function readVercelUpdates(env = process.env) {
  const [input, vercelConfig] = await Promise.all([
    readFile(new URL("../../vercel.updates.json", import.meta.url), "utf8"),
    readFile(new URL("../../vercel.json", import.meta.url), "utf8"),
  ]);
  return parseVercelUpdates(JSON.parse(input), JSON.parse(vercelConfig), env);
}

export function describeVercelUpdates(updates) {
  return { projectSettings: Object.keys(updates.project), environment: updates.environment.map(({ key, type }) => ({ key, type, target: "production" })),
    missingEnvironment: updates.missing, deployment: "Always rebuild and verify this same commit, then promote it; environment values are never printed." };
}

export function assertDeployedCommit(deployment, projectId, sha) {
  if (deployment.projectId !== projectId || deployment.readyState !== "READY" || deployment.target !== "production") {
    throw new Error("Vercel sync requires an existing READY production deployment in the configured project.");
  }
  const candidates = [deployment.meta?.marginReleaseSha, deployment.meta?.githubCommitSha, deployment.meta?.gitlabCommitSha,
    deployment.meta?.bitbucketCommitSha, deployment.gitSource?.sha].filter((value) => value != null);
  if (!candidates.length || candidates.some((value) => value !== sha)) {
    throw new Error("The current production deployment must identify the exact local HEAD commit. Deploy that committed checkout first.");
  }
}

export function createVercelApi({ config, token, fetchImpl = fetch }) {
  return async (path, { method = "GET", body } = {}) => {
    const url = new URL(path, "https://api.vercel.com");
    if (url.origin !== "https://api.vercel.com") throw new Error("Invalid Vercel API origin.");
    url.searchParams.set("teamId", config.orgId);
    let response;
    try {
      response = await fetchImpl(url, { method, headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }), redirect: "error", signal: AbortSignal.timeout(30_000) });
    } catch { throw new Error(`Vercel ${method} request failed. Re-run sync to reconcile any partially applied updates.`); }
    // Provider error bodies can echo submitted secrets. Never include them in errors.
    if (!response.ok) throw new Error(`Vercel ${method} request failed (${response.status}); re-run sync after resolving the API failure.`);
    let result;
    try { result = await response.json(); }
    catch { throw new Error(`Vercel ${method} returned an unreadable response; re-run sync to reconcile updates.`); }
    if (!result || result.error || result.errors?.length || result.failed?.length) throw new Error(`Vercel ${method} reported an unsuccessful update; re-run sync to reconcile updates.`);
    return result;
  };
}

export async function planVercelUpdates({ api, projectId, updates }) {
  if (updates.missing.length) throw new Error(`Missing Vercel update secrets: ${updates.missing.join(", ")}`);
  const path = `/v9/projects/${encodeURIComponent(projectId)}`;
  const current = await api(path);
  if (current.id !== projectId) throw new Error("Unexpected Vercel project identity.");
  const patch = Object.fromEntries(Object.entries(updates.project).filter(([key, value]) => current[key] !== value));
  const actions = [];
  if (updates.environment.length) {
    const listing = await api(`/v10/projects/${encodeURIComponent(projectId)}/env`);
    if (!Array.isArray(listing.envs) || listing.pagination?.next != null) throw new Error("Cannot safely inspect the complete Vercel environment list.");
    for (const entry of updates.environment) {
      const matches = listing.envs.filter((row) => row.key === entry.key && [row.target].flat().includes("production"));
      if (matches.length > 1) throw new Error(`Ambiguous production environment variable: ${entry.key}`);
      const existing = matches[0];
      // Scope splitting is not atomic in Vercel. Refuse to alter preview/custom
      // environments or integration-owned values while updating production.
      if (existing && (!existing.id || [existing.target].flat().some((target) => target !== "production") || existing.customEnvironmentIds?.length ||
        existing.configurationId || existing.system || ["system", "secret"].includes(existing.type))) {
        throw new Error(`${entry.key} must be a project-owned production-only variable before sync can manage it.`);
      }
      if (existing && existing.type !== "plain" && entry.type === "plain") throw new Error(`Refusing to expose an existing secret as plain text: ${entry.key}`);
      actions.push({ ...entry, type: existing?.type === "sensitive" ? "sensitive" : entry.type, id: existing?.id });
    }
  }
  return { patch, actions };
}

export async function applyVercelUpdates({ api, projectId, updates, onApplied = () => {} }) {
  // Re-read before mutation, including every variable's ownership/scope. A
  // retry re-applies values and rebuilds, even after an interrupted deployment.
  const { patch, actions } = await planVercelUpdates({ api, projectId, updates });
  const result = { projectSettings: [], environment: [] };
  const path = `/v9/projects/${encodeURIComponent(projectId)}`;
  if (Object.keys(patch).length) {
    await api(path, { method: "PATCH", body: patch });
    result.projectSettings = Object.keys(patch);
    await onApplied(result);
  }
  for (const { id, ...body } of actions) {
    await api(id ? `${path}/env/${encodeURIComponent(id)}` : `/v10/projects/${encodeURIComponent(projectId)}/env`, { method: id ? "PATCH" : "POST", body });
    result.environment.push(body.key);
    await onApplied(result);
  }
  return result;
}
