import { createHash } from "node:crypto";
import { readFile, readdir } from "node:fs/promises";
import { resolve } from "node:path";
import { setTimeout as delay } from "node:timers/promises";
import { pathToFileURL } from "node:url";

export const MIGRATION_TABLE = "public.marginchat_schema_migrations";
export const MIGRATION_LOCK_KEY = 70421933;
const defaultDirectory = new URL("./migrations/", import.meta.url);

const createLedgerSql = `create table if not exists ${MIGRATION_TABLE} (
  position integer primary key check (position > 0),
  id text not null unique,
  checksum text not null check (checksum ~ '^[a-f0-9]{64}$'),
  applied_at timestamptz not null default now()
)`;

export function migrationChecksum(sql) {
  return createHash("sha256").update(sql, "utf8").digest("hex");
}

// Hide quoted bodies/comments before checking top-level statements. In
// particular, a PL/pgSQL BEGIN inside DO $$...$$ is not transaction control.
function executableSql(sql) {
  return sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|\$(\w*)\$[\s\S]*?\$\1\$|'(?:''|[^'])*'|"(?:""|[^"])*"/gu, " ");
}

function validateMigrations(migrations) {
  if (!Array.isArray(migrations) || !migrations.length) throw new Error("The migration manifest must contain at least one migration.");
  let previous = "";
  return migrations.map((migration, index) => {
    if (!migration || !/^\d{4}_[a-z0-9_]+$/u.test(migration.id ?? "") || migration.id <= previous) {
      throw new Error("Migration IDs must be unique and strictly increasing (for example 0001_baseline).");
    }
    previous = migration.id;
    if (migration.transaction !== true) throw new Error(`Migration ${migration.id} must declare transaction: true; nontransactional migrations are not supported.`);
    if (typeof migration.sql !== "string" || !migration.sql.trim()) throw new Error(`Migration ${migration.id} has no SQL.`);
    const executable = executableSql(migration.sql);
    if (/\bconcurrently\b/iu.test(executable)) throw new Error(`Migration ${migration.id} contains concurrent DDL, which is not supported by the transactional runner.`);
    if (/(?:^|;)\s*(?:begin\b|start\s+transaction\b|commit\b|end\b|rollback\b|abort\b|prepare\s+transaction\b)/iu.test(executable)) {
      throw new Error(`Migration ${migration.id} cannot control transactions; the runner owns BEGIN and COMMIT.`);
    }
    const checksum = migrationChecksum(migration.sql);
    if (migration.checksum !== undefined && migration.checksum !== checksum) throw new Error(`Migration ${migration.id} has an invalid source checksum.`);
    return { ...migration, position: index + 1, checksum };
  });
}

export async function loadMigrations(directory = defaultDirectory) {
  const base = directory instanceof URL ? directory : pathToFileURL(`${resolve(directory)}/`);
  const manifest = JSON.parse(await readFile(new URL("manifest.json", base), "utf8"));
  if (manifest.version !== 1 || !Array.isArray(manifest.migrations)) throw new Error("Unsupported migration manifest version or structure.");
  const migrations = [];
  for (const item of manifest.migrations) {
    if (!item || Object.keys(item).some((key) => !["id", "file", "transaction"].includes(key))) throw new Error("Unsupported migration metadata; only id, file, and transaction are supported.");
    if (item.file !== `${item.id}.sql` || !/^\d{4}_[a-z0-9_]+\.sql$/u.test(item.file)) throw new Error("Migration files must be SQL files beside the manifest and match their IDs.");
    migrations.push({ ...item, sql: await readFile(new URL(item.file, base), "utf8") });
  }
  const declared = new Set(migrations.map(({ file }) => file));
  const unlisted = (await readdir(base)).filter((file) => file.endsWith(".sql") && !declared.has(file));
  if (unlisted.length) throw new Error(`SQL migration files are missing from the manifest: ${unlisted.join(", ")}.`);
  return validateMigrations(migrations);
}

async function readLedger(client) {
  const existence = await client.query("select to_regclass($1) as migration_table", [MIGRATION_TABLE]);
  if (!existence.rows[0]?.migration_table) return [];
  return (await client.query(`select position, id, checksum from ${MIGRATION_TABLE} order by position`)).rows;
}

export async function inspectMigrations(client, { migrations, allowNewer = false } = {}) {
  const source = validateMigrations(migrations ?? await loadMigrations());
  const ledger = await readLedger(client);
  let previous = "";
  for (let index = 0; index < ledger.length; index += 1) {
    const row = ledger[index];
    if (Number(row.position) !== index + 1 || !/^\d{4}_[a-z0-9_]+$/u.test(row.id ?? "") || row.id <= previous || !/^[a-f0-9]{64}$/u.test(row.checksum ?? "")) {
      throw new Error("The database migration ledger is not a valid ordered prefix. Stop and investigate before deploying.");
    }
    previous = row.id;
    const expected = source[index];
    if (!expected) {
      if (!allowNewer) throw new Error(`Database migration ${row.id} is unknown to this release. Use the newest release to manage migrations.`);
      continue;
    }
    if (row.id !== expected.id) throw new Error(`The database migration ledger is not a prefix of this release: expected ${expected.id}, found ${row.id}.`);
    if (row.checksum !== expected.checksum) throw new Error(`Checksum mismatch for applied migration ${row.id}. Applied SQL must never be edited; add a new migration.`);
  }
  const pending = source.slice(ledger.length).map(({ id }) => id);
  return {
    status: pending.length ? "pending" : "ready",
    applied: ledger.map(({ id }) => id),
    pending,
    newer: ledger.slice(source.length).map(({ id }) => id),
    latest: source.at(-1).id,
  };
}

// An older compatible application can run after additive migrations. It must
// still recognize and verify the entire prefix of migrations it was built for.
export async function assertMigrationsReady(client, options = {}) {
  const result = await inspectMigrations(client, { allowNewer: true, ...options });
  if (result.pending.length) throw new Error(`Database migrations are required before this application can start: ${result.pending.join(", ")}. Run the release migration step first.`);
  return result;
}

function positiveTimeout(value, name) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 3_600_000) throw new Error(`${name} must be an integer between 1 and 3600000 milliseconds.`);
  return value;
}

export async function migrateDatabase(client, {
  migrations,
  lockTimeoutMs = 10_000,
  statementTimeoutMs = 120_000,
} = {}) {
  const source = validateMigrations(migrations ?? await loadMigrations());
  positiveTimeout(lockTimeoutMs, "lockTimeoutMs");
  positiveTimeout(statementTimeoutMs, "statementTimeoutMs");
  const deadline = Date.now() + lockTimeoutMs;
  let locked = false;
  let failure = null;
  const executed = [];
  try {
    while (!locked) {
      locked = (await client.query("select pg_try_advisory_lock($1) as locked", [MIGRATION_LOCK_KEY])).rows[0]?.locked === true;
      if (locked) break;
      if (Date.now() >= deadline) throw new Error("Timed out waiting for the database migration lock; another release may be running.");
      await delay(Math.min(100, Math.max(1, deadline - Date.now())));
    }
    const before = await inspectMigrations(client, { migrations: source });
    for (const migration of source.slice(before.applied.length)) {
      await client.query("begin");
      try {
        await client.query("select set_config('search_path', 'public', true), set_config('lock_timeout', $1, true), set_config('statement_timeout', $2, true)", [`${lockTimeoutMs}ms`, `${statementTimeoutMs}ms`]);
        await client.query(createLedgerSql);
        // Execute the baseline even on an existing database: recording adoption
        // without reconciling its schema would certify changes never applied.
        await client.query(migration.sql);
        await client.query(`insert into ${MIGRATION_TABLE} (position, id, checksum) values ($1, $2, $3)`, [migration.position, migration.id, migration.checksum]);
        await client.query("commit");
        executed.push(migration.id);
      } catch (error) {
        try { await client.query("rollback"); } catch { /* Preserve the original migration failure. */ }
        throw new Error(`Migration ${migration.id} failed; rollback was attempted: ${error.message}. Recheck the ledger before retrying if the connection was lost.`, { cause: error });
      }
    }
    return { ...await inspectMigrations(client, { migrations: source }), executed };
  } catch (error) {
    failure = error;
    throw error;
  } finally {
    if (locked) {
      try { await client.query("select pg_advisory_unlock($1)", [MIGRATION_LOCK_KEY]); }
      catch (error) { if (!failure) throw error; }
    }
  }
}
