import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import pg from "pg";
import {
  createAuthSession,
  createPasswordResetToken,
  createUser,
  deleteAuthSession,
  findUserForLogin,
  getUserByAuthSession,
  resetPasswordWithToken,
  updateUserProfile,
} from "./authRepository.mjs";
import {
  deleteUserApiKey,
  listUserApiKeys,
  upsertUserApiKey,
} from "./apiKeyRepository.mjs";
import {
  chargeHostedRequest,
  creditHostedBalance,
  getUserBillingAccount,
  incrementTrialApiCallsUsed,
  refundHostedRequest,
  syncUserBillingByCustomerId,
  syncUserBillingById,
  updateStripeCustomerId,
} from "./billingRepository.mjs";
import { buildConnectionOptions, getConnectionMetadata } from "./config.mjs";
import {
  completeDocument,
  createDocument,
  deleteDocument,
  failDocument,
  findRelevantDocumentChunks,
} from "./documentRepository.mjs";
import { wrapStorageError } from "./errors.mjs";
import { readState, writeState } from "./repository.mjs";
import { normalizeAppState } from "./validation.mjs";

const { Pool } = pg;

const __dirname = dirname(fileURLToPath(import.meta.url));
const schemaSql = readFileSync(resolve(__dirname, "schema.sql"), "utf8");

export function createAppDatabase(env) {
  const connectionOptions = buildConnectionOptions(env);
  const connectionMetadata = getConnectionMetadata(env);
  const pool = new Pool({
    ...connectionOptions,
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
      console.error("Postgres storage error", error);
      throw wrapStorageError(error);
    }
  }

  async function createAuthSessionRecord(args) {
    return withClient((client) => createAuthSession(client, args));
  }

  async function createUserRecord(args) {
    return withClient((client) => createUser(client, args));
  }

  async function createPasswordResetTokenRecord(args) {
    return withClient((client) => createPasswordResetToken(client, args));
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

  async function deleteUserApiKeyRecord(args) {
    return withClient((client) => deleteUserApiKey(client, args));
  }

  async function listUserApiKeysRecord(userId) {
    return withClient((client) => listUserApiKeys(client, userId));
  }

  async function upsertUserApiKeyRecord(args) {
    return withClient((client) => upsertUserApiKey(client, args));
  }

  async function createDocumentRecord(args) {
    return withClient((client) => createDocument(client, args));
  }

  async function completeDocumentRecord(args) {
    return withClient((client) => completeDocument(client, args));
  }

  async function failDocumentRecord(args) {
    return withClient((client) => failDocument(client, args));
  }

  async function deleteDocumentRecord(args) {
    return withClient((client) => deleteDocument(client, args));
  }

  async function findRelevantDocumentChunksRecord(args) {
    return withClient((client) => findRelevantDocumentChunks(client, args));
  }

  async function loadState(userId) {
    return withClient((client) => readState(client, userId));
  }

  async function resetPasswordWithTokenRecord(args) {
    return withClient((client) => resetPasswordWithToken(client, args));
  }

  async function getUserBillingAccountRecord(userId) {
    return withClient((client) => getUserBillingAccount(client, userId));
  }

  async function chargeHostedRequestRecord(args) {
    return withClient((client) => chargeHostedRequest(client, args));
  }

  async function creditHostedBalanceRecord(args) {
    return withClient((client) => creditHostedBalance(client, args));
  }

  async function refundHostedRequestRecord(args) {
    return withClient((client) => refundHostedRequest(client, args));
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
      configured: connectionMetadata.configured,
      error: initializationError?.message ?? null,
      host: connectionMetadata.host,
      port: connectionMetadata.port,
      ready: initializationState === "ready",
    };
  }

  void ready().catch((error) => {
    console.error("Postgres initialization failed", error);
  });

  return {
    chargeHostedRequest: chargeHostedRequestRecord,
    close,
    createAuthSession: createAuthSessionRecord,
    createPasswordResetToken: createPasswordResetTokenRecord,
    createUser: createUserRecord,
    completeDocument: completeDocumentRecord,
    createDocument: createDocumentRecord,
    creditHostedBalance: creditHostedBalanceRecord,
    deleteAuthSession: deleteAuthSessionRecord,
    deleteUserApiKey: deleteUserApiKeyRecord,
    deleteDocument: deleteDocumentRecord,
    failDocument: failDocumentRecord,
    findUserForLogin: findUserForLoginRecord,
    findRelevantDocumentChunks: findRelevantDocumentChunksRecord,
    getUserBillingAccount: getUserBillingAccountRecord,
    getHealth,
    getUserByAuthSession: getUserByAuthSessionRecord,
    incrementTrialApiCallsUsed: incrementTrialApiCallsUsedRecord,
    listUserApiKeys: listUserApiKeysRecord,
    loadState,
    ready,
    resetPasswordWithToken: resetPasswordWithTokenRecord,
    refundHostedRequest: refundHostedRequestRecord,
    saveState,
    syncUserBillingByCustomerId: syncUserBillingByCustomerIdRecord,
    syncUserBillingById: syncUserBillingByIdRecord,
    updateUserProfile: updateUserProfileRecord,
    updateStripeCustomerId: updateStripeCustomerIdRecord,
    upsertUserApiKey: upsertUserApiKeyRecord,
  };
}
