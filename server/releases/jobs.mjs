import { readFileSync } from "node:fs";
import { DEFAULT_RELEASE_JOB_IDS, PERSISTENCE_JOB_REGISTRY } from "./job-registry.mjs";

const schemaStatements = readFileSync(new URL("./jobs.sql", import.meta.url), "utf8")
  .split(";").map((statement) => statement.trim()).filter(Boolean);

function resolveJobs(jobIds, registry) {
  if (!Array.isArray(jobIds) || new Set(jobIds).size !== jobIds.length) {
    throw new Error("Persistence job ids must be an array without duplicates.");
  }
  return jobIds.map((id) => {
    const job = Object.hasOwn(registry, id) ? registry[id] : null;
    if (!job || job.id !== id || !Number.isSafeInteger(job.version) || job.version < 1 ||
        !/^[a-f0-9]{64}$/u.test(job.checksum ?? "") || typeof job.execute !== "function") {
      throw new Error(`Persistence job is not registered: ${String(id)}`);
    }
    return job;
  });
}

async function withSessionLock(client, key, operation) {
  const { rows } = await client.query("select pg_try_advisory_lock(hashtextextended($1, 0)) as locked", [key]);
  if (rows[0]?.locked !== true) throw new Error(`Another persistence worker holds ${key}. Retry after it finishes.`);
  try { return await operation(); }
  finally { await client.query("select pg_advisory_unlock(hashtextextended($1, 0))", [key]); }
}

/** Explicit release bootstrap only. Never call this from application requests. */
export async function ensurePersistenceJobTables(client) {
  await withSessionLock(client, "marginchat-persistence-job-bootstrap", async () => {
    for (const statement of schemaStatements) await client.query(statement);
  });
}

function assertIdentity(job, row) {
  if (row && (Number(row.version) !== job.version || row.checksum !== job.checksum)) {
    throw new Error(`Persistence job ${job.id} has changed since it was recorded. Register a new id/version.`);
  }
}

function statusFor(job, row) {
  assertIdentity(job, row);
  return {
    id: job.id,
    version: job.version,
    checksum: job.checksum,
    status: row?.status ?? "not_started",
    processedUsers: Number(row?.processed_users ?? 0),
    cursorUserId: row?.cursor_user_id ?? null,
    upperUserId: row?.upper_user_id ?? null,
    failedUserId: row?.failed_user_id ?? null,
  };
}

/** Read-only, including when the release ledger has never been bootstrapped. */
export async function getPersistenceJobStatus({ client, jobIds = DEFAULT_RELEASE_JOB_IDS, registry = PERSISTENCE_JOB_REGISTRY }) {
  const jobs = resolveJobs(jobIds, registry);
  if (!jobs.length) return [];
  const existing = await client.query("select to_regclass('marginchat_persistence_jobs') as relation");
  if (!existing.rows[0]?.relation) return jobs.map((job) => statusFor(job, null));
  const result = await client.query("select * from marginchat_persistence_jobs where id = any($1::text[])", [jobIds]);
  const rows = new Map(result.rows.map((row) => [row.id, row]));
  return jobs.map((job) => statusFor(job, rows.get(job.id)));
}

async function transaction(client, operation) {
  await client.query("begin");
  try {
    const result = await operation();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function runJob({ client, database, vaultService, job, onEvent, batchSize }) {
  return withSessionLock(client, `marginchat-persistence-job:${job.id}`, async () => {
    let result = await client.query("select * from marginchat_persistence_jobs where id = $1", [job.id]);
    let row = result.rows[0];
    assertIdentity(job, row);
    if (row?.status === "complete") {
      await onEvent({ type: "job_already_complete", ...statusFor(job, row) });
      return statusFor(job, row);
    }
    if (job.requiresVault && (!vaultService?.configured || typeof vaultService.rebuild !== "function")) {
      throw new Error(`Persistence job ${job.id} requires configured durable vault storage.`);
    }
    if (!row) {
      result = await client.query(
        `insert into marginchat_persistence_jobs (id, version, checksum, status, upper_user_id)
         values ($1, $2, $3, 'running', (select id from marginchat_users order by id desc limit 1))
         returning *`, [job.id, job.version, job.checksum],
      );
      row = result.rows[0];
    } else {
      await client.query("update marginchat_persistence_jobs set status = 'running', updated_at = now() where id = $1", [job.id]);
      row.status = "running";
    }
    await onEvent({ type: "job_started", ...statusFor(job, row) });

    async function processUser(userId) {
      await client.query(
        `insert into marginchat_persistence_job_users (job_id, user_id, status)
         values ($1, $2, 'running') on conflict (job_id, user_id) do update
         set status = 'running', attempts = marginchat_persistence_job_users.attempts + 1, updated_at = now()`,
        [job.id, userId],
      );
      try {
        await job.execute({ userId, client, database, vaultService });
      } catch (error) {
        // A custom handler may have failed inside its own transaction. Clear an
        // aborted transaction before recording a durable retry receipt.
        await client.query("rollback");
        await transaction(client, async () => {
          await client.query("update marginchat_persistence_job_users set status = 'failed', updated_at = now() where job_id = $1 and user_id = $2", [job.id, userId]);
          await client.query("update marginchat_persistence_jobs set status = 'failed', failed_user_id = $2, updated_at = now() where id = $1", [job.id, userId]);
        });
        await onEvent({ type: "job_user_failed", id: job.id, userId });
        // Avoid writing provider errors or document content into durable ledgers.
        throw new Error(`Persistence job ${job.id} failed for account ${userId}; retry resumes this account.`, { cause: error });
      }
      await transaction(client, async () => {
        await client.query("update marginchat_persistence_job_users set status = 'complete', updated_at = now(), completed_at = now() where job_id = $1 and user_id = $2", [job.id, userId]);
        result = await client.query(
          `update marginchat_persistence_jobs set cursor_user_id = $2, processed_users = processed_users + 1,
           failed_user_id = null, updated_at = now() where id = $1 returning *`, [job.id, userId],
        );
        row = result.rows[0];
      });
      await onEvent({ type: "job_user_complete", userId, ...statusFor(job, row) });
    }

    // Retry a failed/interrupted account even if it was deleted after the crash.
    // The cursor advances only in the transaction that records its completion.
    const pending = await client.query(
      "select user_id from marginchat_persistence_job_users where job_id = $1 and status <> 'complete' order by user_id",
      [job.id],
    );
    for (const item of pending.rows) await processUser(item.user_id);
    while (row.upper_user_id !== null) {
      const users = await client.query(
        `select id from marginchat_users where ($1::text is null or id > $1)
         and id <= $2 and created_at <= $3 order by id limit $4`,
        [row.cursor_user_id, row.upper_user_id, row.started_at, batchSize],
      );
      if (!users.rows.length) break;
      for (const user of users.rows) await processUser(user.id);
    }
    result = await client.query(
      "update marginchat_persistence_jobs set status = 'complete', failed_user_id = null, updated_at = now(), completed_at = now() where id = $1 returning *",
      [job.id],
    );
    const status = statusFor(job, result.rows[0]);
    await onEvent({ type: "job_complete", ...status });
    return status;
  });
}

/**
 * client MUST be one connected pg.Client, or one pool.connect() lease retained
 * until this promise settles. A transaction-pooled URL / pool.query() is unsafe
 * for the session advisory lock. Handlers run at least once, never exactly once.
 */
export async function runPersistenceJobs({ client, database, vaultService, jobIds = DEFAULT_RELEASE_JOB_IDS, registry = PERSISTENCE_JOB_REGISTRY, onEvent = () => {}, batchSize = 100 }) {
  const jobs = resolveJobs(jobIds, registry);
  if (!jobs.length) return [];
  if (!Number.isSafeInteger(batchSize) || batchSize < 1 || batchSize > 1000) {
    throw new Error("Persistence job batch size must be between 1 and 1000.");
  }
  // Validate all selected handlers and recorded identities before starting any.
  await getPersistenceJobStatus({ client, jobIds, registry });
  await ensurePersistenceJobTables(client);
  const statuses = [];
  for (const job of jobs) statuses.push(await runJob({ client, database, vaultService, job, onEvent, batchSize }));
  return statuses;
}
