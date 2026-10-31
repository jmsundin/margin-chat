import { useEffect, useState } from "react";
import { requestLandscape, type LandscapeResponse } from "./api";

export type LandscapePosition = LandscapeResponse["positions"][number];

interface LandscapeState {
  positions: LandscapePosition[];
  regions: number;
  status: "idle" | "loading" | "laying-out" | "ready" | "error";
  error?: string;
  tooLarge?: boolean;
}

const EMPTY: LandscapeState = { positions: [], regions: 0, status: "idle" };
/** A fresh layout is asked for at most once per vault per page load; the server also limits it. */
const askedForLayout = new Set<string>();

/**
 * The server's landscape of the vault (server/documents/landscape.mjs).
 * Fetched when the Landscape view opens and again when `revision` changes
 * (new neighbours arrived). When the server says the layout is stale, asks
 * for a fresh one once and shows the old one meanwhile.
 */
export function useLandscape({ userId, enabled, active, revision }: {
  userId: string;
  /** The user allows AI assistance; positions come from embeddings. */
  enabled: boolean;
  active: boolean;
  revision: number;
}) {
  const [state, setState] = useState<LandscapeState>(EMPTY);
  useEffect(() => {
    if (!userId || !enabled || !active) return;
    const controller = new AbortController();
    void (async () => {
      setState((current) => ({ ...current, status: current.positions.length ? current.status : "loading" }));
      try {
        let result = await requestLandscape({ expectedUserId: userId, signal: controller.signal });
        if (controller.signal.aborted) return;
        setState({ positions: result.positions, regions: result.regions, status: result.stale && !askedForLayout.has(userId) ? "laying-out" : "ready", tooLarge: result.tooLarge });
        if (result.stale && !askedForLayout.has(userId)) {
          askedForLayout.add(userId);
          result = await requestLandscape({ relayout: true, expectedUserId: userId, signal: controller.signal });
          if (controller.signal.aborted) return;
          setState({ positions: result.positions, regions: result.regions, status: "ready", tooLarge: result.tooLarge });
        }
      } catch (error) {
        if (controller.signal.aborted) return;
        setState((current) => ({ ...current, status: "error", error: error instanceof Error ? error.message : "Loading the landscape failed." }));
      }
    })();
    return () => controller.abort();
  }, [userId, enabled, active, revision]);
  return state;
}
