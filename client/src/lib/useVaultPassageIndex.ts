import { useCallback, useEffect, useRef, useState } from "react";
import { requestVaultPassageSync, saveVaultPassageSettings, type VaultPassageIndexStatus } from "./api";

/** How often an open workspace picks up saved edits. */
const REFRESH_MS = 5 * 60_000;
/** After a sync uploads changes, wait this long for more before indexing, so a burst of edits makes one run. */
export const AFTER_UPLOAD_MS = 15_000;
/** Edits that keep coming are still indexed this long after the first of them. */
export const AFTER_UPLOAD_MAX_MS = 2 * 60_000;
/** Requests per run; each splits a batch of documents into passages and embeds a batch of passages. */
const MAX_ROUNDS = 60;

export const VAULT_SEARCH_DISCLOSURE = "Sends the text of your saved documents, notes, chats, uploaded files and PDFs to OpenAI to make search embeddings, so Ask AI, Agent mode and search find passages by meaning, not only by exact words. Turning it off deletes the stored embeddings; exact-word search keeps working.";

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

export interface IndexClock {
  now(): number;
  setTimeout(run: () => void, ms: number): unknown;
  clearTimeout(timer: unknown): void;
}

const windowClock: IndexClock = {
  now: () => Date.now(),
  setTimeout: (run, ms) => window.setTimeout(run, ms),
  clearTimeout: (timer) => window.clearTimeout(timer as number),
};

/**
 * Runs `run` now and then every REFRESH_MS. `uploaded()` brings the next run forward to AFTER_UPLOAD_MS from
 * now; each further upload in that wait pushes it back, up to AFTER_UPLOAD_MAX_MS after the first. An upload
 * during a run is indexed the same way once that run ends.
 */
export function scheduleVaultIndexing(run: () => Promise<void>, clock: IndexClock = windowClock) {
  let timer: unknown;
  let running = false;
  let uploadedDuringRun = false;
  let burstStartedAt: number | null = null;
  let stopped = false;
  const at = (ms: number) => {
    clock.clearTimeout(timer);
    timer = clock.setTimeout(() => void start(), ms);
  };
  async function start() {
    if (stopped) return;
    burstStartedAt = null;
    running = true;
    try {
      await run();
    } catch {
      // `run` reports its own failures; the schedule carries on.
    } finally {
      running = false;
      if (!stopped) {
        if (uploadedDuringRun) { uploadedDuringRun = false; uploaded(); }
        else at(REFRESH_MS);
      }
    }
  }
  function uploaded() {
    if (stopped) return;
    if (running) { uploadedDuringRun = true; return; }
    const now = clock.now();
    burstStartedAt ??= now;
    at(Math.max(0, Math.min(AFTER_UPLOAD_MS, burstStartedAt + AFTER_UPLOAD_MAX_MS - now)));
  }
  void start();
  return {
    uploaded,
    stop() { stopped = true; clock.clearTimeout(timer); },
  };
}

/**
 * Keeps the cloud vault's search index current: every saved document, note,
 * chat, uploaded file and PDF is split into passages and, with search by meaning
 * on, embedded. The server does a batch per request and only touches what
 * changed, so a run after a few edits costs a request or two. It runs shortly
 * after a sync uploads changes, such as a file added to the vault folder, and
 * otherwise every few minutes.
 */
export function useVaultPassageIndex({ userId, active, uploads = 0 }: {
  userId: string;
  /** The workspace is stored in the cloud vault and has loaded. */
  active: boolean;
  /** Changes whenever a sync uploads changes. */
  uploads?: number;
}): VaultPassageIndex {
  const [status, setStatus] = useState<VaultPassageIndexStatus | null>(null);
  const [indexing, setIndexing] = useState(false);
  const [warning, setWarning] = useState<string>();
  const [error, setError] = useState<string>();
  const [saving, setSaving] = useState(false);
  const [runKey, setRunKey] = useState(0);
  const schedule = useRef<ReturnType<typeof scheduleVaultIndexing> | null>(null);

  useEffect(() => {
    if (!userId || !active) return;
    const controller = new AbortController();
    async function run() {
      // A hidden tab waits; the next visible check picks up everything since.
      if (document.visibilityState === "hidden") return;
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
        if (!controller.signal.aborted) setIndexing(false);
      }
    }
    const current = scheduleVaultIndexing(run);
    schedule.current = current;
    return () => {
      controller.abort();
      current.stop();
      if (schedule.current === current) schedule.current = null;
      setIndexing(false);
    };
  }, [userId, active, runKey]);

  // New uploads are indexed shortly after the last of a burst, not only at the next regular check.
  useEffect(() => {
    if (uploads) schedule.current?.uploaded();
  }, [uploads]);

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
