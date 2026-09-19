import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { randomUUID, createHash } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import assert from "node:assert/strict";
import pg from "pg";
import { createAppContext } from "../server/app.mjs";
import { loadMigrations, migrateDatabase, inspectMigrations } from "../server/db/migrations.mjs";
import { runPersistenceJobs } from "../server/releases/jobs.mjs";
import { PERSISTENCE_JOB_REGISTRY } from "../server/releases/job-registry.mjs";
import { readReleaseConfig, configurationGaps, redact } from "./release/config.mjs";
import { executeRelease, RELEASE_STEPS, VERCEL_SYNC_STEPS } from "./release/sequence.mjs";
import { readVercelUpdates, describeVercelUpdates, assertDeployedCommit, assertProductionAlias, createVercelApi, planVercelUpdates, applyVercelUpdates } from "./release/vercel-updates.mjs";
import { checkReadiness, runPersistenceSmoke } from "./release/smoke.mjs";
import { createNeonReleaseProvider, validateBlobStoreTokens, backupBlobStore, restoreBlobBackup } from "./release/providers.mjs";

const exec = promisify(execFile);
const root = fileURLToPath(new URL("../", import.meta.url));
const RELEASE_LOCK_KEY = 70421934;

async function command(program, args, env = process.env) {
  const { stdout } = await exec(program, args, { cwd: root, env, timeout: 20 * 60_000, maxBuffer: 12 * 1024 * 1024 });
  return stdout.trim();
}

async function localPlan(config, env) {
  const sha = await command("git", ["rev-parse", "HEAD"]);
  const dirty = Boolean(await command("git", ["status", "--porcelain", "--untracked-files=all"]));
  for (const id of config.jobs) if (!Object.hasOwn(PERSISTENCE_JOB_REGISTRY, id)) throw new Error(`Unregistered release job: ${id}`);
  return { sha, dirty, migrations: (await loadMigrations()).map(({ id, checksum }) => ({ id, checksum })),
    jobs: config.jobs, steps: RELEASE_STEPS, missingConfiguration: configurationGaps(config, env),
    productionUrl: config.productionUrl || null, cloudAccess: "not contacted" };
}

async function connect(connectionString) {
  const url = new URL(connectionString);
  if (!/^postgres(?:ql)?:$/u.test(url.protocol) || url.hostname.includes("-pooler.")) throw new Error("Release jobs require a direct Postgres connection.");
  const client = new pg.Client({ connectionString, connectionTimeoutMillis: 30_000, keepAlive: true });
  client.on("error", () => {}); // Queries fail closed; avoid an unhandled idle socket event.
  await client.connect();
  return client;
}

function appEnv(url, token, prefix = "") {
  // An explicit environment prevents local .env files, Stripe, email, and model
  // credentials from leaking into the rehearsal or batch projection runner.
  return { DATABASE_URL: url, BLOB_READ_WRITE_TOKEN: token, VAULT_STORAGE_PREFIX: prefix,
    NODE_ENV: "production", DB_SCHEMA_MODE: "verify", SECURE_AUTH_COOKIES: "false" };
}

async function withLocalApi(context, callback) {
  const server = createServer(context.apiHandler);
  await new Promise((done, reject) => { server.once("error", reject); server.listen(0, "127.0.0.1", done); });
  try { return await callback(`http://127.0.0.1:${server.address().port}`); }
  finally { server.closeAllConnections(); await new Promise((done) => server.close(done)); }
}

// Preserve authoritative account identity and money. Hash inside Postgres so
// user records never enter release logs. Content projections may legitimately change.
async function authoritativeFingerprint(client, baseline) {
  const result = {};
  for (const [label, names, columns] of [
    ["accounts", ["marginchat_users", "marginchat_user_accounts"], ["id", "email", "password_hash", "stripe_customer_id", "hosted_credit_balance_micros"]],
    ["billing", ["marginchat_billing_ledger"], ["id", "user_id", "amount_micros", "entry_type", "stripe_checkout_session_id", "request_id"]],
    ["captures", ["marginchat_captures"], ["id", "user_id", "client_capture_id", "payload", "payload_hash"]],
    ["keys", ["marginchat_user_api_keys"], ["user_id", "provider", "encrypted_api_key"]],
  ]) {
    for (const table of names) {
      const present = await client.query("select to_regclass($1) as name", [table]);
      if (!present.rows[0].name) continue;
      const fields = await client.query("select column_name from information_schema.columns where table_schema = 'public' and table_name = $1", [table]);
      const available = baseline?.[label]?.columns ?? columns.filter((name) => fields.rows.some((row) => row.column_name === name));
      if (baseline?.[label] && available.some((name) => !fields.rows.some((row) => row.column_name === name))) {
        throw new Error(`Migration removed authoritative ${label} columns.`);
      }
      if (!available.length) throw new Error(`Cannot verify authoritative ${label} records.`);
      const rows = await client.query(`select count(*)::text as count, md5(coalesce(string_agg(row_digest, '' order by row_digest), '')) as digest
        from (select md5(jsonb_build_array(${available.join(",")})::text) as row_digest from ${table}) records`);
      result[label] = { ...rows.rows[0], columns: available };
      break;
    }
  }
  return result;
}

export async function releaseProduction({ config, env = process.env, onProgress = console.log, postDeploy = false }) {
  const plan = await localPlan(config, env);
  const updates = postDeploy ? await readVercelUpdates(env) : null;
  if (updates?.missing.length) throw new Error(`Missing Vercel update secrets: ${updates.missing.join(", ")}`);
  if (plan.dirty) throw new Error("Commit the reviewed release changes first. Production releases require a clean checkout.");
  if (plan.missingConfiguration.length) throw new Error(`Release setup is incomplete: ${plan.missingConfiguration.join(", ")}`);
  const stores = validateBlobStoreTokens({ sourceToken: env.BLOB_READ_WRITE_TOKEN, backupToken: env.BACKUP_BLOB_READ_WRITE_TOKEN, rehearsalToken: env.REHEARSAL_BLOB_READ_WRITE_TOKEN });
  for (const [configured, actual] of [["productionStoreId", "sourceStoreId"], ["backupStoreId", "backupStoreId"], ["rehearsalStoreId", "rehearsalStoreId"]]) {
    if (config.blob[configured].toLowerCase() !== stores[actual]) throw new Error(`Blob token does not match configured blob.${configured}.`);
  }
  const id = `${new Date().toISOString().replace(/[^0-9]/gu, "").slice(0, 14)}-${plan.sha.slice(0, 12)}-${randomUUID().slice(0, 8)}`;
  const artifactDirectory = resolve(root, ".codex-artifacts/releases");
  await mkdir(artifactDirectory, { recursive: true, mode: 0o700 });
  const reportPath = resolve(artifactDirectory, `${id}.json`);
  const privateSecrets = Object.entries(env).filter(([key]) => /TOKEN|SECRET|PASSWORD|KEY|DATABASE_URL/u.test(key)).map(([, value]) => value);
  privateSecrets.push(...(updates?.environment.map(({ value }) => value) ?? []));
  const describeError = (error) => redact(error?.message ?? error, privateSecrets);
  const resources = { blobInventory: `releases/${id}/inventory.json` };
  let latestReport;
  const neon = createNeonReleaseProvider({ config: config.neon, env, onBranch: async (role, branch) => {
    resources[`${role}Branch`] = branch;
    if (latestReport) await events(latestReport);
  } });
  const migrations = await loadMigrations();
  let productionClient, productionUrl, pooledUrl, previous, candidate, branches, backup, productionContext;
  let clientFailure;
  const prefix = `release-rehearsal/${id}/`;
  const vercelEnv = { ...env, VERCEL_ORG_ID: config.vercel.orgId, VERCEL_PROJECT_ID: config.vercel.projectId };
  const vercelApi = createVercelApi({ config: config.vercel, token: env.VERCEL_TOKEN });
  const project = () => vercelApi(`/v9/projects/${encodeURIComponent(config.vercel.projectId)}`);
  async function assertLock() {
    if (clientFailure) throw new Error("The production release lock connection was lost. Start a new release to recheck the current state.");
    await productionClient.query("select 1");
  }
  async function assertReleaseInputs() {
    const current = await localPlan(config, env);
    assert.equal(current.dirty, false, "Release files changed during this run. Commit and restart the release.");
    assert.equal(current.sha, plan.sha, "HEAD changed during this run. Restart from the deployed commit.");
    if ((await project()).targets?.production?.id !== previous.id) throw new Error("Production changed outside this release. Start a new run.");
  }
  const events = async (report) => {
    latestReport = report;
    const saved = { id, sha: plan.sha, mode: postDeploy ? "vercel-sync" : "production", reportPath, resources, ...report };
    await writeFile(`${reportPath}.tmp`, `${JSON.stringify(saved, null, 2)}\n`, { mode: 0o600 });
    await rename(`${reportPath}.tmp`, reportPath);
    const last = report.steps.at(-1);
    onProgress(`${report.status}: ${last?.name ?? "release"} ${last?.status ?? ""}`.trim());
  };
  try {
    const report = await executeRelease({ postDeploy, automaticAppRollback: config.compatibility.automaticAppRollback, onEvent: events, effects: {
      describeError,
      async validate() {
        const vercelConfig = JSON.parse(await readFile(resolve(root, "vercel.json"), "utf8"));
        if (!postDeploy) assert.equal(vercelConfig.git?.deploymentEnabled, false, "Disable independent Vercel Git deployments before using the release workflow.");
        await neon.validateProduction();
        const current = await project();
        assert.equal(current.id, config.vercel.projectId);
        const target = current.targets?.production;
        if (!target?.id) throw new Error("No existing production deployment was found. Bootstrap the project before using this upgrade workflow.");
        previous = await vercelApi(`/v13/deployments/${encodeURIComponent(target.id)}`);
        if (postDeploy) {
          assertDeployedCommit(previous, config.vercel.projectId, plan.sha);
          await planVercelUpdates({ api: vercelApi, projectId: config.vercel.projectId, updates });
        }
        if (config.compatibility.automaticAppRollback && previous.meta?.marginPersistenceProtocol !== "1") {
          throw new Error("The previous deployment predates the migration protocol. Disable automaticAppRollback for the first transition release.");
        }
        await assertProductionAlias({ api: vercelApi, productionUrl: config.productionUrl,
          projectId: config.vercel.projectId, deploymentId: target.id });
        // Validation never inherits production credentials or local dotenv files.
        const validationEnv = Object.fromEntries(["PATH", "HOME", "TMPDIR", "CI"].filter((key) => env[key]).map((key) => [key, env[key]]));
        await command("bun", ["--no-env-file", "install", "--frozen-lockfile", "--ignore-scripts"], validationEnv);
        await command("bun", ["--no-env-file", "test"], validationEnv);
        await command("bun", ["--no-env-file", "run", "build"], validationEnv);
        await command("bun", ["--no-env-file", "run", "build:extension"], validationEnv);
        assert.equal((await localPlan(config, env)).dirty, false, "Validation changed tracked release inputs.");
        return { sha: plan.sha, previousDeployment: previous.id, checks: ["tests", "client build", "extension build"] };
      },
      async lock() {
        productionUrl = await neon.connectionUri(config.neon.productionBranchId);
        pooledUrl = await neon.connectionUri(config.neon.productionBranchId, { pooled: true });
        privateSecrets.push(productionUrl, pooledUrl);
        productionClient = await connect(productionUrl);
        productionClient.on("error", (error) => { clientFailure = error; });
        const lock = await productionClient.query("select pg_try_advisory_lock($1) as locked", [RELEASE_LOCK_KEY]);
        if (!lock.rows[0]?.locked) throw new Error("Another production release is running. Retry when it finishes.");
        // Recheck routing after taking the global lock; another release may have
        // completed during this run's local validation.
        if ((await project()).targets?.production?.id !== previous.id) throw new Error("Production changed during validation. Start a new release.");
        return { acquired: true };
      },
      async checkpoint() {
        await assertLock();
        branches = await neon.ensureReleaseBranches(id);
        backup = await backupBlobStore({ releaseId: id, sourceToken: env.BLOB_READ_WRITE_TOKEN, backupToken: env.BACKUP_BLOB_READ_WRITE_TOKEN });
        return { recoveryBranch: branches.recovery.id, rehearsalBranch: branches.rehearsal.id,
          blobInventory: backup.inventoryPathname, blobInventorySha256: backup.inventorySha256, objectCount: backup.objectCount,
          recoveryBoundary: "Database branch and Blob inventory are separate checkpoints; reconcile projections when recovering." };
      },
      async rehearse() {
        await assertLock();
        await restoreBlobBackup({ inventory: backup.inventory, backupToken: env.BACKUP_BLOB_READ_WRITE_TOKEN,
          targetToken: env.REHEARSAL_BLOB_READ_WRITE_TOKEN, targetPrefix: prefix.replace(/\/$/u, "") });
        const rehearsalUrl = await neon.connectionUri(branches.rehearsal.id);
        privateSecrets.push(rehearsalUrl);
        const client = await connect(rehearsalUrl);
        let context;
        try {
          const before = await authoritativeFingerprint(client);
          const result = await migrateDatabase(client, { migrations });
          const after = await authoritativeFingerprint(client, before);
          for (const [kind, fingerprint] of Object.entries(before)) {
            assert.deepEqual(after[kind], fingerprint, `Migration altered authoritative ${kind}; provide a separately verified transition before this release.`);
          }
          context = createAppContext(appEnv(rehearsalUrl, env.REHEARSAL_BLOB_READ_WRITE_TOKEN, prefix));
          await context.database.ready();
          // A configured token must also contain the already-migrated users'
          // vaults; synthetic writes alone would pass against an empty wrong store.
          let lastUser = "";
          for (;;) {
            const checkpoints = await client.query("select user_id, vault_revision from marginchat_vault_projections where user_id > $1 and vault_revision > 0 order by user_id limit 100", [lastUser]);
            if (!checkpoints.rows.length) break;
            for (const row of checkpoints.rows) {
              const key = `vaults/v1/${createHash("sha256").update(row.user_id).digest("hex")}/manifest.json`;
              if (!backup.inventory.objects.some((entry) => entry.pathname === key)) throw new Error("The Blob checkpoint is missing a migrated account's vault. Verify the configured production store.");
              const snapshot = await context.vaultService.snapshot(row.user_id);
              if (snapshot.manifest.revision < Number(row.vault_revision)) throw new Error("A captured vault is older than its database projection. Reconcile the production stores before releasing.");
              lastUser = row.user_id;
            }
          }
          const jobs = await runPersistenceJobs({ client, database: context.database, vaultService: context.vaultService, jobIds: config.jobs });
          const afterJobs = await authoritativeFingerprint(client, before);
          for (const [kind, fingerprint] of Object.entries(before)) assert.deepEqual(afterJobs[kind], fingerprint, `Data jobs altered authoritative ${kind}.`);
          const smoke = await withLocalApi(context, (baseUrl) => runPersistenceSmoke({ baseUrl, client, database: context.database,
            blobToken: env.REHEARSAL_BLOB_READ_WRITE_TOKEN, storagePrefix: prefix }));
          return { migrations: result.executed, jobs, smoke };
        } finally { await context?.database.close(); await client.end(); }
      },
      async migrate() {
        await assertLock();
        await assertReleaseInputs();
        const result = await migrateDatabase(productionClient, { migrations });
        productionContext = createAppContext(appEnv(productionUrl, env.BLOB_READ_WRITE_TOKEN));
        await productionContext.database.ready();
        return { executed: result.executed };
      },
      async configure() {
        await assertLock();
        await assertReleaseInputs();
        return applyVercelUpdates({ api: vercelApi, projectId: config.vercel.projectId, updates, onApplied: async (applied) => {
          resources.vercelUpdates = { ...applied, activation: "Requires successful candidate promotion; re-run sync after failure." };
          await events(latestReport);
        } });
      },
      async stage() {
        await assertLock();
        await assertReleaseInputs();
        const args = ["--no-env-file", "x", "--no-install", "vercel", "deploy", "--yes", "--prod", "--skip-domain",
          "--meta", "marginPersistenceProtocol=1", "--meta", `marginReleaseSha=${plan.sha}`];
        for (const [key, value] of Object.entries({ DATABASE_URL: pooledUrl, BLOB_READ_WRITE_TOKEN: env.BLOB_READ_WRITE_TOKEN,
          BLOB_STORE_ID: "", VAULT_STORAGE_DIR: "", VAULT_STORAGE_PREFIX: "", DB_SCHEMA_MODE: "verify", MARGIN_RELEASE_SHA: plan.sha })) {
          args.push("--env", `${key}=${value}`);
        }
        const output = await command("bun", args, vercelEnv);
        const url = output.split(/\s/u).findLast((entry) => /^https:\/\/[^/]+\.vercel\.app\/?$/u.test(entry));
        if (!url) throw new Error("Vercel did not return a deployment URL; inspect the release in Vercel before retrying.");
        candidate = await vercelApi(`/v13/deployments/${encodeURIComponent(new URL(url).hostname)}`);
        assert.equal(candidate.projectId, config.vercel.projectId);
        assert.equal(candidate.readyState, "READY");
        assert.equal(candidate.meta?.marginReleaseSha, plan.sha);
        return { id: candidate.id, url };
      },
      async jobs() {
        await assertLock();
        return runPersistenceJobs({ client: productionClient, database: productionContext.database, vaultService: productionContext.vaultService, jobIds: config.jobs });
      },
      async verifyCandidate() {
        await assertLock();
        const baseUrl = `https://${candidate.url}`;
        await checkReadiness({ baseUrl, expectedSha: plan.sha, bypassSecret: env.VERCEL_AUTOMATION_BYPASS_SECRET });
        return runPersistenceSmoke({ baseUrl, database: productionContext.database, client: productionClient,
          blobToken: env.BLOB_READ_WRITE_TOKEN, bypassSecret: env.VERCEL_AUTOMATION_BYPASS_SECRET });
      },
      async promote() {
        await assertLock();
        if ((await project()).targets?.production?.id !== previous.id) throw new Error("Production routing changed outside this release. Promotion stopped.");
        await command("bun", ["--no-env-file", "x", "--no-install", "vercel", "promote", candidate.id, "--yes"], vercelEnv);
        return { deployment: candidate.id };
      },
      async verifyProduction() {
        await assertLock();
        for (let index = 0; index < config.observation.checks; index += 1) {
          if (index) await delay(config.observation.intervalSeconds * 1000);
          await assertLock();
          await checkReadiness({ baseUrl: config.productionUrl, expectedSha: plan.sha, bypassSecret: env.VERCEL_AUTOMATION_BYPASS_SECRET });
        }
        const result = await runPersistenceSmoke({ baseUrl: config.productionUrl, database: productionContext.database, client: productionClient,
          blobToken: env.BLOB_READ_WRITE_TOKEN, bypassSecret: env.VERCEL_AUTOMATION_BYPASS_SECRET });
        await inspectMigrations(productionClient, { migrations });
        return result;
      },
      async rollback() {
        await assertLock();
        const current = (await project()).targets?.production?.id;
        if (current === previous.id) return { status: "not_needed", deployment: previous.id };
        if (current !== candidate?.id) throw new Error("Another deployment owns production; automatic rollback refused.");
        await command("bun", ["--no-env-file", "x", "--no-install", "vercel", "rollback", previous.id, "--yes"], vercelEnv);
        await checkReadiness({ baseUrl: config.productionUrl, expectedSha: previous.meta?.marginReleaseSha, bypassSecret: env.VERCEL_AUTOMATION_BYPASS_SECRET });
        return { status: "complete", deployment: previous.id, persistence: "retained; no database or Blob rollback" };
      },
      async unlock() { await productionClient.query("select pg_advisory_unlock($1)", [RELEASE_LOCK_KEY]); },
    } });
    return { id, ...report, resources, reportPath };
  } finally {
    await productionContext?.database.close();
    await productionClient?.end();
  }
}

async function main() {
  const [operation = "plan", ...args] = process.argv.slice(2);
  if (args.length) throw new Error("Usage: bun --no-env-file scripts/release.mjs plan|production|status|vercel-plan|vercel-sync. Run from the exact committed release checkout.");
  const config = await readReleaseConfig();
  if (operation === "plan") console.log(JSON.stringify(await localPlan(config, process.env), null, 2));
  else if (operation === "vercel-plan") {
    const plan = await localPlan(config, process.env);
    const updates = await readVercelUpdates();
    console.log(JSON.stringify({ ...plan, steps: VERCEL_SYNC_STEPS, vercelUpdates: describeVercelUpdates(updates),
      missingConfiguration: [...plan.missingConfiguration, ...updates.missing], prerequisite: "Current READY production deployment must match local HEAD; verified during sync." }, null, 2));
  } else if (operation === "production" || operation === "vercel-sync") {
    const report = await releaseProduction({ config, postDeploy: operation === "vercel-sync" });
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== "complete") process.exitCode = 1;
  } else if (operation === "status") {
    const { readdir } = await import("node:fs/promises");
    const directory = resolve(root, ".codex-artifacts/releases");
    let files;
    try { files = (await readdir(directory)).filter((path) => path.endsWith(".json")).sort(); }
    catch (error) { if (error.code !== "ENOENT") throw error; files = []; }
    if (!files.length) console.log("No local release reports. In CI, download the release-report artifact from the workflow run.");
    else console.log(await readFile(resolve(directory, files.at(-1)), "utf8"));
  } else throw new Error("Unknown release operation. Use plan, production, status, vercel-plan, or vercel-sync.");
}

if (import.meta.main) main().catch((error) => {
  console.error(redact(error.message, Object.entries(process.env).filter(([key]) => /TOKEN|SECRET|PASSWORD|KEY|DATABASE_URL/u.test(key)).map(([, value]) => value)));
  process.exitCode = 1;
});
