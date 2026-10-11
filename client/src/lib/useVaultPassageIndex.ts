import { useCallback, useEffect, useState } from "react";
import { requestVaultPassageSync, saveVaultPassageSettings, type VaultPassageIndexStatus } from "./api";

/** How often an open workspace picks up saved edits. */
const REFRESH_MS = 5 * 60_000;
/** Requests per run; each splits a batch of documents into passages and embeds a batch of passages. */
const MAX_ROUNDS = 60;

export const VAULT_SEARCH_DISCLOSURE = "Sends the text of your saved documents, notes, chats and uploaded files to OpenAI to make search embeddings, so Ask AI, Agent mode and search find passages by meaning, not only by exact words. Turning it off deletes the stored embeddings; exact-word search keeps working.";

export interface VaultPassageIndex {
  status: VaultPassageIndexStatus | null;
  /** Indexing requests are running. */
  indexing: boolean;
  /** Why new passages can't be embedded, such as a missing OpenAI key. */
  warning?: string;
  /** The last request failed; search by exact words still works. */
  error?: string;
  saving: boolean;
  setCloudEmbeddings: (enabled: boolean) => Promise<void>;
}

/**
 * Keeps the cloud vault's search index current: every saved document, note,
 * chat and uploaded file is split into passages and, with search by meaning
 * on, embedded. The server does a batch per request and only touches what
 * changed, so a run after a few edits costs a request or two.
 */
export function useVaultPassageIndex({ userId, active }: {
  userId: string;
  /** The workspace is stored in the cloud vault and has loaded. */
  active: boolean;
}): VaultPassageIndex {
  const [status, setStatus] = useState<VaultPassageIndexStatus | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [warning, setWarning] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [runKey, setRunKey] = useState(0);

  useEffect(() => {
    if (!userId || !active) return;
    const controller = new AbortController();
    let timer: number | undefined;
    const schedule = () => { timer = window.setTimeout(run, REFRESH_MS); };
    async function run() {
      // A hidden tab waits; the next visible check picks up everything since.
      if (document.visibilityState === "hidden") { schedule(); return; }
      setIndexing(true);
      try {
        for (let round = 0; round < MAX_ROUNDS && !controller.signal.aborted; round++) {
          const result = await requestVaultPassageSync({ expectedUserId: userId, signal: controller.signal });
          setStatus({ available: result.available, cloudEmbeddings: result.cloudEmbeddings, passages: result.passages, embedded: result.embedded });
          setWarning(result.unavailable);
          if (!result.more) break;
        }
        setError(undefined);
      } catch (cause) {
        if (controller.signal.aborted) return;
        console.warn("Vault indexing is unavailable", cause);
        setError(cause instanceof Error ? cause.message : "Indexing your vault failed.");
      } finally {
        if (!controller.signal.aborted) {
          setIndexing(false);
          schedule();
        }
      }
    }
    void run();
    return () => {
      controller.abort();
      window.clearTimeout(timer);
      setIndexing(false);
    };
  }, [userId, active, runKey]);

  const setCloudEmbeddings = useCallback(async (enabled: boolean) => {
    setSaving(true);
    try {
      setStatus(await saveVaultPassageSettings({ cloudEmbeddings: enabled, expectedUserId: userId }));
      setError(undefined);
      if (!enabled) setWarning(undefined);
      // Turning it on embeds the vault now rather than at the next check.
      else setRunKey((value) => value + 1);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Saving the search setting failed.");
    } finally {
      setSaving(false);
    }
  }, [userId]);

  return { status, indexing, warning, error, saving, setCloudEmbeddings };
}
