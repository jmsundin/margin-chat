import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  createAuthSession,
  createUser,
  deleteAuthSession,
  findUserForLogin,
  getUserByAuthSession,
  updateUserProfile,
} from "./authRepository.mjs";
import {
  getUserBillingAccount,
  incrementTrialApiCallsUsed,
  syncUserBillingByCustomerId,
  syncUserBillingById,
  updateStripeCustomerId,
} from "./billingRepository.mjs";
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

  async function createAuthSessionRecord(args) {
    return withClient((client) => createAuthSession(client, args));
  }

  async function createUserRecord(args) {
    return withClient((client) => createUser(client, args));
  }

  async function deleteAuthSessionRecord(sessionId) {
    return withClient((client) => deleteAuthSession(client, sessionId));
  }

  async function findUserForLoginRecord(email) {
    return withClient((client) => findUserForLogin(client, email));
  }

  async function getUserByAuthSessionRecord(sessionId) {
    return withClient((client) => getUserByAuthSession(client, sessionId));
  }

  async function updateUserProfileRecord(args) {
    return withClient((client) => updateUserProfile(client, args));
  }

  async function loadState(userId) {
    return withClient((client) => readState(client, userId));
  }

  async function getUserBillingAccountRecord(userId) {
    return withClient((client) => getUserBillingAccount(client, userId));
  }

  async function updateStripeCustomerIdRecord(args) {
    return withClient((client) => updateStripeCustomerId(client, args));
  }

  async function incrementTrialApiCallsUsedRecord(userId) {
    return withClient((client) => incrementTrialApiCallsUsed(client, userId));
  }

  async function syncUserBillingByCustomerIdRecord(args) {
    return withClient((client) => syncUserBillingByCustomerId(client, args));
  }

  async function syncUserBillingByIdRecord(args) {
    return withClient((client) => syncUserBillingById(client, args));
  }

  async function saveState(userId, payload) {
    const normalizedState = normalizeAppState(payload);

    return withClient(async (client) => {
      await writeState(client, userId, normalizedState);
      return readState(client, userId);
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
    createAuthSession: createAuthSessionRecord,
    createUser: createUserRecord,
    deleteAuthSession: deleteAuthSessionRecord,
    findUserForLogin: findUserForLoginRecord,
    getUserBillingAccount: getUserBillingAccountRecord,
    getHealth,
    getUserByAuthSession: getUserByAuthSessionRecord,
    incrementTrialApiCallsUsed: incrementTrialApiCallsUsedRecord,
    loadState,
    ready,
    saveState,
    syncUserBillingByCustomerId: syncUserBillingByCustomerIdRecord,
    syncUserBillingById: syncUserBillingByIdRecord,
    updateUserProfile: updateUserProfileRecord,
    updateStripeCustomerId: updateStripeCustomerIdRecord,
  };
}
