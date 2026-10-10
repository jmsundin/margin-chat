import { describe, expect, test } from "bun:test";
import { wrapStorageError } from "../server/db/errors.mjs";

describe("Postgres storage errors", () => {
  test("a development API says which connection failed and how to start the local database", () => {
    const error = wrapStorageError(new Error("connect ECONNREFUSED 127.0.0.1:5432"), { NODE_ENV: "development" }) as Error & { statusCode: number };
    expect(error.statusCode).toBe(503);
    expect(error.message).toContain("connect ECONNREFUSED 127.0.0.1:5432");
    expect(error.message).toContain("bun run db:start");
  });

  test("production keeps connection details out of the response", () => {
    const error = wrapStorageError(new Error("password authentication failed for user secret"), { NODE_ENV: "production" }) as Error;
    expect(error.message).not.toContain("secret");
    expect(error.message).toContain("production database connection settings");
  });
});
