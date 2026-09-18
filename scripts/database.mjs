import { pathToFileURL } from "node:url";
import pg from "pg";
import { inspectMigrations, loadMigrations, migrateDatabase } from "../server/db/migrations.mjs";

const help = `Usage: bun scripts/database.mjs status|migrate --target local|preview|production
  --expected-host HOST --expected-database NAME
  [--url-env MIGRATION_DATABASE_URL|DATABASE_URL_UNPOOLED]

The connection URL is read only from the selected environment variable (default:
MIGRATION_DATABASE_URL). Use a direct connection, never a transaction pooler.
The script does not load environment files or use the application's DATABASE_URL.
Status is read-only and exits 2 when migrations are pending. Migrate applies only
unapplied, transactional SQL migrations under one database advisory lock.
`;

export function parseDatabaseArguments(args) {
  if (args.includes("--help") || args.includes("-h")) return { help: true };
  const [command, ...flags] = args;
  if (!["status", "migrate"].includes(command)) throw new Error("Choose status or migrate. Use --help for usage.");
  const values = {};
  const allowed = new Set(["--target", "--expected-host", "--expected-database", "--url-env"]);
  for (let index = 0; index < flags.length; index += 2) {
    const flag = flags[index];
    const value = flags[index + 1];
    if (!allowed.has(flag) || values[flag] !== undefined || !value || value.startsWith("--")) throw new Error(`Invalid or repeated database command option: ${flag}.`);
    values[flag] = value;
  }
  const target = values["--target"];
  if (!["local", "preview", "production"].includes(target)) throw new Error("An explicit --target local, preview, or production is required.");
  if (!values["--expected-host"] || !values["--expected-database"]) throw new Error("Supply --expected-host and --expected-database to identify the intended database.");
  const urlEnv = values["--url-env"] ?? "MIGRATION_DATABASE_URL";
  if (!["MIGRATION_DATABASE_URL", "DATABASE_URL_UNPOOLED"].includes(urlEnv)) throw new Error("--url-env must be MIGRATION_DATABASE_URL or DATABASE_URL_UNPOOLED.");
  return { command, target, expectedHost: values["--expected-host"], expectedDatabase: values["--expected-database"], urlEnv };
}

export function validateDatabaseTarget(options, env) {
  const connectionString = env[options.urlEnv];
  if (!connectionString) throw new Error(`${options.urlEnv} is required; no fallback to the application's database connection is allowed.`);
  let url;
  try { url = new URL(connectionString); } catch { throw new Error(`${options.urlEnv} must contain a PostgreSQL connection URL.`); }
  if (!["postgres:", "postgresql:"].includes(url.protocol) || !url.hostname || !url.username) throw new Error(`${options.urlEnv} must contain a PostgreSQL connection URL with a host and user.`);
  if (url.hostname !== options.expectedHost || decodeURIComponent(url.pathname.slice(1)) !== options.expectedDatabase) throw new Error("The connection URL does not match the expected host and database; refusing to connect.");
  if (url.hostname.includes("-pooler.") || url.searchParams.get("pgbouncer") === "true") throw new Error("Migrations require a direct PostgreSQL connection; pooled connections cannot preserve the migration lock.");
  const local = ["localhost", "127.0.0.1", "[::1]"].includes(url.hostname);
  if ((options.target === "local") !== local) throw new Error("The selected target does not match a local versus remote database connection.");
  if (env.VERCEL_ENV && env.VERCEL_ENV !== "development" && env.VERCEL_ENV !== options.target) throw new Error("The selected target differs from this deployment's VERCEL_ENV.");
  if (!local && !["require", "verify-ca", "verify-full"].includes(url.searchParams.get("sslmode"))) throw new Error("Remote database connections must request TLS with sslmode=require, verify-ca, or verify-full.");
  return { connectionString };
}

export async function runDatabaseCommand(args, env = process.env, log = console.log) {
  const options = parseDatabaseArguments(args);
  if (options.help) { log(help); return 0; }
  const connection = validateDatabaseTarget(options, env);
  const migrations = await loadMigrations();
  const client = new pg.Client({ ...connection, connectionTimeoutMillis: 10_000, query_timeout: 130_000 });
  try {
    await client.connect();
    const identity = await client.query("select current_database() as database");
    if (identity.rows[0]?.database !== options.expectedDatabase) throw new Error("The connected database did not match the expected database name.");
    const result = options.command === "migrate"
      ? await migrateDatabase(client, { migrations })
      : await inspectMigrations(client, { migrations });
    log(JSON.stringify({ target: options.target, ...result }));
    return result.status === "ready" ? 0 : 2;
  } finally {
    await client.end();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.exitCode = await runDatabaseCommand(process.argv.slice(2)); }
  catch (error) {
    // Error diagnostics must not expose connection credentials.
    console.error(String(error.message).replace(/postgres(?:ql)?:\/\/[^\s"']+/giu, "[redacted database URL]"));
    process.exitCode = 1;
  }
}
