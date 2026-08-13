import { HttpError } from "../lib/errors.mjs";
import { decryptSecret, encryptSecret } from "./crypto.mjs";

export const API_KEY_PROVIDERS = ["openai", "gemini", "huggingface", "xai"];
const API_KEY_PROVIDER_SET = new Set(API_KEY_PROVIDERS);

function normalizeMutations(payload) {
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) {
    throw new HttpError(400, "API key settings must be an object.");
  }

  const keys = payload.keys;

  if (!keys || typeof keys !== "object" || Array.isArray(keys)) {
    throw new HttpError(400, "API key settings must include a keys object.");
  }

  const mutations = [];

  for (const [provider, rawValue] of Object.entries(keys)) {
    if (!API_KEY_PROVIDER_SET.has(provider)) {
      throw new HttpError(400, `Unsupported API key provider: ${provider}.`);
    }

    if (rawValue === null) {
      mutations.push({ apiKey: null, provider });
      continue;
    }

    if (typeof rawValue !== "string") {
      throw new HttpError(400, `The ${provider} API key must be a string or null.`);
    }

    const apiKey = rawValue.trim();

    if (apiKey.length < 8 || apiKey.length > 4096) {
      throw new HttpError(
        400,
        `The ${provider} API key must be between 8 and 4096 characters.`,
      );
    }

    mutations.push({ apiKey, provider });
  }

  if (!mutations.length) {
    throw new HttpError(400, "No API key changes were provided.");
  }

  return mutations;
}

function serializeSummaries(rows) {
  const byProvider = Object.fromEntries(
    API_KEY_PROVIDERS.map((provider) => [
      provider,
      { configured: false, hint: null },
    ]),
  );

  for (const row of rows) {
    if (API_KEY_PROVIDER_SET.has(row.provider)) {
      byProvider[row.provider] = {
        configured: true,
        hint: row.keyHint,
      };
    }
  }

  return {
    byProvider,
    hasAny: Object.values(byProvider).some(({ configured }) => configured),
  };
}

export function createApiKeyService({ database, env }) {
  async function getSummaries(userId) {
    return serializeSummaries(await database.listUserApiKeys(userId));
  }

  async function updateKeys(userId, payload) {
    const mutations = normalizeMutations(payload);

    for (const { apiKey, provider } of mutations) {
      if (apiKey === null) {
        await database.deleteUserApiKey({ provider, userId });
      } else {
        await database.upsertUserApiKey({
          encryptedApiKey: encryptSecret(apiKey, env),
          keyHint: apiKey.slice(-4),
          provider,
          userId,
        });
      }
    }

    return getSummaries(userId);
  }

  async function getDecryptedKeys(userId) {
    const rows = await database.listUserApiKeys(userId);

    return Object.fromEntries(
      rows.map((row) => [row.provider, decryptSecret(row.encryptedApiKey, env)]),
    );
  }

  async function decorateUser(user) {
    if (!user) {
      return user;
    }

    return {
      ...user,
      apiKeys: await getSummaries(user.id),
    };
  }

  return {
    decorateUser,
    getDecryptedKeys,
    getSummaries,
    updateKeys,
  };
}
