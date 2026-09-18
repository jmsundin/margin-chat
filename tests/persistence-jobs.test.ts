import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PGlite } from "@electric-sql/pglite";
import { definePersistenceJob, PERSISTENCE_JOB_REGISTRY } from "../server/releases/job-registry.mjs";
import { ensurePersistenceJobTables, getPersistenceJobStatus, runPersistenceJobs } from "../server/releases/jobs.mjs";
import { parsePersistenceJobArguments, persistenceJobConnection } from "../scripts/persistence-jobs.mjs";

describe("durable persistence release jobs", () => {
  let pg: PGlite;
  let client: { query: (sql: string, params?: unknown[]) => Promise<any> };
  beforeAll(async () => {
    pg = new PGlite();
    client = { query: (sql, params) => pg.query(sql, params) };
    await pg.exec("create table marginchat_users (id text primary key, created_at timestamptz not null default now())");
  }, 30000);
  afterAll(async () => { await pg?.close(); });
  beforeEach(async () => {
    await pg.exec("drop table if exists marginchat_persistence_job_users; drop table if exists marginchat_persistence_jobs; truncate marginchat_users");
  });
  async function accounts(ids = ["a", "b", "c"]) {
    for (const id of ids) await client.query("insert into marginchat_users (id) values ($1)", [id]);
  }
  function registry(execute: (context: any) => Promise<void>, version = 1) {
    const job = definePersistenceJob({ id: "test-backfill-v1", version, execute });
    return { [job.id]: job };
  }
  const jobIds = ["test-backfill-v1"];

  test("default job list and status checks create no tables or content", async () => {
    expect(await runPersistenceJobs({ client })).toEqual([]);
    expect(await getPersistenceJobStatus({ client, jobIds: ["vault-projection-v1"] })).toMatchObject([{ status: "not_started" }]);
    expect((await client.query("select to_regclass('marginchat_persistence_jobs') as relation")).rows[0].relation).toBeNull();
  });

  test("records per-account progress and does not repeat a completed job", async () => {
    await accounts();
    const visited: string[] = [];
    const jobs = registry(async ({ userId }) => { visited.push(userId); });
    const first = await runPersistenceJobs({ client, registry: jobs, jobIds, batchSize: 1 });
    expect(visited).toEqual(["a", "b", "c"]);
    expect(first).toMatchObject([{ status: "complete", processedUsers: 3, cursorUserId: "c" }]);
    await runPersistenceJobs({ client, registry: jobs, jobIds });
    expect(visited).toEqual(["a", "b", "c"]);
    expect((await client.query("select status, attempts from marginchat_persistence_job_users order by user_id")).rows)
      .toEqual([{ status: "complete", attempts: 1 }, { status: "complete", attempts: 1 }, { status: "complete", attempts: 1 }]);
  });

  test("failed account retries before later accounts without repeating completed accounts", async () => {
    await accounts();
    const visited: string[] = [];
    let fail = true;
    const jobs = registry(async ({ userId }) => {
      visited.push(userId);
      if (userId === "b" && fail) throw new Error("simulated unavailable store");
    });
    await expect(runPersistenceJobs({ client, registry: jobs, jobIds })).rejects.toThrow("retry resumes this account");
    expect(await getPersistenceJobStatus({ client, registry: jobs, jobIds })).toMatchObject([
      { status: "failed", processedUsers: 1, cursorUserId: "a", failedUserId: "b" },
    ]);
    fail = false;
    await runPersistenceJobs({ client, registry: jobs, jobIds });
    expect(visited).toEqual(["a", "b", "b", "c"]);
    expect((await client.query("select attempts from marginchat_persistence_job_users where user_id = 'b'")).rows[0].attempts).toBe(2);
  });

  test("an interrupted handler is replayed when its effect preceded the durable receipt", async () => {
    await accounts(["a"]);
    let effects = 0;
    const jobs = registry(async () => { effects += 1; });
    let failReceipt = true;
    const interrupted = { query: async (sql: string, params?: unknown[]) => {
      if (failReceipt && sql.includes("set cursor_user_id")) {
        failReceipt = false;
        throw new Error("connection interrupted before checkpoint");
      }
      return client.query(sql, params);
    } };
    await expect(runPersistenceJobs({ client: interrupted, registry: jobs, jobIds })).rejects.toThrow("connection interrupted");
    expect((await client.query("select status from marginchat_persistence_job_users")).rows[0].status).toBe("running");
    await runPersistenceJobs({ client, registry: jobs, jobIds });
    expect(effects).toBe(2);
    expect(await getPersistenceJobStatus({ client, registry: jobs, jobIds })).toMatchObject([{ processedUsers: 1, status: "complete" }]);
  });

  test("failed account is still retried when account enumeration no longer includes it", async () => {
    await accounts(["a", "b"]);
    let fail = true;
    const visited: string[] = [];
    const jobs = registry(async ({ userId }) => {
      visited.push(userId);
      if (userId === "a" && fail) throw new Error("unavailable");
    });
    await expect(runPersistenceJobs({ client, registry: jobs, jobIds })).rejects.toThrow();
    await client.query("delete from marginchat_users where id = 'a'");
    fail = false;
    await runPersistenceJobs({ client, registry: jobs, jobIds });
    expect(visited).toEqual(["a", "a", "b"]);
  });

  test("a handler's aborted transaction does not prevent recording and retrying its failure", async () => {
    await accounts(["a"]);
    let fail = true;
    const jobs = registry(async () => {
      if (fail) {
        await client.query("begin");
        await client.query("select * from a_table_that_does_not_exist");
      }
    });
    await expect(runPersistenceJobs({ client, registry: jobs, jobIds })).rejects.toThrow("retry resumes");
    expect(await getPersistenceJobStatus({ client, registry: jobs, jobIds })).toMatchObject([{ status: "failed", failedUserId: "a" }]);
    fail = false;
    expect(await runPersistenceJobs({ client, registry: jobs, jobIds })).toMatchObject([{ status: "complete", processedUsers: 1 }]);
  });

  test("bounds the account set at job start and handles an empty database", async () => {
    const visited: string[] = [];
    const jobs = registry(async ({ userId }) => {
      visited.push(userId);
      if (userId === "a") await client.query("insert into marginchat_users (id, created_at) values ('b', now() + interval '1 minute')");
    });
    await accounts(["a", "c"]);
    await runPersistenceJobs({ client, registry: jobs, jobIds, batchSize: 1 });
    expect(visited).toEqual(["a", "c"]);
    await pg.exec("drop table marginchat_persistence_job_users; drop table marginchat_persistence_jobs; truncate marginchat_users");
    expect(await runPersistenceJobs({ client, registry: jobs, jobIds })).toMatchObject([{ processedUsers: 0, status: "complete" }]);
  });

  test("checksum drift, version drift and unregistered jobs fail before processing", async () => {
    await accounts(["a"]);
    const execute = async () => {};
    const jobs = registry(execute);
    await runPersistenceJobs({ client, registry: jobs, jobIds });
    await expect(runPersistenceJobs({ client, registry: registry(async () => { return; }), jobIds })).rejects.toThrow("has changed");
    await expect(getPersistenceJobStatus({ client, registry: registry(execute, 2), jobIds })).rejects.toThrow("has changed");
    await expect(runPersistenceJobs({ client, jobIds: ["not-registered"] })).rejects.toThrow("not registered");
  });

  test("a competing worker cannot run an already locked job and locks release after failures", async () => {
    await accounts(["a"]);
    await ensurePersistenceJobTables(client);
    let unlocked = false;
    const denied = { query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("pg_try_advisory_lock") && params?.[0] === "marginchat-persistence-job:test-backfill-v1") return { rows: [{ locked: false }] };
      return client.query(sql, params);
    } };
    const jobs = registry(async () => { throw new Error("handler failure"); });
    await expect(runPersistenceJobs({ client: denied, registry: jobs, jobIds })).rejects.toThrow("Another persistence worker");
    const observed = { query: async (sql: string, params?: unknown[]) => {
      if (sql.includes("pg_advisory_unlock") && params?.[0] === "marginchat-persistence-job:test-backfill-v1") unlocked = true;
      return client.query(sql, params);
    } };
    await expect(runPersistenceJobs({ client: observed, registry: jobs, jobIds })).rejects.toThrow("retry resumes");
    expect(unlocked).toBe(true);
  });

  test("opt-in vault rebuild treats pending projection as failure and retries it", async () => {
    await accounts(["a"]);
    let ready = false;
    const rebuilt: string[] = [];
    const vaultService = { configured: true, rebuild: async (userId: string) => {
      rebuilt.push(userId);
      return { manifest: { revision: 0 }, projection: { status: ready ? "ready" : "pending" } };
    } };
    const args = { client, vaultService, jobIds: ["vault-projection-v1"], registry: PERSISTENCE_JOB_REGISTRY };
    await expect(runPersistenceJobs(args)).rejects.toThrow("retry resumes");
    ready = true;
    expect(await runPersistenceJobs(args)).toMatchObject([{ status: "complete", processedUsers: 1 }]);
    expect(rebuilt).toEqual(["a", "a"]);
  });
});

test("persistence job CLI requires an explicit verified direct destination", () => {
  const options = parsePersistenceJobArguments(["run", "--expected-host", "db.example.test", "--expected-database", "app", "--job", "vault-projection-v1"]);
  expect(options.jobIds).toEqual(["vault-projection-v1"]);
  expect(() => parsePersistenceJobArguments(["run"])).toThrow("Usage");
  expect(() => persistenceJobConnection({ DATABASE_URL: "postgres://unused:unused@db.example.test/app" }, options)).toThrow("MIGRATION_DATABASE_URL");
  expect(() => persistenceJobConnection({ MIGRATION_DATABASE_URL: "postgres://unused:unused@wrong.example.test/app" }, options)).toThrow("does not match");
  expect(() => persistenceJobConnection({ MIGRATION_DATABASE_URL: "postgres://unused:unused@db-pooler.neon.tech/app" }, { expectedHost: "db-pooler.neon.tech", expectedDatabase: "app" })).toThrow("direct endpoint");
  expect(persistenceJobConnection({ DATABASE_URL_UNPOOLED: "postgres://unused:unused@db.example.test/app" }, options).connectionString).toContain("db.example.test/app");
});
