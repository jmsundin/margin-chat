#!/usr/bin/env bun
// Daily off-site backup of the production vault store to an S3-compatible bucket at another
// provider (Cloudflare R2 by default), and restore from it. See docs/offsite-backups.md.
//
//   bun scripts/offsite-backup.mjs                          back up now
//   bun scripts/offsite-backup.mjs restore <folder> [id]    rebuild the store in an empty folder
import { mkdir, readdir, writeFile } from "node:fs/promises";
import { dirname, resolve, sep } from "node:path";
import { createS3BlobSdk } from "./backup/s3BlobSdk.mjs";
import { backupBlobStore, readBlobBackup } from "./release/providers.mjs";

const SETTINGS = {
  endpoint: "OFFSITE_BACKUP_S3_ENDPOINT",
  bucket: "OFFSITE_BACKUP_S3_BUCKET",
  accessKeyId: "OFFSITE_BACKUP_S3_ACCESS_KEY_ID",
  secretAccessKey: "OFFSITE_BACKUP_S3_SECRET_ACCESS_KEY",
};

/** The bucket settings, or an error naming every one that is missing. */
export function offsiteConfig(env = process.env) {
  const missing = Object.values(SETTINGS).filter((name) => !env[name]?.trim());
  if (missing.length) throw new Error(`Off-site backups are not set up: add ${missing.join(", ")} (see docs/offsite-backups.md).`);
  const config = Object.fromEntries(Object.entries(SETTINGS).map(([key, name]) => [key, env[name].trim()]));
  try { new URL(config.endpoint); } catch { throw new Error("OFFSITE_BACKUP_S3_ENDPOINT must be the bucket provider's https:// endpoint."); }
  return { ...config, region: env.OFFSITE_BACKUP_S3_REGION?.trim() || "auto" };
}

/** Recorded in each inventory, so a backup is never mistaken for one of another bucket. */
export const offsiteStoreId = ({ endpoint, bucket }) => `s3:${new URL(endpoint).host}/${bucket}`;

/** Copies the production store to the bucket: one complete inventory per run, reusing the copies of files unchanged since the last one. */
export async function runOffsiteBackup({ env = process.env, sdk, backupSdk, now = () => new Date(), onProgress } = {}) {
  const config = offsiteConfig(env);
  const bucket = backupSdk ?? createS3BlobSdk(config);
  // The backup's own errors only say "inspect store access", so name a bad key or endpoint up front.
  try { await bucket.list({ prefix: "releases/", mode: "folded", limit: 1 }); }
  catch (error) { throw new Error(`Couldn't open the off-site bucket (${error instanceof Error ? error.message : error}). Check the OFFSITE_BACKUP_S3_* secrets.`); }
  const releaseId = `${now().toISOString().replace(/[^0-9]/gu, "").slice(0, 14)}-daily`;
  return backupBlobStore({ releaseId, sourceToken: env.BLOB_READ_WRITE_TOKEN, sdk, backupSdk: bucket, backupStoreId: offsiteStoreId(config), now, onProgress });
}

/** The newest backup in the bucket. A run that stopped before saving its inventory doesn't count. */
export async function latestOffsiteBackup(backupSdk) {
  const ids = [];
  let cursor;
  do {
    const page = await backupSdk.list({ prefix: "releases/", mode: "folded", cursor });
    ids.push(...page.folders.map((folder) => folder.slice("releases/".length).replace(/\/$/u, "")).filter(Boolean));
    cursor = page.hasMore ? page.cursor : undefined;
  } while (cursor);
  for (const id of ids.sort().reverse()) {
    const inventory = `releases/${id}/inventory.json`;
    if ((await backupSdk.list({ prefix: inventory, limit: 1 })).blobs.some((blob) => blob.pathname === inventory)) return id;
  }
  return null;
}

/**
 * Writes every file of a backup into an empty folder, laid out like the Blob store, after
 * checking each one against the backup's inventory. The local server can open the folder
 * as its vault store with VAULT_STORAGE_DIR.
 */
export async function restoreOffsiteBackup({ env = process.env, directory, backupId, backupSdk, onProgress } = {}) {
  if (!directory) throw new Error("Name an empty folder to restore into.");
  const bucket = backupSdk ?? createS3BlobSdk(offsiteConfig(env));
  const root = resolve(directory);
  const existing = await readdir(root).catch((error) => error.code === "ENOENT" ? [] : Promise.reject(error));
  if (existing.length) throw new Error(`${root} isn't empty. Restore into a new folder so nothing is overwritten.`);
  const id = backupId ?? await latestOffsiteBackup(bucket);
  if (!id) throw new Error("The off-site bucket has no complete backup yet.");
  const record = await bucket.get(`releases/${id}/inventory.json`);
  if (!record) throw new Error(`There is no complete backup ${id} in the off-site bucket.`);
  const inventory = JSON.parse(Buffer.from(await new Response(record.stream).arrayBuffer()).toString("utf8"));
  const result = await readBlobBackup({ inventory, backupSdk: bucket, onProgress, async write(object, bytes) {
    const path = resolve(root, object.pathname);
    if (!path.startsWith(`${root}${sep}`)) throw new Error("The backup lists a file outside the restore folder.");
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes, { flag: "wx" });
  } });
  // Content types and capture times live in the inventory, which a later upload to a new store needs.
  await writeFile(resolve(root, `restored-from-${id}.json`), JSON.stringify(inventory, null, 2), { flag: "wx" });
  return { backupId: id, directory: root, ...result };
}

const megabytes = (bytes) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

if (import.meta.main) {
  const [command = "backup", ...rest] = process.argv.slice(2);
  try {
    if (command === "backup") {
      const result = await runOffsiteBackup({ onProgress: (line) => console.log(line) });
      console.log(`Off-site backup ${result.prefix} saved: ${result.objectCount} files, ${megabytes(result.totalBytes)}.`);
    } else if (command === "restore") {
      const result = await restoreOffsiteBackup({ directory: rest[0], backupId: rest[1], onProgress: (line) => console.log(line) });
      console.log(`Restored backup ${result.backupId} into ${result.directory}: ${result.objectCount} files, ${megabytes(result.totalBytes)}, every one checked.`);
    } else {
      throw new Error("Usage: bun scripts/offsite-backup.mjs [backup | restore <empty folder> [backup id]]");
    }
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
