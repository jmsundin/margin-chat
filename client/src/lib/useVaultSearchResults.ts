import { useEffect, useRef, useState } from "react";
import type { VaultSearchProvider, VaultSearchRequest, VaultSearchResults } from "./vaultSearch";

/**
 * The results of one vault search, kept steady while the vault changes under it.
 *
 * The workspace hands search a new provider whenever the vault changes (a sync, documents
 * still loading on a big vault), and each one searches again: first this device's results
 * alone, then the cloud's as they stream in. Drawing every step made an open search jump
 * between "Answer from my vault" and "Found these" while nothing was typed. A new search of
 * the same words keeps what is shown until its results are whole; new words show at once.
 */
export function useVaultSearchResults(provider: VaultSearchProvider, request: VaultSearchRequest, enabled = true) {
  const [results, setResults] = useState<VaultSearchResults | null>(null);
  const shown = useRef<string | null>(null);
  const { query, scope, currentConversationId } = request;
  useEffect(() => {
    if (!enabled) { shown.current = null; return; }
    const key = JSON.stringify([query, scope, currentConversationId ?? ""]);
    const refresh = shown.current === key;
    shown.current = key;
    return provider.search({ query, scope, currentConversationId }, (next) => {
      if (refresh && next.complete === false) return;
      setResults(next);
    });
  }, [enabled, provider, query, scope, currentConversationId]);
  return results;
}
