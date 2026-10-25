#!/usr/bin/env bun
// Daily off-site copy of the production Postgres database (accounts, billing ledger,
// chats, search index) into the same bucket as the vault backups. See docs/offsite-backups.md.
//
//   bun scripts/offsite-postgres-backup.mjs      dump, check and upload now
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createS3BlobSdk } from "./backup/s3BlobSdk.mjs";
import { offsiteConfig } from "./offsite-backup.mjs";

export const DATABASE_SETTING = "OFFSITE_BACKUP_DATABASE_URL";

/** The connection string to dump, or an error saying which secret to add. */
export function databaseUrl(env = process.env) {
  const value = env[DATABASE_SETTING]?.trim();
  if (!value) throw new Error(`The database isn't backed up off-site yet: add ${DATABASE_SETTING} (see docs/offsite-backups.md).`);
  let url;
  try { url = new URL(value); } catch { throw new Error(`${DATABASE_SETTING} must be a postgresql:// connection string.`); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error(`${DATABASE_SETTING} must be a postgresql:// connection string.`);
  return value;
}

async function run(command, args, env) {
  const child = Bun.spawn([command, ...args], { env, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited]);
  // pg_dump's errors can quote the connection string; never echo it.
  if (code !== 0) throw new Error(`${command} failed (exit ${code}): ${stderr.replace(/postgres(?:ql)?:\/\/\S+/gu, "<database url>").trim().slice(0, 2000)}`);
  return stdout;
}

/**
 * Dumps the database in pg_dump's custom format, checks that pg_restore can read
 * the whole table of contents, and uploads it as postgres/<timestamp>.dump.
 * The bucket's lock rule keeps each copy for 30 days.
 */
export async function runPostgresBackup({ env = process.env, bucket, runCommand = run, now = () => new Date(), onProgress = () => undefined } = {}) {
  const config = offsiteConfig(env);
  const connection = databaseUrl(env);
  const target = bucket ?? createS3BlobSdk(config);
  const directory = await mkdtemp(join(tmpdir(), "margin-chat-pg-"));
  const file = join(directory, "database.dump");
  try {
    // Only what the tools need: no bucket keys or other secrets reach them.
    const childEnv = { PATH: process.env.PATH ?? "", PGCONNECT_TIMEOUT: "30" };
    onProgress("Dumping the database…");
    await runCommand("pg_dump", ["--format=custom", "--no-owner", "--no-privileges", `--file=${file}`, `--dbname=${connection}`], childEnv);
    const contents = await runCommand("pg_restore", ["--list", file], childEnv);
    const tables = (contents.match(/ TABLE DATA /gu) ?? []).length;
    if (!tables) throw new Error("The database dump has no table data; refusing to save it as a backup.");
    const bytes = await readFile(file);
    const pathname = `postgres/${now().toISOString().replace(/[^0-9]/gu, "").slice(0, 14)}.dump`;
    onProgress(`Uploading ${pathname} (${tables} tables)…`);
    await target.put(pathname, bytes, { contentType: "application/octet-stream" });
    return { pathname, bytes: bytes.length, tables };
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  try {
    const result = await runPostgresBackup({ onProgress: (line) => console.log(line) });
    console.log(`Database backup ${result.pathname} saved: ${result.tables} tables, ${(result.bytes / 1024 / 1024).toFixed(1)} MB.`);
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
}
