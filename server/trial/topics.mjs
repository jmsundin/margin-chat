import { createBlobVaultStorage } from "../vault/storage.mjs";

/**
 * The news topics the free trial at /try opens with. A daily job
 * (scripts/trial-topics.mjs) writes them to the Blob store; this serves the
 * latest copy to visitors, who have no account and can't read the store.
 */
export const TRIAL_TOPICS_KEY = "trial/topics.json";
const MAX_BYTES = 512 * 1024;
const CACHE_MS = 10 * 60 * 1000;

export function createTrialTopicsService({ env = process.env, storage, now = () => Date.now() } = {}) {
  const store = storage ?? (env.BLOB_READ_WRITE_TOKEN || env.BLOB_STORE_ID ? createBlobVaultStorage(env) : null);
  let cached = null;
  return {
    /** The latest topics as parsed JSON, or null when none were published yet. */
    async read() {
      if (!store) return null;
      if (cached && now() - cached.at < CACHE_MS) return cached.value;
      const result = await store.read(TRIAL_TOPICS_KEY);
      let value = null;
      if (result && result.bytes.length <= MAX_BYTES) {
        try { value = JSON.parse(result.bytes.toString("utf8")); } catch { value = null; }
      }
      cached = { at: now(), value };
      return value;
    },
  };
}
