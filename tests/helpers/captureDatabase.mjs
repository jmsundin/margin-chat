import { readFile } from "node:fs/promises";
import { PGlite } from "@electric-sql/pglite";
import { vector } from "@electric-sql/pglite-pgvector";
import * as captures from "../../server/db/captureRepository.mjs";
import * as auth from "../../server/db/authRepository.mjs";
import { readWorkspace, writeState } from "../../server/db/repository.mjs";
import { normalizeAppState } from "../../server/db/validation.mjs";

// Runs the real schema and repository queries in isolated Postgres, without .env or a cloud account.
export async function createCaptureTestDatabase() {
  const pg = new PGlite({ extensions: { vector } });
  const schema = await readFile(
    new URL("../../server/db/schema.sql", import.meta.url),
    "utf8",
  );
  await pg.exec(schema);
  const client = {
    async query(sql, params) {
      const result = await pg.query(sql, params);
      return {
        ...result,
        rowCount: result.rows.length || result.affectedRows || 0,
      };
    },
  };
  const database = {
    ...Object.fromEntries(
      Object.entries({ ...captures, ...auth }).map(([name, operation]) => [
        name,
        (args) => operation(client, args),
      ]),
    ),
    loadWorkspace: (userId) => readWorkspace(client, userId),
    async saveState(userId, state, options) {
      const revision = await writeState(
        client,
        userId,
        normalizeAppState(state),
        options,
      );
      return { ...(await readWorkspace(client, userId)), revision };
    },
    ready: async () => undefined,
    getHealth: () => ({ configured: true, ready: true }),
  };
  return { pg, client, database, schema };
}
