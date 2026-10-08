import { useDeferredValue, useState } from "react";
import type { VaultFetchStatus } from "../lib/useMarkdownVault";
import { searchVaultIndex } from "../lib/vaultHydration";
import type { VaultIndexEntry } from "../lib/vaultTypes";
import "./CloudVaultIndex.css";

const VISIBLE_LIMIT = 40;

function formatDate(value?: string) {
  if (!value || !Number.isFinite(Date.parse(value))) return "";
  return new Date(value).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

/** Shows that documents are downloading, with progress when it is known. */
export function VaultFetchIndicator({ status, compact = false }: { status: VaultFetchStatus | null; compact?: boolean }) {
  if (!status) return null;
  const counted = status.total ? ` ${Math.min(status.done ?? 0, status.total)} of ${status.total}` : "";
  return <div className={`vault-fetch-indicator${compact ? " is-compact" : ""}`} role="status" aria-live="polite">
    <span className="vault-fetch-spinner" aria-hidden="true" />
    <span className="vault-fetch-label">{status.label}</span>
    {counted ? <span className="vault-fetch-count">{counted.trim()}</span> : null}
    {status.total ? <span className="vault-fetch-bar" aria-hidden="true">
      <span style={{ width: `${Math.round(Math.min(1, (status.done ?? 0) / status.total) * 100)}%` }} />
    </span> : null}
  </div>;
}

/** Every document still in the cloud, searchable by title, downloaded only when opened. */
export default function CloudVaultIndex({ documents, openingPath, onOpen }: {
  documents: VaultIndexEntry[];
  openingPath: string | null;
  onOpen: (path: string) => void;
}) {
  const [query, setQuery] = useState("");
  const [showAll, setShowAll] = useState(false);
  const deferredQuery = useDeferredValue(query);
  if (!documents.length) return null;
  const matches = searchVaultIndex(documents, deferredQuery);
  const visible = showAll || deferredQuery.trim() ? matches : matches.slice(0, VISIBLE_LIMIT);
  return <section className="cloud-vault-index" aria-label="Documents in your cloud vault">
    <div className="cloud-vault-index-header">
      <span>In your cloud vault</span>
      <span className="thread-section-count">{documents.length}</span>
    </div>
    <p className="cloud-vault-index-hint">These open when you select them. Nothing else needs to download first.</p>
    <input
      aria-label="Search your whole vault"
      className="cloud-vault-index-search"
      onChange={(event) => setQuery(event.target.value)}
      placeholder="Search your whole vault"
      type="search"
      value={query}
    />
    <ul className="cloud-vault-index-list">
      {visible.map((entry) => {
        const opening = openingPath === entry.path;
        return <li key={entry.path}>
          <button
            aria-busy={opening}
            className={`cloud-vault-index-item${opening ? " is-opening" : ""}`}
            disabled={!!openingPath}
            onClick={() => onOpen(entry.path)}
            title={entry.title}
            type="button"
          >
            <span className="cloud-vault-index-title">{entry.title}</span>
            <span className="cloud-vault-index-meta">
              {opening ? <><span className="vault-fetch-spinner" aria-hidden="true" />Downloading…</> : formatDate(entry.updated ?? entry.created)}
            </span>
          </button>
        </li>;
      })}
    </ul>
    {!visible.length ? <p className="cloud-vault-index-hint">No documents in your vault match “{deferredQuery}”.</p> : null}
    {visible.length < matches.length ? <button className="cloud-vault-index-more" onClick={() => setShowAll(true)} type="button">
      Show all {matches.length}
    </button> : null}
  </section>;
}
