import { createStatusError, hasStatusCode } from "../lib/errors.mjs";

export function createStateError(message) {
  return createStatusError(400, message);
}

export function wrapStorageError(error, env = process.env) {
  if (hasStatusCode(error)) {
    return error;
  }

  if (env.NODE_ENV !== "production" && !env.VERCEL) {
    // A development API is the developer's own; say which connection failed and why.
    const reason = error instanceof Error && error.message ? ` (${error.message})` : "";
    return createStatusError(
      503,
      `This API server cannot reach its Postgres database${reason}. Start the local database with "bun run db:start", check DATABASE_URL in .env, then restart the API server.`,
    );
  }

  return createStatusError(
    503,
    "Postgres storage is unavailable. Check your production database connection settings and SSL configuration, then redeploy.",
  );
}
