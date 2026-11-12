import { useCallback, useEffect, useRef, useState } from "react";
import type { Conversation } from "../types";
import {
  claimOffsets, locateClaim, resolveEvidence, runClaimCheck,
  type AnchorState, type EvidenceState, type RatchetAsk, type RatchetClaim, type RatchetProgress, type RatchetRun,
} from "./ratchet";
import { createRatchetCorpus, ratchetSource, readRatchetCheck, readableByRatchet, saveRatchetCheck } from "./ratchetVault";
import type { VaultCloudSearch } from "./vaultSearch";

/** One document's checked claims, as they stand against the vault now. */
export interface RatchetDocumentState {
  status: "loading" | "ready" | "checking" | "error";
  claims: RatchetClaim[];
  run: RatchetRun | null;
  /** Where each claim's lines are now, by claim id. */
  anchors: Record<string, AnchorState>;
  /** Whether each citation still resolves, by claim id then evidence index. */
  evidence: Record<string, EvidenceState[]>;
  progress?: RatchetProgress;
  error?: string;
  /** Saved on this device only, because saving to the account failed. */
  unsaved?: boolean;
}

/** A claim's passage in its block, for the editor's highlight. */
export interface RatchetHighlight { claimId: string; verdict: RatchetClaim["verdict"]; from: number; to: number }

const EMPTY: Record<string, RatchetHighlight[]> = {};

/**
 * Ratchet in the app: loads a document's saved claims when asked, re-reads them
 * against the document and vault as they change, and runs a new check.
 */
export function useRatchet({ userId, conversations, searchCloud, ask }: {
  userId: string;
  conversations: Record<string, Conversation>;
  searchCloud?: VaultCloudSearch;
  ask: (conversationId: string) => RatchetAsk;
}) {
  const [documents, setDocuments] = useState<Record<string, RatchetDocumentState>>({});
  const conversationsRef = useRef(conversations);
  conversationsRef.current = conversations;
  const running = useRef(new Map<string, AbortController>());
  const requested = useRef(new Set<string>());

  const update = useCallback((id: string, change: (current: RatchetDocumentState) => RatchetDocumentState) => {
    setDocuments((current) => ({ ...current, [id]: change(current[id] ?? { status: "loading", claims: [], run: null, anchors: {}, evidence: {} }) }));
  }, []);

  /** Load a document's saved claims once per session. */
  const load = useCallback((id: string) => {
    if (requested.current.has(id) || !readableByRatchet(conversationsRef.current[id])) return;
    requested.current.add(id);
    update(id, (current) => ({ ...current, status: "loading" }));
    readRatchetCheck(userId, id).then(
      (saved) => update(id, (current) => current.status === "checking" ? current : { ...current, status: "ready", claims: saved.claims, run: saved.run, error: undefined }),
      (error: unknown) => { requested.current.delete(id); update(id, (current) => ({ ...current, status: "error", error: error instanceof Error ? error.message : "Checked claims couldn't be loaded." })); },
    );
  }, [update, userId]);

  const check = useCallback(async (id: string) => {
    const conversation = conversationsRef.current[id];
    if (!readableByRatchet(conversation) || running.current.has(id)) return;
    const controller = new AbortController();
    running.current.set(id, controller);
    requested.current.add(id);
    update(id, (current) => ({ ...current, status: "checking", error: undefined, progress: { phase: "extracting", checked: 0, total: 0 } }));
    try {
      const all = conversationsRef.current;
      const corpus = createRatchetCorpus({ conversations: all, searchCloud });
      const result = await runClaimCheck({
        source: ratchetSource(conversation, all), corpus, ask: ask(id), signal: controller.signal,
        runId: typeof crypto.randomUUID === "function" ? crypto.randomUUID() : `run-${Date.now()}`,
        onProgress: (progress) => update(id, (current) => ({ ...current, progress })),
      });
      const skipped = corpus.skippedCloudOnly();
      if (skipped) result.run.omissions.push(`${skipped} match${skipped === 1 ? "" : "es"} by meaning ${skipped === 1 ? "was" : "were"} in documents not downloaded to this device, so ${skipped === 1 ? "it wasn't" : "they weren't"} read.`);
      let unsaved = false;
      try { await saveRatchetCheck(userId, id, result); } catch { unsaved = true; }
      update(id, (current) => ({ ...current, status: "ready", claims: result.claims, run: result.run, progress: undefined, unsaved }));
    } catch (error) {
      update(id, (current) => ({ ...current, status: current.run ? "ready" : "error", progress: undefined,
        error: controller.signal.aborted ? "Stopped. Nothing from this check was kept." : error instanceof Error ? error.message : "The claim check failed." }));
    } finally {
      running.current.delete(id);
    }
  }, [ask, searchCloud, update, userId]);

  const stop = useCallback((id: string) => { running.current.get(id)?.abort(); }, []);
  useEffect(() => () => { for (const controller of running.current.values()) controller.abort(); }, []);

  // Re-read every loaded document's claims against the vault as it is now.
  const claimsKey = Object.entries(documents).map(([id, state]) => `${id}:${state.run?.id ?? ""}:${state.claims.length}`).join("|");
  useEffect(() => {
    let cancelled = false;
    const corpus = createRatchetCorpus({ conversations });
    void (async () => {
      const next: Record<string, Pick<RatchetDocumentState, "anchors" | "evidence">> = {};
      for (const [id, state] of Object.entries(documents)) {
        if (!state.claims.length) continue;
        const source = corpus.get(id) ?? (conversations[id] ? ratchetSource(conversations[id], conversations) : undefined);
        const anchors: Record<string, AnchorState> = {};
        const evidence: Record<string, EvidenceState[]> = {};
        for (const claim of state.claims) {
          anchors[claim.id] = await locateClaim(claim, source);
          evidence[claim.id] = await Promise.all(claim.evidence.map((item) => resolveEvidence(item, corpus)));
        }
        next[id] = { anchors, evidence };
      }
      if (cancelled) return;
      setDocuments((current) => {
        let changed = false;
        const out = { ...current };
        for (const [id, located] of Object.entries(next)) {
          if (!out[id] || JSON.stringify(out[id].anchors) === JSON.stringify(located.anchors) && JSON.stringify(out[id].evidence) === JSON.stringify(located.evidence)) continue;
          out[id] = { ...out[id], ...located };
          changed = true;
        }
        return changed ? out : current;
      });
    })();
    return () => { cancelled = true; };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [conversations, claimsKey]);

  /** Highlights for a document's claims whose lines are still where they were, by block. */
  const highlights = useCallback((id: string): Record<string, RatchetHighlight[]> => {
    const state = documents[id];
    const conversation = conversations[id];
    if (!state?.claims.length || !conversation) return EMPTY;
    const blocks = new Map(ratchetSource(conversation, conversations).blocks.map((block) => [block.id, block.content]));
    const out: Record<string, RatchetHighlight[]> = {};
    for (const claim of state.claims) {
      const anchor = state.anchors[claim.id];
      if (anchor?.state !== "ok") continue;
      const content = blocks.get(anchor.blockId);
      if (content === undefined) continue;
      const range = claimOffsets(content, anchor.lineStart, anchor.lineEnd, claim.span);
      if (range) (out[anchor.blockId] ??= []).push({ claimId: claim.id, verdict: claim.verdict, ...range });
    }
    return out;
  }, [conversations, documents]);

  return { documents, load, check, stop, highlights };
}
