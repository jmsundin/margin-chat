import { pathToFileURL } from "node:url";
import pg from "pg";
import { buildConnectionOptions } from "../server/db/config.mjs";
import { createAppDatabase } from "../server/db/index.mjs";
import { createVaultService } from "../server/vault/index.mjs";
import { getPersistenceJobStatus, runPersistenceJobs } from "../server/releases/jobs.mjs";

const usage = "Usage: bun --no-env-file scripts/persistence-jobs.mjs <status|run> --expected-host <host> --expected-database <database> [--job <registered-id>]...";

export function parsePersistenceJobArguments(argv) {
  if (argv.length === 1 && ["--help", "-h"].includes(argv[0])) return { help: true };
  const [command, ...args] = argv;
  if (!["status", "run"].includes(command)) throw new Error(usage);
  const options = { command, jobIds: [], expectedHost: null, expectedDatabase: null };
  for (let i = 0; i < args.length; i += 2) {
    const key = args[i];
    const value = args[i + 1];
    if (!["--job", "--expected-host", "--expected-database"].includes(key) || !value || value.startsWith("--")) {
      throw new Error(usage);
    }
    if (key === "--job") options.jobIds.push(value);
    else {
      const field = key === "--expected-host" ? "expectedHost" : "expectedDatabase";
      if (options[field]) throw new Error(`Specify ${key} only once.`);
      options[field] = value;
    }
  }
  if (!options.expectedHost || !options.expectedDatabase) throw new Error(usage);
  return options;
}

export function persistenceJobConnection(env, { expectedHost, expectedDatabase }) {
  const connectionString = env.MIGRATION_DATABASE_URL || env.DATABASE_URL_UNPOOLED;
  if (!connectionString) throw new Error("Set MIGRATION_DATABASE_URL or DATABASE_URL_UNPOOLED to the direct database endpoint.");
  let url;
  try { url = new URL(connectionString); }
  catch { throw new Error("The direct migration database URL is invalid."); }
  if (!["postgres:", "postgresql:"].includes(url.protocol)) throw new Error("A Postgres connection URL is required.");
  if (url.hostname.toLowerCase() !== expectedHost.toLowerCase() || decodeURIComponent(url.pathname.slice(1)) !== expectedDatabase) {
    throw new Error("The direct database URL does not match the expected host and database.");
  }
  if (/-pooler(?:\.|$)/u.test(url.hostname)) throw new Error("Persistence jobs require a direct endpoint; Neon pooled hostnames are not supported.");
  return {
    connectionString,
    options: buildConnectionOptions({ ...env, DATABASE_URL: connectionString }),
  };
}

export async function main(argv = process.argv.slice(2), env = process.env) {
  const args = parsePersistenceJobArguments(argv);
  if (args.help) { console.log(usage); return; }
  const connection = persistenceJobConnection(env, args);
  const client = new pg.Client(connection.options);
  let database;
  try {
    await client.connect();
    const actual = await client.query("select current_database() as database");
    if (actual.rows[0]?.database !== args.expectedDatabase) throw new Error("The connected database does not match the expected database.");
    if (args.command === "status") {
      console.log(JSON.stringify(await getPersistenceJobStatus({ client, jobIds: args.jobIds }), null, 2));
      return;
    }
    if (!args.jobIds.length) {
      console.log("[]");
      return;
    }
    database = createAppDatabase({ ...env, DATABASE_URL: connection.connectionString, DB_SCHEMA_MODE: "verify", NODE_ENV: "production" });
    await database.ready();
    const vaultService = createVaultService({ database, env });
    const result = await runPersistenceJobs({ client, database, vaultService, jobIds: args.jobIds,
      onEvent: (event) => console.log(JSON.stringify(event)),
    });
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await database?.close();
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
