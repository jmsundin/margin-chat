import { readFile } from "node:fs/promises";

export const REQUIRED_RELEASE_SECRETS = [
  "NEON_API_KEY", "VERCEL_TOKEN", "BLOB_READ_WRITE_TOKEN", "REHEARSAL_BLOB_READ_WRITE_TOKEN", "BACKUP_BLOB_READ_WRITE_TOKEN",
  "VERCEL_AUTOMATION_BYPASS_SECRET",
];

export async function readReleaseConfig(path = new URL("../../release.config.json", import.meta.url)) {
  const config = JSON.parse(await readFile(path, "utf8"));
  if (!config || typeof config !== "object" || Array.isArray(config) || config.schemaVersion !== 1) throw new Error("Unsupported release.config.json schemaVersion.");
  if (!Array.isArray(config.jobs) || config.jobs.some((id) => typeof id !== "string") || new Set(config.jobs).size !== config.jobs.length) {
    throw new Error("Release jobs must be a list of unique registered job IDs.");
  }
  if (config.compatibility?.oldApplication !== true || config.compatibility?.oldClients !== true) {
    throw new Error("The automated release requires compatibility with the serving application and existing clients. Split incompatible changes into expand/migrate/contract releases.");
  }
  if (typeof config.compatibility.automaticAppRollback !== "boolean") throw new Error("Declare automaticAppRollback explicitly.");
  if (!Number.isInteger(config.observation?.checks) || config.observation.checks < 1 || config.observation.checks > 30 ||
      !Number.isInteger(config.observation.intervalSeconds) || config.observation.intervalSeconds < 1 || config.observation.intervalSeconds > 60) {
    throw new Error("Observation requires 1–30 checks and a 1–60 second interval.");
  }
  return config;
}

export function configurationGaps(config, env = {}) {
  const missing = [];
  for (const [section, keys] of Object.entries({ vercel: ["projectId", "orgId"], neon: ["projectId", "productionBranchId", "databaseName", "roleName"],
    blob: ["productionStoreId", "backupStoreId", "rehearsalStoreId"] })) {
    for (const key of keys) if (typeof config?.[section]?.[key] !== "string" || !config[section][key].trim()) missing.push(`${section}.${key}`);
  }
  try {
    const url = new URL(config.productionUrl);
    if (url.protocol !== "https:" || url.pathname !== "/" || url.username || url.password || url.search || url.hash) throw new Error();
  } catch { missing.push("productionUrl (HTTPS origin)"); }
  for (const key of REQUIRED_RELEASE_SECRETS) if (!env[key]) missing.push(key);
  return missing;
}

export function redact(value, secrets = []) {
  let result = String(value);
  for (const secret of secrets.filter((s) => typeof s === "string" && s.length > 5).sort((a, b) => b.length - a.length)) result = result.split(secret).join("[redacted]");
  return result.replace(/postgres(?:ql)?:\/\/[^\s"']+/giu, "[redacted database URL]")
    .replace(/vercel_blob_rw_[a-z0-9_]+/giu, "[redacted Blob token]");
}
