import { createStatusError, hasStatusCode } from "../lib/errors.mjs";

export function createStateError(message) {
  return createStatusError(400, message);
}

export function wrapStorageError(error) {
  if (hasStatusCode(error)) {
    return error;
  }

  return createStatusError(
    503,
    "Postgres storage is unavailable. Check your production database connection settings and SSL configuration, then redeploy.",
  );
}
