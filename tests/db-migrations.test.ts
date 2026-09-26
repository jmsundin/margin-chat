import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import {
  assertMigrationsReady,
  inspectMigrations,
  loadMigrations,
  migrateDatabase,
} from "../server/db/migrations.mjs";
import { resolveSchemaMode } from "../server/db/index.mjs";
import { parseDatabaseArguments, validateDatabaseTarget } from "../scripts/database.mjs";
import { createEmptyState, createStandaloneNoteConversation } from "../client/src/initialState";
import { readState, writeState } from "../server/db/repository.mjs";
import { normalizeAppState } from "../server/db/validation.mjs";

const databases: PGlite[] = [];
const directories: string[] = [];
afterEach(async () => {
  await Promise.all(databases.splice(0).map((database) => database.close()));
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { force: true, recursive: true })));
});

function database() {
  const pg = new PGlite({ extensions: { vector } });
  databases.push(pg);
  const queries: string[] = [];
  const client = {
    async query(sql: string, values?: unknown[]) {
      queries.push(sql);
      if (values === undefined && sql.includes(";")) return (await pg.exec(sql)).at(-1) ?? { rows: [] };
      return pg.query(sql, values);
    },
  };
  return { pg, client, queries };
}

const smallMigrations = [
  { id: "0001_initial", transaction: true, sql: "create table migration_fixture (id integer primary key, label text); insert into migration_fixture values (1, 'preserved');" },
  { id: "0002_additive", transaction: true, sql: "alter table migration_fixture add column extra text;" },
];

describe("versioned database releases", () => {
  test("the committed baseline builds a fresh pgvector database and records its checksum", async () => {
    const { client, pg } = database();
    const migrations = await loadMigrations();
    expect(migrations.map(({ sql }) => sql).join("\n")).toBe(await readFile(new URL("../server/db/schema.sql", import.meta.url), "utf8"));
    const result = await migrateDatabase(client, { migrations });
    expect(result).toMatchObject({ status: "ready", executed: migrations.map(({ id }) => id), pending: [] });
    expect((await pg.query("select extname from pg_extension where extname = 'vector'")).rows).toHaveLength(1);
    expect((await pg.query("select id, checksum from marginchat_schema_migrations")).rows[0]).toEqual({ id: migrations[0].id, checksum: migrations[0].checksum });
    expect((await assertMigrationsReady(client, { migrations })).status).toBe("ready");
  }, 30_000);

  test("current catalog migration accepts GPT-6 Sol/Luna and Grok 4.7 with provider constraints", async () => {
    const { client, pg } = database();
    await migrateDatabase(client, { migrations: await loadMigrations() });
    for (const [service, model] of [["openai-api", "gpt-6-sol"], ["openai-agent", "gpt-6-luna"], ["xai-api", "grok-4.7"]]) {
      await pg.query("insert into marginchat_app_sessions (id, default_service_id, default_model_id) values ($1,$2,$3)", [model, service, model]);
      await pg.query("insert into marginchat_conversations (id,session_id,title,service_id,model_id,created_at,updated_at) values ($1,$1,'Current',$2,$3,now(),now())", [model,service,model]);
      await expect(pg.query("update marginchat_conversations set service_id='gemini-api' where id=$1", [model])).rejects.toMatchObject({ code: "23514" });
    }
  });

  test("adopting a legacy database actually runs baseline reconciliation and preserves its account", async () => {
    const { client, pg, queries } = database();
    await pg.exec(`create table marginchat_user_accounts (
      id text primary key, email text not null unique, password_hash text not null,
      display_name text not null, created_at timestamptz not null default now(),
      updated_at timestamptz not null default now()
    ); insert into marginchat_user_accounts (id,email,password_hash,display_name)
      values ('retained-user','retained@example.test','retained-hash','Retained');`);
    const migrations = await loadMigrations();
    expect((await inspectMigrations(client, { migrations })).status).toBe("pending");
    await migrateDatabase(client, { migrations });
    expect(queries).toContain(migrations[0].sql);
    expect((await pg.query("select id, password_hash, role, billing_status from marginchat_users")).rows).toEqual([
      { id: "retained-user", password_hash: "retained-hash", role: "member", billing_status: "inactive" },
    ]);
    expect((await pg.query("select to_regclass('marginchat_user_accounts') as old_table")).rows[0]).toEqual({ old_table: null });
  }, 30_000);

  test("catalog refresh preserves saved choices and accepts new models only for their providers", async () => {
    const { client, pg } = database();
    const migrations = await loadMigrations();
    const refreshIndex = migrations.findIndex(({ id }) => id === "0003_model_catalog_refresh");
    expect(refreshIndex).toBeGreaterThan(0);
    await migrateDatabase(client, { migrations: migrations.slice(0, refreshIndex) });

    const previousModels: Record<string, string[]> = {
      "backend-services": ["smart-routing"],
      "openai-api": ["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"],
      "openai-agent": ["gpt-5.6", "gpt-5.6-terra", "gpt-5.6-luna"],
      "gemini-api": ["gemini-3.1-pro-preview", "gemini-3.5-flash", "gemini-3.1-flash-lite"],
      "huggingface-api": ["moonshotai/Kimi-K3", "openai/gpt-oss-120b", "deepseek-ai/DeepSeek-R1", "Qwen/Qwen3-Coder-480B-A35B-Instruct"],
      "xai-api": ["grok-4.5", "grok-4.3"],
    };
    let sequence = 0;
    async function insertSelection(serviceId: string, modelId: string) {
      const id = `selection-${++sequence}`;
      await pg.query("insert into marginchat_app_sessions (id, default_service_id, default_model_id) values ($1, $2, $3)", [id, serviceId, modelId]);
      await pg.query(`insert into marginchat_conversations (id, session_id, title, service_id, model_id, created_at, updated_at)
        values ($1, $1, 'Retained title', $2, $3, '2026-09-18T00:00:00Z', '2026-09-18T00:00:00Z')`, [id, serviceId, modelId]);
      return id;
    }
    for (const [serviceId, models] of Object.entries(previousModels)) {
      for (const modelId of models) await insertSelection(serviceId, modelId);
    }
    const oldSessions = (await pg.query("select * from marginchat_app_sessions order by id")).rows;
    const oldConversations = (await pg.query("select * from marginchat_conversations order by id")).rows;
    const result = await migrateDatabase(client, { migrations: migrations.filter(({ id }) => id <= "0003_model_catalog_refresh") });
    expect(result.executed).toEqual(["0003_model_catalog_refresh"]);
    expect((await pg.query("select * from marginchat_app_sessions order by id")).rows).toEqual(oldSessions);
    expect((await pg.query("select * from marginchat_conversations order by id")).rows).toEqual(oldConversations);

    const refreshedModels: Record<string, string[]> = {
      "openai-api": ["gpt-6-astra"],
      "openai-agent": ["gpt-6-astra"],
      "gemini-api": ["gemini-3.8-flash", "gemini-3.5-flash-lite"],
      "huggingface-api": [
        "deepseek-ai/DeepSeek-V4.1-Flash", "deepseek-ai/DeepSeek-V4-Pro-0813",
        "Qwen/Qwen3.8-27B", "zai-org/GLM-5.3", "Qwen/Qwen3.8-2.4T-A95B", "MiniMaxAI/MiniMax-M3",
      ],
      "xai-api": ["grok-4.6"],
    };
    for (const [serviceId, models] of Object.entries(refreshedModels)) {
      for (const modelId of models) {
        const id = await insertSelection(serviceId, modelId);
        expect((await pg.query("select default_service_id, default_model_id from marginchat_app_sessions where id=$1", [id])).rows[0])
          .toEqual({ default_service_id: serviceId, default_model_id: modelId });
        expect((await pg.query("select service_id, model_id from marginchat_conversations where id=$1", [id])).rows[0])
          .toEqual({ service_id: serviceId, model_id: modelId });
        const wrongProvider = serviceId === "xai-api" ? "openai-api" : "xai-api";
        await expect(pg.query("update marginchat_app_sessions set default_service_id=$1 where id=$2", [wrongProvider, id]))
          .rejects.toMatchObject({ code: "23514" });
        await expect(pg.query("update marginchat_conversations set service_id=$1 where id=$2", [wrongProvider, id]))
          .rejects.toMatchObject({ code: "23514" });
      }
    }
    await expect(pg.query("update marginchat_app_sessions set default_model_id='unknown-model' where id='selection-1'"))
      .rejects.toMatchObject({ code: "23514" });
    await expect(pg.query("update marginchat_conversations set model_id='unknown-model' where id='selection-1'"))
      .rejects.toMatchObject({ code: "23514" });
    await pg.query("insert into marginchat_app_sessions (id) values ('automatic-default')");
    await pg.query(`insert into marginchat_conversations (id, session_id, title, service_id, created_at, updated_at)
      values ('automatic-default', 'automatic-default', 'Automatic', 'backend-services', now(), now())`);
    expect((await pg.query("select default_service_id, default_model_id from marginchat_app_sessions where id='automatic-default'")).rows[0])
      .toEqual({ default_service_id: "backend-services", default_model_id: "smart-routing" });
    expect((await pg.query("select model_id from marginchat_conversations where id='automatic-default'")).rows[0])
      .toEqual({ model_id: "smart-routing" });
  }, 30_000);

  test("manual and automatic grouping survive database writes, including explicit ungrouped chats", async () => {
    const { client, pg } = database();
    await migrateDatabase(client, { migrations: await loadMigrations() });
    await pg.query("insert into marginchat_users (id,email,password_hash,display_name) values ('grouping-user','grouping@example.test','hash','Grouping')");
    const state = createEmptyState();
    state.conversations[state.rootId].grouping = "manual";
    const note = createStandaloneNoteConversation({ id: "grouped-note", noteId: "grouped-note-body" });
    state.conversations[note.id] = { ...note, grouping: "automatic" };
    state.groups.design = { id: "design", name: "Design", color: "#4fbf9f", collapsed: false, conversationIds: [note.id] };
    const repositoryClient = { query: async (sql: string, values?: unknown[]) => {
      const result = await client.query(sql, values);
      return { ...result, rowCount: result.rows.length || (result as { affectedRows?: number }).affectedRows || 0 };
    } };
    await writeState(repositoryClient, "grouping-user", normalizeAppState(state));
    const restored = await readState(repositoryClient, "grouping-user");
    expect(restored.conversations[state.rootId].grouping).toBe("manual");
    expect(restored.conversations[note.id].grouping).toBe("automatic");
    expect(restored.groups.design.conversationIds).toEqual([note.id]);
    await expect(pg.query("update marginchat_conversations set grouping_mode = 'invalid'")).rejects.toThrow();
  }, 30_000);

  test("adopting the existing unversioned schema preserves billing data and reruns only once", async () => {
    const { client, pg, queries } = database();
    const migrations = await loadMigrations();
    await pg.exec(migrations[0].sql);
    await pg.exec(`insert into marginchat_users (id,email,password_hash,display_name,hosted_credit_balance_micros)
      values ('existing','existing@example.test','hash','Existing',1234567)`);
    await migrateDatabase(client, { migrations });
    const before = queries.filter((query) => query === migrations[0].sql).length;
    expect((await migrateDatabase(client, { migrations })).executed).toEqual([]);
    expect(queries.filter((query) => query === migrations[0].sql)).toHaveLength(before);
    expect((await pg.query("select hosted_credit_balance_micros from marginchat_users where id='existing'")).rows[0]).toEqual({ hosted_credit_balance_micros: 1234567 });
  }, 30_000);

  test("a failed later migration rolls back its DDL, writes, and ledger while retaining earlier migrations", async () => {
    const { client, pg } = database();
    const broken = { id: "0002_failed", transaction: true, sql: "alter table migration_fixture add column partial text; update migration_fixture set label='lost'; select * from missing_migration_table;" };
    await expect(migrateDatabase(client, { migrations: [smallMigrations[0], broken] })).rejects.toThrow("0002_failed");
    expect((await pg.query("select count(*)::integer as locks from pg_locks where locktype='advisory'")).rows[0]).toEqual({ locks: 0 });
    expect((await pg.query("select * from migration_fixture")).rows).toEqual([{ id: 1, label: "preserved" }]);
    expect((await pg.query("select id from marginchat_schema_migrations")).rows).toEqual([{ id: "0001_initial" }]);
    expect((await migrateDatabase(client, { migrations: smallMigrations })).executed).toEqual(["0002_additive"]);
  });

  test("a failed first migration does not leave a false adoption ledger", async () => {
    const { client, pg } = database();
    await expect(migrateDatabase(client, { migrations: [{ id: "0001_failed", transaction: true, sql: "create table partial_fixture (id int); select * from missing_table;" }] })).rejects.toThrow("0001_failed");
    expect((await pg.query("select to_regclass('marginchat_schema_migrations') as ledger, to_regclass('partial_fixture') as partial")).rows[0]).toEqual({ ledger: null, partial: null });
  });

  test("checksum drift blocks status and migration without running new SQL", async () => {
    const { client, queries } = database();
    await migrateDatabase(client, { migrations: smallMigrations });
    const changed = [{ ...smallMigrations[0], sql: `${smallMigrations[0].sql}\n-- edited after deployment` }, smallMigrations[1]];
    const before = queries.length;
    await expect(inspectMigrations(client, { migrations: changed })).rejects.toThrow("Checksum mismatch");
    await expect(migrateDatabase(client, { migrations: changed })).rejects.toThrow("Checksum mismatch");
    expect(queries.slice(before)).not.toContain("begin");
  });

  test("out-of-order source IDs and non-prefix or unknown database entries are rejected", async () => {
    const { client, pg } = database();
    await expect(migrateDatabase(client, { migrations: [...smallMigrations].reverse() })).rejects.toThrow("strictly increasing");
    await migrateDatabase(client, { migrations: smallMigrations });
    await expect(inspectMigrations(client, { migrations: [smallMigrations[0]] })).rejects.toThrow("unknown");
    // Old application code can verify its exact known prefix after an expansion.
    expect((await assertMigrationsReady(client, { migrations: [smallMigrations[0]] })).newer).toEqual(["0002_additive"]);
    await pg.exec("delete from marginchat_schema_migrations where position=1");
    await expect(assertMigrationsReady(client, { migrations: smallMigrations })).rejects.toThrow("ordered prefix");
  });

  test("readiness does not create a ledger or apply pending SQL", async () => {
    const { client, queries } = database();
    await expect(assertMigrationsReady(client, { migrations: smallMigrations })).rejects.toThrow("required");
    expect(queries.every((query) => /^select /u.test(query))).toBe(true);
  });

  test("contended migration locks time out before any database mutation", async () => {
    let calls = 0;
    const client = { async query(sql: string) {
      expect(sql).toContain("pg_try_advisory_lock");
      calls += 1;
      return { rows: [{ locked: false }] };
    } };
    await expect(migrateDatabase(client, { migrations: smallMigrations, lockTimeoutMs: 5 })).rejects.toThrow("Timed out");
    expect(calls).toBeGreaterThanOrEqual(2);
  });

  test("unsupported nontransactional and transaction-controlling migrations fail before connecting", async () => {
    const client = { query() { throw new Error("must not query"); } };
    for (const sql of ["create index concurrently fixture_idx on fixture(id);", "create table before_commit (id int); commit;", "rollback;"]) {
      await expect(migrateDatabase(client, { migrations: [{ id: "0001_unsafe", transaction: true, sql }] })).rejects.toThrow(/not supported|cannot control/u);
    }
    await expect(migrateDatabase(client, { migrations: [{ ...smallMigrations[0], transaction: false }] })).rejects.toThrow("nontransactional");
    const directory = await mkdtemp(join(tmpdir(), "margin-migration-test-"));
    directories.push(directory);
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ version: 1, migrations: [{ id: "0001_test", file: "0001_test.sql", transaction: true, concurrent: true }] }));
    await expect(loadMigrations(directory)).rejects.toThrow("Unsupported migration metadata");
    await writeFile(join(directory, "manifest.json"), JSON.stringify({ version: 1, migrations: [{ id: "0001_test", file: "0001_test.sql", transaction: true }] }));
    await writeFile(join(directory, "0001_test.sql"), "select 1;");
    await writeFile(join(directory, "0002_forgotten.sql"), "select 2;");
    await expect(loadMigrations(directory)).rejects.toThrow("missing from the manifest");
  });
});

describe("database release configuration", () => {
  test("production can only verify, while local auto-migration can be explicitly disabled", () => {
    expect(resolveSchemaMode({})).toBe("migrate");
    expect(resolveSchemaMode({ DB_SCHEMA_MODE: "verify" })).toBe("verify");
    expect(resolveSchemaMode({ NODE_ENV: "production" })).toBe("verify");
    expect(resolveSchemaMode({ VERCEL: "1" })).toBe("verify");
    expect(() => resolveSchemaMode({ NODE_ENV: "production", DB_SCHEMA_MODE: "migrate" })).toThrow("Production");
    expect(() => resolveSchemaMode({ VERCEL: "1" }, "migrate")).toThrow("Production");
    expect(() => resolveSchemaMode({ DB_SCHEMA_MODE: "automatic" })).toThrow("verify or migrate");
  });

  test("migration commands require explicit intended target and dedicated direct credentials", () => {
    const options = parseDatabaseArguments(["migrate", "--target", "production", "--expected-host", "ep-example.neon.tech", "--expected-database", "margin"]);
    const env = { MIGRATION_DATABASE_URL: "postgresql://operator:secret@ep-example.neon.tech/margin?sslmode=require" };
    expect(validateDatabaseTarget(options, env)).toEqual({ connectionString: env.MIGRATION_DATABASE_URL });
    expect(() => validateDatabaseTarget(options, { DATABASE_URL: env.MIGRATION_DATABASE_URL })).toThrow("no fallback");
    expect(() => validateDatabaseTarget({ ...options, expectedDatabase: "other" }, env)).toThrow("does not match");
    expect(() => validateDatabaseTarget(options, { ...env, VERCEL_ENV: "preview" })).toThrow("VERCEL_ENV");
    expect(() => validateDatabaseTarget({ ...options, target: "local" }, env)).toThrow("local versus remote");
    expect(() => validateDatabaseTarget({ ...options, expectedHost: "ep-example-pooler.neon.tech" }, { MIGRATION_DATABASE_URL: "postgresql://operator:secret@ep-example-pooler.neon.tech/margin?sslmode=require" })).toThrow("direct PostgreSQL");
    expect(() => parseDatabaseArguments(["migrate"])).toThrow("explicit --target");
    expect(() => parseDatabaseArguments(["migrate", "--target", "production", "--expected-host", "db", "--expected-database", "db", "--url-env", "DATABASE_URL"])).toThrow("--url-env");
  });
});
