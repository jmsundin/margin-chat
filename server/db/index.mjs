import pg from "pg";
import { assertMigrationsReady, loadMigrations, migrateDatabase } from "./migrations.mjs";
import {
  changeUserPassword,
  createAuthSession,
  createPasswordResetToken,
  createUser,
  deleteAuthSession,
  findUserForLogin,
  getUserByAuthSession,
  getUserPasswordHash,
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
  settleHostedRequest,
  getBillingDashboard,
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
  getVaultAttachment,
  listVaultAttachments,
  restoreVaultAttachment,
} from "./documentRepository.mjs";
import { wrapStorageError } from "./errors.mjs";
import { hasStatusCode } from "../lib/errors.mjs";
import { readState, readVaultProjectionCheckpoint, readWorkspace, writeState } from "./repository.mjs";
import { normalizeAppState } from "./validation.mjs";
import * as captures from "./captureRepository.mjs";

const { Pool } = pg;

export function resolveSchemaMode(env, requestedMode) {
  const production = env.NODE_ENV === "production" || Boolean(env.VERCEL);
  const schemaMode = requestedMode ?? env.DB_SCHEMA_MODE ?? (production ? "verify" : "migrate");
  if (!["verify", "migrate"].includes(schemaMode)) throw new Error("DB_SCHEMA_MODE must be verify or migrate.");
  if (production && schemaMode !== "verify") throw new Error("Production applications must use DB_SCHEMA_MODE=verify; run migrations separately before deploying.");
  return schemaMode;
}

export function createAppDatabase(env, { schemaMode: requestedMode } = {}) {
  const schemaMode = resolveSchemaMode(env, requestedMode);
  const connectionOptions = buildConnectionOptions(env);
  const connectionMetadata = getConnectionMetadata(env);
  const pool = new Pool({
    ...connectionOptions,
    connectionTimeoutMillis: 10_000,
    max: 10,
  });

  let initializationError = null;
  let initializationState = "pending";
  let initializationPromise = null;
  let migrations = null;

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
      migrations ??= await loadMigrations();
      const client = await pool.connect();
      let clientError;
      try {
        if (schemaMode === "migrate") await migrateDatabase(client, { migrations });
        else await assertMigrationsReady(client, { migrations });
      } catch (error) {
        clientError = error;
        throw error;
      } finally {
        // Discard failed migration sessions so a failed unlock or lost COMMIT
        // cannot return a connection with uncertain state to the application.
        client.release(clientError);
      }
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
      if (!hasStatusCode(error)) {
        console.error("Postgres storage error", error);
      }
      throw wrapStorageError(error);
    }
  }

  async function createAuthSessionRecord(args) {
    return withClient((client) => createAuthSession(client, args));
  }

  async function changeUserPasswordRecord(args) {
    return withClient((client) => changeUserPassword(client, args));
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

  async function getUserPasswordHashRecord(userId) {
    return withClient((client) => getUserPasswordHash(client, userId));
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

  async function listVaultAttachmentsRecord(userId) {
    return withClient((client) => listVaultAttachments(client, userId));
  }

  async function getVaultAttachmentRecord(args) {
    return withClient((client) => getVaultAttachment(client, args));
  }

  async function restoreVaultAttachmentRecord(args) {
    return withClient((client) => restoreVaultAttachment(client, args));
  }

  async function projectVaultState(
    userId,
    payload,
    vaultRevision,
    { force = false, attachments = [], deletedAttachmentIds = [], attachmentRevisions = {}, expectedProjectionRevision } = {},
  ) {
    const normalizedState = payload === null ? null : normalizeAppState(payload);
    return withClient((client) =>
      writeState(client, userId, normalizedState, {
        vaultRevision,
        forceVaultProjection: force,
        vaultAttachments: attachments,
        deletedVaultAttachmentIds: deletedAttachmentIds,
        attachmentRevisions,
        expectedVaultProjectionRevision: expectedProjectionRevision,
      }),
    );
  }

  async function getVaultProjectionRevision(userId) {
    return withClient(async (client) => {
      const result = await client.query(
        "select vault_revision from marginchat_vault_projections where user_id = $1",
        [userId],
      );
      return result.rowCount ? Number(result.rows[0].vault_revision) : null;
    });
  }

  async function getVaultProjectionCheckpoint(userId) {
    return withClient((client) => readVaultProjectionCheckpoint(client, userId));
  }

  async function loadState(userId) {
    return withClient((client) => readState(client, userId));
  }

  async function loadWorkspace(userId) {
    return withClient((client) => readWorkspace(client, userId));
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

  async function saveState(userId, payload, options) {
    const normalizedState = normalizeAppState(payload);

    return withClient(async (client) => {
      await writeState(
        client,
        userId,
        normalizedState,
        options,
      );
      return readWorkspace(client, userId);
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
      schemaMode,
      migration: migrations?.at(-1)?.id ?? null,
    };
  }

  async function checkHealth() {
    try {
      await ready();
      const client = await pool.connect();
      try {
        await client.query("select 1");
        await assertMigrationsReady(client, { migrations });
      } finally {
        client.release();
      }
      return { ...getHealth(), ready: true, error: null };
    } catch (error) {
      return { ...getHealth(), ready: false, error: error.message };
    }
  }

  void ready().catch((error) => {
    console.error("Postgres initialization failed", error);
  });

  return {
    checkHealth,
    ...Object.fromEntries(Object.entries(captures).map(([name, operation]) => [
      name, (args) => withClient((client) => operation(client, args)),
    ])),
    chargeHostedRequest: chargeHostedRequestRecord,
    changeUserPassword: changeUserPasswordRecord,
    settleHostedRequest: (args) => withClient((client) => settleHostedRequest(client, args)),
    getBillingDashboard: (userId) => withClient((client) => getBillingDashboard(client, userId)),
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
    getVaultAttachment: getVaultAttachmentRecord,
    getVaultProjectionRevision,
    getVaultProjectionCheckpoint,
    getHealth,
    getUserByAuthSession: getUserByAuthSessionRecord,
    getUserPasswordHash: getUserPasswordHashRecord,
    incrementTrialApiCallsUsed: incrementTrialApiCallsUsedRecord,
    listUserApiKeys: listUserApiKeysRecord,
    listVaultAttachments: listVaultAttachmentsRecord,
    loadState,
    loadWorkspace,
    ready,
    projectVaultState,
    restoreVaultAttachment: restoreVaultAttachmentRecord,
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
