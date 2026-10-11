import { useCallback, useEffect, useState } from "react";
import { requestTopicEmbeddings, saveTopicPlacement } from "./api";
import { decodeTopicEmbedding } from "./topicEmbeddings";

/** Opening Clusters again within this long reuses what was fetched. */
const REFRESH_MS = 2 * 60_000;
/** Requests per sync; each embeds a batch of new or changed documents. */
const MAX_ROUNDS = 40;

interface TopicCache {
  vectors: Map<string, Float32Array>;
  /** Documents moved by hand, each to the cluster of its anchor document. */
  placements: Map<string, string>;
  cursor: string | null;
  syncedAt: number;
  warning?: string;
}

const caches = new Map<string, TopicCache>();

function cacheFor(userId: string) {
  let cache = caches.get(userId);
  if (!cache) caches.set(userId, cache = { vectors: new Map(), placements: new Map(), cursor: null, syncedAt: 0 });
  return cache;
}

const EMPTY_VECTORS = new Map<string, Float32Array>();
const EMPTY_PLACEMENTS = new Map<string, string>();

/**
 * Each document's embedding, for grouping Clusters by subject, and the
 * documents the user moved to another cluster. The server embeds new or
 * changed documents as they are asked for, so only documents edited since the
 * last visit cost anything. Respects the Jev preference: with AI assistance
 * off, nothing is sent and nothing is grouped by subject.
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
          const placements = new Map((result.placements ?? []).map((entry) => [entry.id, entry.anchorId] as const));
          const placementsChanged = placements.size !== cache.placements.size
            || [...placements].some(([id, anchorId]) => cache.placements.get(id) !== anchorId);
          cache.placements = placements;
          cache.cursor = result.cursor;
          cache.warning = result.unavailable;
          if (result.embeddings.length || placementsChanged) setRevision((value) => value + 1);
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

  /** Moves a document to the cluster of `anchorId`, or back to automatic placement with null. Shown at once, saved in the background. */
  const moveDocument = useCallback(async (id: string, anchorId: string | null) => {
    if (!userId) return;
    const cache = cacheFor(userId);
    const previous = cache.placements.get(id);
    const placements = new Map(cache.placements);
    if (anchorId === null) placements.delete(id); else placements.set(id, anchorId);
    cache.placements = placements;
    setRevision((value) => value + 1);
    try {
      await saveTopicPlacement({ id, anchorId, expectedUserId: userId });
    } catch (error) {
      const restored = new Map(cache.placements);
      if (previous === undefined) restored.delete(id); else restored.set(id, previous);
      cache.placements = restored;
      setRevision((value) => value + 1);
      throw error;
    }
  }, [userId]);

  const cache = userId && enabled ? caches.get(userId) : undefined;
  return { vectors: cache?.vectors ?? EMPTY_VECTORS, placements: cache?.placements ?? EMPTY_PLACEMENTS,
    revision, loading, warning: cache?.warning, moveDocument };
}
