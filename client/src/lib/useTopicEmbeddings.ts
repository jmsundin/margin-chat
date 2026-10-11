import { useEffect, useState } from "react";
import { requestTopicEmbeddings } from "./api";
import { decodeTopicEmbedding } from "./topicEmbeddings";

/** Opening Clusters again within this long reuses what was fetched. */
const REFRESH_MS = 2 * 60_000;
/** Requests per sync; each embeds a batch of new or changed documents. */
const MAX_ROUNDS = 40;

interface TopicCache {
  vectors: Map<string, Float32Array>;
  cursor: string | null;
  syncedAt: number;
  warning?: string;
}

const caches = new Map<string, TopicCache>();

function cacheFor(userId: string) {
  let cache = caches.get(userId);
  if (!cache) caches.set(userId, cache = { vectors: new Map(), cursor: null, syncedAt: 0 });
  return cache;
}

const EMPTY = new Map<string, Float32Array>();

/**
 * Each document's embedding, for grouping Clusters by subject. The server
 * embeds new or changed documents as they are asked for, so only documents
 * edited since the last visit cost anything. Respects the Jev preference:
 * with AI assistance off, nothing is sent and nothing is grouped by subject.
 */
export function useTopicEmbeddings({ userId, enabled, active }: {
  userId: string;
  /** The user allows AI assistance (Jev). */
  enabled: boolean;
  /** The Clusters view is on screen. */
  active: boolean;
}) {
  const [revision, setRevision] = useState(0);
  const [loading, setLoading] = useState(false);

  useEffect(() => {
    if (!userId || !enabled || !active) return;
    const cache = cacheFor(userId);
    if (Date.now() - cache.syncedAt < REFRESH_MS) return;
    const controller = new AbortController();
    void (async () => {
      setLoading(true);
      try {
        for (let round = 0; round < MAX_ROUNDS && !controller.signal.aborted; round++) {
          const result = await requestTopicEmbeddings({ since: cache.cursor, expectedUserId: userId, signal: controller.signal });
          for (const entry of result.embeddings) {
            const vector = decodeTopicEmbedding(entry.embedding);
            if (vector) cache.vectors.set(entry.id, vector);
          }
          cache.cursor = result.cursor;
          cache.warning = result.unavailable;
          if (result.embeddings.length) setRevision((value) => value + 1);
          if (!result.pending || result.unavailable) break;
        }
        if (!controller.signal.aborted) cache.syncedAt = Date.now();
      } catch (error) {
        // Without a cloud vault or a reachable server, Clusters keeps grouping by links alone.
        if (!controller.signal.aborted) {
          cache.syncedAt = Date.now();
          console.warn("Grouping by subject is unavailable", error);
        }
      } finally {
        if (!controller.signal.aborted) setLoading(false);
      }
    })();
    return () => { controller.abort(); setLoading(false); };
  }, [userId, enabled, active]);

  const cache = userId && enabled ? caches.get(userId) : undefined;
  return { vectors: cache?.vectors ?? EMPTY, revision, loading, warning: cache?.warning };
}
