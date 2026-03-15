import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import { buildConnectionOptions } from "./config.mjs";
import { wrapStorageError } from "./errors.mjs";
import { readState, writeState } from "./repository.mjs";
import { normalizeAppState } from "./validation.mjs";

const { Pool } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(resolve(__dirname, "schema.sql"), "utf8");

export function createAppDatabase(env) {
  const pool = new Pool({
    ...buildConnectionOptions(env),
    max: 10,
  });

  let initializationError = null;
  let initializationState = "pending";
  let initializationPromise = null;

  async function ready() {
    if (!initializationPromise) {
      initializationPromise = initialize().catch((error) => {
        initializationPromise = null;
        throw error;
      });
    }

    return initializationPromise;
  }

  async function initialize() {
    try {
      await pool.query(schemaSql);
      initializationError = null;
      initializationState = "ready";
    } catch (error) {
      initializationError = error;
      initializationState = "error";
      throw error;
    }
  }

  async function withClient(callback) {
    try {
      await ready();

      const client = await pool.connect();

      try {
        return await callback(client);
      } finally {
        client.release();
      }
    } catch (error) {
      throw wrapStorageError(error);
    }
  }

  async function loadState() {
    return withClient((client) => readState(client));
  }

  async function saveState(payload) {
    const normalizedState = normalizeAppState(payload);

    return withClient(async (client) => {
      await writeState(client, normalizedState);
      return readState(client);
    });
  }

  async function close() {
    await pool.end();
  }

  function getHealth() {
    return {
      configured: true,
      error: initializationError?.message ?? null,
      host: env.PGHOST ?? "127.0.0.1",
      port: Number(env.PGPORT ?? 5432),
      ready: initializationState === "ready",
    };
  }

  return {
    close,
    getHealth,
    loadState,
    ready,
    saveState,
  };
}
