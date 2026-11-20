import { HttpError } from "../lib/errors.mjs";
import { decryptSecret, encryptSecret } from "./crypto.mjs";

/** Keys for AI models. */
export const AI_KEY_PROVIDERS = ["openai", "anthropic", "gemini", "huggingface", "xai", "meta"];
/** Keys for the other services some features use: web search, translation and read-aloud voices. */
export const SERVICE_KEY_PROVIDERS = ["tavily", "deepl", "google_translate", "azure_speech"];
export const API_KEY_PROVIDERS = [...AI_KEY_PROVIDERS, ...SERVICE_KEY_PROVIDERS];
const AI_KEY_PROVIDER_SET = new Set(AI_KEY_PROVIDERS);
/** Azure's voices need the key's region too: "region:key", such as "eastus:0123…". */
const AZURE_SPEECH_VALUE = /^[a-z0-9]{2,40}:[A-Za-z0-9]{16,200}$/u;

/** The Azure region and key saved together as one value, or null. */
export function parseAzureSpeechKey(value) {
  if (typeof value !== "string" || !AZURE_SPEECH_VALUE.test(value.trim())) return null;
  const [region, key] = value.trim().split(":");
  return { region, key };
}
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

    if (provider === "azure_speech" && !parseAzureSpeechKey(apiKey)) {
      throw new HttpError(400, "Enter the Azure Speech region and key as region:key, such as eastus:0123abcd….");
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
    // "Any" means AI: a web search or voice key alone doesn't let anyone ask a model.
    hasAny: Object.entries(byProvider).some(([provider, { configured }]) => configured && AI_KEY_PROVIDER_SET.has(provider)),
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
