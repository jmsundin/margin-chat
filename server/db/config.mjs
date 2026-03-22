export function buildConnectionOptions(env) {
  const connectionString = getConnectionString(env);

  if (connectionString) {
    return {
      connectionString,
      ssl: normalizeSsl(env, connectionString),
    };
  }

  return {
    database: env.PGDATABASE ?? env.POSTGRES_DATABASE ?? "margin_chat",
    host: env.PGHOST ?? env.POSTGRES_HOST ?? "127.0.0.1",
    password: env.PGPASSWORD ?? env.POSTGRES_PASSWORD ?? "margin_chat",
    port: Number(env.PGPORT ?? env.POSTGRES_PORT ?? 5432),
    ssl: normalizeSsl(env, null),
    user: env.PGUSER ?? env.POSTGRES_USER ?? "margin_chat",
  };
}

export function getConnectionMetadata(env) {
  const connectionString = getConnectionString(env);

  if (connectionString) {
    try {
      const url = new URL(connectionString);

      return {
        configured: true,
        host: url.hostname || null,
        port: Number(url.port || 5432),
      };
    } catch {
      return {
        configured: true,
        host: null,
        port: null,
      };
    }
  }

  const host = env.PGHOST ?? env.POSTGRES_HOST ?? null;
  const portValue = env.PGPORT ?? env.POSTGRES_PORT ?? null;
  const configured = Boolean(
    host ||
      env.PGDATABASE ||
      env.POSTGRES_DATABASE ||
      env.PGUSER ||
      env.POSTGRES_USER,
  );

  return {
    configured,
    host,
    port: portValue ? Number(portValue) : null,
  };
}

function getConnectionString(env) {
  return (
    env.DATABASE_URL ??
    env.POSTGRES_URL ??
    env.POSTGRES_PRISMA_URL ??
    null
  );
}

function normalizeSsl(env, connectionString) {
  const value = String(env.PGSSL ?? env.POSTGRES_SSL ?? "").toLowerCase();

  if (!value || value === "false" || value === "0") {
    if (!connectionString) {
      return undefined;
    }

    try {
      const url = new URL(connectionString);
      const sslMode = String(url.searchParams.get("sslmode") ?? "").toLowerCase();
      const sslValue = String(url.searchParams.get("ssl") ?? "").toLowerCase();

      if (
        sslValue === "true" ||
        sslValue === "1" ||
        ["require", "verify-ca", "verify-full"].includes(sslMode)
      ) {
        return {
          rejectUnauthorized: false,
        };
      }
    } catch {
      return undefined;
    }

    return undefined;
  }

  return {
    rejectUnauthorized: false,
  };
}
