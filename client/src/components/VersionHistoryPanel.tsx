import { useEffect, useId, useMemo, useState } from "react";
import { createPortal } from "react-dom";
import { diffWords, versionText, type DocumentVersion, type VersionRecord } from "../lib/versionHistory";
import type { VaultFile } from "../lib/vaultTypes";
import "./VersionHistoryPanel.css";

export interface VersionHistoryPanelProps {
  title: string;
  path: string | undefined;
  current: VaultFile | null;
  records: VersionRecord[];
  /** Which version to show first, such as the other wording from a clash notice. */
  initialKey?: string;
  onRestore: (version: DocumentVersion) => Promise<void>;
  /** Downloads versions this device hasn't fetched from the cloud yet. */
  onLoad?: () => Promise<void>;
  onClose: () => void;
}

const ROLE_LABELS: Record<DocumentVersion["role"], string> = {
  kept: "The wording that was kept",
  device: "One device's wording",
  "before-restore": "The text before you restored",
};

export function formatVersionTime(at: string, now = new Date()): string {
  const date = new Date(at);
  const time = date.toLocaleTimeString(undefined, { hour: "numeric", minute: "2-digit" });
  const sameDay = (a: Date, b: Date) => a.toDateString() === b.toDateString();
  if (sameDay(date, now)) return `Today ${time}`;
  const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
  if (sameDay(date, yesterday)) return `Yesterday ${time}`;
  return `${date.toLocaleDateString(undefined, { month: "short", day: "numeric", ...(date.getFullYear() !== now.getFullYear() ? { year: "numeric" } : {}) })} ${time}`;
}

/**
 * Version history: earlier versions of this document, newest first. Picking one shows what restoring it
 * would bring back (green) and take out (struck through). Restoring keeps the replaced text as a version.
 */
export default function VersionHistoryPanel({ title, path, current, records, initialKey, onRestore, onLoad, onClose }: VersionHistoryPanelProps) {
  const titleId = useId();
  const versions = useMemo(() => records.flatMap((record) => record.versions), [records]);
  const [selectedKey, setSelectedKey] = useState<string | null>(() =>
    initialKey ?? versions.find((version) => version.role !== "kept")?.key ?? versions[0]?.key ?? null);
  const [loading, setLoading] = useState(Boolean(onLoad));
  const [status, setStatus] = useState<{ kind: "busy" | "done" | "error"; text: string } | null>(null);
  const selected = versions.find((version) => version.key === selectedKey) ?? null;
  const currentText = useMemo(() => path && current ? versionText(path, current) : "", [path, current]);
  const selectedText = useMemo(() => selected && path ? versionText(path, selected.file) : "", [selected, path]);
  const parts = useMemo(() => selected ? diffWords(currentText, selectedText) : [], [currentText, selectedText, selected]);
  const sameAsNow = Boolean(selected) && selectedText === currentText;

  useEffect(() => {
    if (!onLoad) return;
    let current = true;
    onLoad().catch(() => undefined).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
    // Load once when the panel opens.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Versions that arrive after the panel opened: show the most useful one.
  useEffect(() => {
    if (selectedKey && versions.some((version) => version.key === selectedKey)) return;
    const next = initialKey && versions.some((version) => version.key === initialKey) ? initialKey
      : versions.find((version) => version.role !== "kept")?.key ?? versions[0]?.key ?? null;
    if (next !== selectedKey) setSelectedKey(next);
  }, [versions, selectedKey, initialKey]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => { if (event.key === "Escape" && !event.defaultPrevented) onClose(); };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  async function restore() {
    if (!selected || sameAsNow || status?.kind === "busy") return;
    setStatus({ kind: "busy", text: "Restoring…" });
    try {
      await onRestore(selected);
      setStatus({ kind: "done", text: "Restored. The text it replaced is saved at the top of this list." });
    } catch (error) {
      setStatus({ kind: "error", text: error instanceof Error ? error.message : "This version couldn't be restored." });
    }
  }

  return createPortal(<aside className="version-history" role="complementary" aria-labelledby={titleId}>
    <header className="version-history-head">
      <div>
        <h2 id={titleId}>Version history</h2>
        <p className="version-history-subtitle">{title}</p>
      </div>
      <button type="button" className="version-history-close" aria-label="Close version history" onClick={onClose}>×</button>
    </header>
    {records.length ? <>
      <ol className="version-history-list" aria-label="Earlier versions">
        {records.map((record) => <li key={record.id}>
          <p className="version-history-when">{formatVersionTime(record.at)} · {record.reason === "clash" ? "Edited on two devices at the same time" : "Restored an earlier version"}</p>
          <ul>{record.versions.map((version) => <li key={version.key}>
            <button type="button" className="version-history-version" aria-pressed={version.key === selectedKey}
              onClick={() => { setSelectedKey(version.key); setStatus(null); }}>{ROLE_LABELS[version.role]}</button>
          </li>)}</ul>
        </li>)}
      </ol>
      {selected ? <section className="version-history-preview" aria-label="Selected version">
        <p className="version-history-legend">{sameAsNow ? "This is the same as the document now."
          : <>Restoring brings back <ins>green</ins> text and takes out <del>struck-through</del> text.</>}</p>
        <div className="version-history-text">{parts.map((part, index) => part.kind === "added" ? <ins key={index}>{part.text}</ins>
          : part.kind === "removed" ? <del key={index}>{part.text}</del> : <span key={index}>{part.text}</span>)}</div>
        <div className="version-history-actions">
          <button type="button" className="version-history-restore" disabled={sameAsNow || status?.kind === "busy"} onClick={() => void restore()}>
            Restore this version</button>
          {status ? <p className={`version-history-status is-${status.kind}`} role="status">{status.text}</p> : null}
        </div>
      </section> : null}
    </> : loading ? <p className="version-history-empty" role="status">Looking for earlier versions…</p>
      : <p className="version-history-empty">No earlier versions yet. When this document is changed on two devices at the same time,
      or you restore an earlier version, the other text is kept here.</p>}
  </aside>, document.body);
}
