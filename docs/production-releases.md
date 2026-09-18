# Production releases and persistence changes

Run `bun run vercel:sync` after the reviewed commit has deployed to production. It applies declared Vercel settings and environment variables, pending database migrations, and registered persistence jobs, then rebuilds and verifies the same commit before activating the refreshed deployment. A separate production release command and GitHub Actions workflow handle changes that need migrations before the code goes live.

**Setup status:** locally tested; production has not been contacted or changed. The Vercel IDs are prefilled from this checkout's project link. Neon IDs, Blob store IDs, the production origin, and CI secrets need one-time configuration. The plan command reports missing configuration without contacting cloud services.

## After the code has deployed

Once the setup below is complete, your routine command is:

```sh
bun run vercel:sync
```

To inspect the local recipe or the last execution report:

```sh
bun run vercel:plan
bun run release:status
```

Have the agent include the migration files, registered job IDs in `release.config.json`, and Vercel updates in the feature's commit. Run from that exact clean checkout after it is the current READY production deployment. The command checks the deployment's project, production alias, and full Git commit metadata against local HEAD before any cloud writes. A preview deployment, an older production commit, or a deployment without verifiable commit metadata is rejected. Pending work comes from committed migrations and declared jobs, not an inferred schema diff.

The runner captures database/Blob recovery checkpoints, rehearses persistence changes in isolated stores, applies pending migrations, syncs Vercel configuration, stages the same source commit, runs pending jobs, verifies the candidate, promotes it, and checks production. It holds the same release lock as the full workflow. No interactive prompts are required once credentials and provider IDs are configured.

Every successful sync creates a fresh deployment, including retries with no remaining database changes. Vercel environment changes apply to future deployments; rebuilding ensures an interrupted configuration update cannot leave the live deployment using old values. SQL migration receipts and completed job receipts prevent repeating completed data work. Recovery snapshots and deployments are created again on each run.

**Timing:** this command runs after the application is already live. The deployed application must work with the old schema/data while sync is running. For initial migration-ledger adoption or code that requires a new schema immediately, use `release:production` below to migrate before promotion. An after-deployment command cannot prevent errors that occurred before it ran. Browser/extension persistence changes still need compatible migrations in their own code.

### Declare Vercel updates

`vercel.updates.json` starts with empty declarations. Build settings already in `vercel.json` are automatically synchronized to the Vercel project. For example, the agent can commit:

```json
{
  "schemaVersion": 1,
  "project": {
    "nodeVersion": "24.x"
  },
  "environment": [
    { "key": "FEATURE_SEARCH_ENABLED", "value": "true" },
    { "key": "SEARCH_API_TOKEN", "fromEnv": "DEPLOY_SEARCH_API_TOKEN" }
  ]
}
```

These are illustrative keys; adding an environment variable does not implement the corresponding feature. Public configuration uses `value` and plain storage. Secrets use `fromEnv`, resolved from the runner's environment, with encrypted storage by default; `"type": "sensitive"` is supported. Store the secret once in your execution environment, then let subsequent syncs use it. Missing inputs fail before mutations. Plans and execution receipts contain variable names, never their values. The inner scripts disable dotenv loading; use `bun --no-env-file run vercel:sync` when you also want the outer Bun process to ignore local `.env` files.

Supported project fields are `framework`, `buildCommand`, `installCommand`, `outputDirectory`, `devCommand`, and `nodeVersion`. Change a field in `vercel.json` when it is already declared there; conflicting declarations fail because that file takes precedence. Project settings affect future deployments of all environments; environment declarations target production only.

Only declared variables are created or updated. Existing production-only variables are updated in place; preview-only variables of the same name remain separate. Shared production/preview/custom-environment variables and integration-owned/system variables must first be converted to project-owned production-only configuration through a reviewed setup change. The runner rejects these cases before mutations instead of splitting scopes across non-atomic API calls. It preserves existing sensitive storage and refuses to convert a secret into plain text. Removing a declaration stops managing the variable; it does not delete it remotely.

Database/Blob targets, vault prefix, schema mode, and release identity remain managed by the release runner's candidate overrides. They cannot be overridden through this manifest. Encryption-key rotation requires its own compatible data transition; `API_KEY_ENCRYPTION_KEY` is reserved. The command does not create cloud accounts/stores, change domains, or infer arbitrary Vercel administration actions.

Configuration writes persist if a later deployment or verification fails. Inspect `release:status`, fix the reported failure, and rerun `vercel:sync` from the same deployed commit. The retry reads current Vercel state, re-applies declared values, and rebuilds to activate them. App rollback does not roll back project settings, environment declarations, or data. Do not run independent deployments or dashboard edits concurrently; routing is checked again before migrations, configuration, staging, and promotion.

## Release before the code goes live

Ask the agent to prepare the feature and its persistence migrations in one reviewed commit, then release that commit. Alternatively, run **Production release** in GitHub Actions with its full 40-character Git SHA. A release needs no SQL-console work or per-account rebuild requests.

From an exact clean release checkout with credentials already exported:

```sh
bun --no-env-file run release:plan
bun --no-env-file run release:production
bun --no-env-file run release:status
```

`plan` is local and read-only. `production` performs real cloud writes and deployment; it refuses an uncommitted checkout or missing configuration. `status` reads the latest local report. In CI, read the retained release-report artifact instead.

Retry a failed release after fixing its reported issue. A retry creates a fresh rehearsal/recovery checkpoint, while already committed SQL migrations and completed data jobs are skipped after checksum verification. New kinds of data transformation need code and verification written alongside the feature; the runner does not infer the intended transformation from a schema diff.

## One-time setup

Fill in and commit `release.config.json`:

| Field | Value |
| --- | --- |
| `vercel.projectId`, `vercel.orgId` | Existing project/team IDs, prefilled from the local Vercel link. |
| `neon.projectId`, `neon.productionBranchId` | Explicit production project and branch IDs. |
| `neon.databaseName`, `neon.roleName` | Database and role with migration, application, and job permissions. |
| `productionUrl` | HTTPS origin already assigned to the current production deployment. |
| `blob.productionStoreId` | Existing private vault store ID, as encoded in its read/write token. |
| `blob.backupStoreId`, `blob.rehearsalStoreId` | Two separate private stores for backups and rehearsals. |
| `jobs` | Registered job IDs needed for this release; defaults to an empty list. |
| `compatibility` | Compatibility with the serving application and delayed clients; automatic app rollback defaults to false for the first transition. |
| `observation` | Number and interval of post-promotion readiness checks. |

Configure these secrets once in the environment running the local command, or in the GitHub repository environment named `production` for the workflow:

- `NEON_API_KEY`: configured project access, branch creation, and connection URI lookup.
- `VERCEL_TOKEN`: configured Vercel project/team deployment and promotion access.
- `BLOB_READ_WRITE_TOKEN`: the existing production private vault store.
- `REHEARSAL_BLOB_READ_WRITE_TOKEN`: a separate private rehearsal store.
- `BACKUP_BLOB_READ_WRITE_TOKEN`: a separate private backup store.
- `VERCEL_AUTOMATION_BYPASS_SECRET`: the Vercel automation bypass secret for protected deployment checks.

Token store identities must match the configured IDs, and all three stores must differ. Rehearsal also verifies that already-migrated accounts have their vaults in the backup, so an empty wrong store cannot pass merely because synthetic writes work.

Keep the normal production application configuration in Vercel, especially the existing `API_KEY_ENCRYPTION_KEY`. The runner preserves those settings and supplies explicit database/vault targets and release identity to the candidate. CI uses explicit Blob read/write tokens, even if the current app uses OIDC.

Protected Neon recovery branches require a plan supporting that feature and are the default. This project's Free plan explicitly sets `neon.recoveryBranchProtected: false`: the recovery snapshot is retained without a compute endpoint, but administrators can still delete or modify it. The rehearsal uses the same snapshot LSN, and separate private Blob backups are still required. No automatic fallback changes protection after an API failure. Recovery branches, rehearsal branches, backup objects, and rehearsal prefixes are retained. Choose suitable access and retention policies during setup; this implementation does not automatically delete recovery history. CI reports are retained for 30 days.

`vercel.json` disables independent Git-triggered deployments, including push-triggered previews, so they cannot bypass the migration workflow. CLI deployments still work. The workflow must exist on the default branch before GitHub can dispatch it. Existing environment review requirements, if configured by the repository owner, still apply.

## The automated sequence

| Stage | Behavior |
| --- | --- |
| Validate | Verify project/branch/store identities and current production alias; install from the frozen Bun lockfile; run all tests and client/extension builds; require a clean checkout. |
| Lock | Hold a direct Postgres session advisory lock across the release. GitHub additionally serializes all production refs without canceling a running release. |
| Checkpoint | Create a protected recovery branch and an isolated rehearsal branch at the same production LSN. Copy private Blob objects and verify a backup inventory. Record resource identities as they are created. |
| Rehearse | Restore Blob into a unique prefix in the separate rehearsal store. Migrate the isolated database; check account identity, money, captures, and encrypted-key invariants; run jobs; recheck invariants; exercise the real API. |
| Migrate | Apply pending checksummed SQL migrations once. Production startup verifies the migration ledger rather than executing DDL. |
| Stage | Create a Vercel production candidate with `--prod --skip-domain`; verify its project, readiness, and commit metadata. |
| Jobs | Run declared jobs with durable progress. Every declared job must finish before promotion; no jobs run implicitly. |
| Verify candidate | Check fresh database/schema readiness and release identity, then login/save/read/conflict/history/binary/deletion/projection behavior through the candidate. |
| Promote | Confirm production routing has not changed outside this release, then promote the verified candidate. |
| Verify production | Observe readiness on the public origin, repeat persistence checks, and verify the migration ledger. |

Smoke checks create a unique synthetic admin account with a random password and write only its vault. They remove its SQL records and exact Blob prefix afterward. They do not send email, buy credits, call model providers, or use real user credentials. Cleanup failure fails the release. Rehearsal uses an explicit environment without local dotenv or production integration secrets.

Health returns 503 on database readiness failure, performs a fresh database query and required migration-prefix check, and exposes release identity and vault configuration. Synthetic writes verify Blob functionality; a configured flag alone is insufficient. Ordinary vault reads for real users can initialize legacy data and rebuild projections, so they are not used as harmless readiness probes.

Reports are saved atomically under `.codex-artifacts/releases/<release-id>.json`, excluded from Git, and uploaded by CI on success or failure. Reports contain stage results, migration/job progress, resource references, and sanitized errors. Private Blob backup inventories include path/hash metadata and are not printed into ordinary logs.

## Schema migrations

The source is `server/db/migrations/manifest.json` and its immutable SQL files. `0001_baseline.sql` freezes the working-tree schema when this workflow was introduced.

1. Add an ordered file such as `0002_add_projection_version.sql`.
2. Append its ID/file and `"transaction": true` to the manifest.
3. Add upgrade and compatibility tests. Never edit a migration that has already run.
4. Run the normal release workflow.

Editing only `server/db/schema.sql` no longer changes production. Tests initialize their isolated databases through the migration runner.

The runner records IDs and SHA-256 checksums in `marginchat_schema_migrations`, rejects edited/unknown/out-of-order history, and commits each migration with its ledger entry. It uses one migration lock on one connection with lock/statement timeouts. After a connection failure, recheck the ledger instead of assuming whether a commit succeeded.

Only transactional migrations are supported initially. Embedded transaction commands, undeclared SQL files, and `CREATE INDEX CONCURRENTLY` are rejected. Large/nontransactional schema work requires a tested runner extension. Runtime verification permits newer appended migrations for compatible older deployments; arbitrary destructive changes still require expand/migrate/contract releases.

The initial baseline actually executes against existing unversioned databases and is recorded only after success. It includes historical normalization and constraint changes. Its adoption is rehearsed on the selected production snapshot and checked for protected-data changes; local fixtures alone do not establish the deployed schema.

For explicit administration by the agent, export `MIGRATION_DATABASE_URL` or `DATABASE_URL_UNPOOLED` and use the lower-level CLI with target, expected host, and expected database:

```sh
bun --no-env-file scripts/database.mjs status --target production --expected-host <direct-host> --expected-database <database>
bun --no-env-file scripts/database.mjs migrate --target production --expected-host <direct-host> --expected-database <database>
```

The CLI rejects pooled Neon endpoints and does not silently fall back to the application URL. Routine deployments should use the release runner so rehearsal and recovery capture are included.

## Other persistence changes

Register static jobs in `server/releases/job-registry.mjs` with `definePersistenceJob`, then add their IDs to the release recipe. Each receives `{ userId, client, database, vaultService }`. New transformations need immutable IDs/versions and relevant helper source in their checksum inputs.

Jobs must be idempotent: a crash can repeat an account after its effects succeeded but before its receipt committed. The two persistence-job tables retain job identity, per-account receipts, enumeration cursor, failed account, and completion. Receipts/progress commit together. A pending projection cannot advance the checkpoint.

The included opt-in `vault-projection-v1` forces per-account rebuilding through the existing vault service, including initialization of legacy workspaces/originals. The default list is empty. A completed ID does not run again: register a new version when projection logic changes. New users outside a job's selected population must be handled by the new application code.

| Change | What the feature must supply |
| --- | --- |
| Additive SQL | Versioned expansion compatible with the old app. |
| Column replacement/removal | Expand, deploy compatible readers/writers, backfill/verify, then remove old structures in a later release. |
| Projection logic | New versioned rebuild job; the underlying runtime checkpoint currently tracks vault revision only. |
| Extraction/chunking/embeddings | Versioned index migration, compatible retrieval, verification, and rate/cost limits. Ordinary rebuilding preserves ready embeddings; current vectors have 1536 dimensions. |
| Vault/Markdown format | Compatible readers before new writers, preserved originals, and resumable conditional manifest updates. |
| Browser/extension storage | Recoverable local migration on next open/update, preserving unsynced edits and pending captures. Servers cannot update offline devices. |
| Encryption-key rotation | Key identifiers, old/new key support, verified re-encryption, then retirement after the recovery window. Ordinary releases keep the key stable. |

The runner rejects recipes declaring incompatible old app/client behavior. It does not currently implement write quiescence, online schema contraction, embedding conversion, or generic browser-format conversion. Those need feature-specific implementations prepared as compatible releases. This automation changes no existing content format, model, or encryption key.

## Backups, recovery, and limits

Blob backup captures each listed user's manifest once, retains the full initial object set and referenced immutable revisions, and validates revision hashes and references before publishing its private inventory. It can follow references added after the initial listing while users keep editing. Each captured manifest is recoverable; different users/objects may have different capture times. New accounts created after listing are outside that snapshot.

Neon and Blob are separate recovery boundaries. A database branch does not back up Blob, and two independent snapshots are not globally atomic. Postgres owns accounts, billing, captures, and encrypted keys; migrated vaults own Markdown, originals, manifests, history, and tombstones. Unsynchronized browser data is outside both backups. See [markdown-vault.md](markdown-vault.md).

Before promotion, failure leaves the current app serving and successful compatible SQL migrations applied. Retry after resolving the reported issue; never replace production with the rehearsal branch.

Automatic app rollback may be enabled after the first transition. It requires the previous deployment's migration-protocol marker, checks that the candidate still owns production routing, restores that deployment, and verifies readiness. It handles an uncertain promotion by inspecting routing first. It never reverses database or Blob writes and refuses to overwrite an unrelated deployment.

For corrupted authoritative data, orchestrate recovery separately: stop affected writes, reconcile writes since the checkpoints, recover the selected database/vault state, and rebuild projections. Retain encryption material too. Do not rewind manifest counters or restore an old database over newer writes without reconciliation.

The first implementation runs within a 120-minute CI job, buffers one Blob object at a time, and uses the existing per-account rebuild service. Very large accounts/stores may need streaming backups and a longer-lived worker. Retention cleanup is not automated. The observation window checks availability/persistence, not production error-rate/tracing systems. Existing offline/contract tests run, but the workflow does not open every previously released browser client.

## References

- [Vercel staged deployments](https://vercel.com/docs/cli/deploying-from-cli)
- [Vercel environment updates and redeployment](https://vercel.com/docs/environment-variables/managing-environment-variables)
- [Vercel REST API schemas](https://openapi.vercel.sh)
- [Vercel Git deployment configuration](https://vercel.com/docs/project-configuration/git-configuration)
- [Vercel instant rollback](https://vercel.com/docs/instant-rollback)
- [Neon branches and migration automation](https://neon.com/blog/branching-with-preview-environments)
- [Neon API schema and protected branches](https://neon.com/api_spec/release/v2.json)
- [Vercel Blob conditional writes](https://vercel.com/docs/vercel-blob)
