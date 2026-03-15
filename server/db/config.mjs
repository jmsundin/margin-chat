export function buildConnectionOptions(env) {
  if (env.DATABASE_URL) {
    return {
      connectionString: env.DATABASE_URL,
      ssl: normalizeSsl(env),
    };
  }

  return {
    database: env.PGDATABASE ?? "margin_chat",
    host: env.PGHOST ?? "127.0.0.1",
    password: env.PGPASSWORD ?? "margin_chat",
    port: Number(env.PGPORT ?? 5432),
    ssl: normalizeSsl(env),
    user: env.PGUSER ?? "margin_chat",
  };
}

function normalizeSsl(env) {
  const value = String(env.PGSSL ?? env.POSTGRES_SSL ?? "").toLowerCase();

  if (!value || value === "false" || value === "0") {
    return undefined;
  }

  return {
    rejectUnauthorized: false,
  };
}
