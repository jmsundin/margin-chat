import { useRef, useState } from "react";
import type { useMarkdownVault } from "../lib/useMarkdownVault";

export default function VaultPanel({ vault, cloudSyncEnabled }: { vault: ReturnType<typeof useMarkdownVault>; cloudSyncEnabled: boolean }) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const input = useRef<HTMLInputElement>(null);
  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError(null);
    try { await action(); } catch (failure) { setError(failure instanceof Error ? failure.message : "Unable to complete this action."); }
    finally { setBusy(false); }
  }
  return <>
    <div><p className="eyebrow">Markdown vault</p><h3>Your files, on every device</h3>
      <p className="thread-dialog-copy">Edits save on this device first. Sync exchanges changed files when Margin Chat is open or resumes. Conflicting edits are kept for review.</p></div>
    <div className="profile-storage-status-list">
      <div className="profile-storage-status"><span>On this device</span><strong>{vault.localSaveError ? "Save needs attention" : vault.saving ? "Saving…" : "Markdown saved locally"}</strong><small>Download your vault to keep a portable copy.</small></div>
      <div className="profile-storage-status"><span>Other devices</span><strong>{!cloudSyncEnabled ? "Local only" : vault.matchesCloud ? "Up to date" : vault.storageMode === "server" ? "Changes waiting to sync" : "Waiting to sync"}</strong>
        <small>{vault.conflicts.length ? "Saved versions need review below." : cloudSyncEnabled ? "Open Margin Chat on another device to receive changes." : "Cloud sync requires a paid plan or admin access."}</small></div>
    </div>
    {(error || vault.message) ? <p className="profile-dialog-error" role="alert">{error ?? vault.message}</p> : null}
    <div className="profile-storage-directory-actions">
      <button className="thread-dialog-button is-primary" disabled={busy || !cloudSyncEnabled} onClick={() => void run(() => vault.syncNow())}>{busy ? "Working…" : "Sync now"}</button>
      <button className="thread-dialog-button" disabled={busy} onClick={() => void run(vault.download)}>Download vault</button>
      <button className="thread-dialog-button" disabled={busy} onClick={() => input.current?.click()}>Import vault</button>
      <input ref={input} hidden type="file" accept=".zip,application/zip" onChange={(event) => {
        const file = event.currentTarget.files?.[0]; event.currentTarget.value = "";
        if (file) void run(() => vault.importArchive(file));
      }} />
    </div>
    <div className="profile-storage-directory-card">
      <div><span>Connected folder</span><strong>{vault.localDirectoryStatus.directoryName ?? "No folder connected"}</strong>
        <small>{vault.localDirectoryStatus.supported ? "Markdown edits in this folder are checked before saving and when the app resumes." : "This browser keeps files privately. Download a vault to open them in Files or another editor."}</small></div>
      <div className="profile-storage-directory-actions">
        <button className="thread-dialog-button" disabled={busy || !vault.localDirectoryStatus.supported} onClick={() => void run(vault.chooseDirectory)}>Choose folder</button>
        {vault.localDirectoryStatus.directoryName ? <button className="thread-dialog-button" disabled={busy} onClick={() => void run(vault.clearDirectory)}>Disconnect folder</button> : null}
      </div>
    </div>
    {vault.conflicts.length ? <div><h3>Review conflicting edits</h3>
      <p className="thread-dialog-copy">Both versions are preserved. Choose which version to use for this document. A recovery copy also remains in the vault.</p>
      {vault.conflicts.map((conflict) => <details className="profile-storage-directory-card" key={conflict.id}>
        <summary>{conflict.path}</summary>
        <div className="vault-conflict-versions">
          <label>This device<textarea readOnly value={conflict.local?.encoding === "base64" ? "Attached file (included in the vault download)" : conflict.local?.content ?? "File deleted on this device"} /></label>
          <label>Synced copy<textarea readOnly value={conflict.remote?.encoding === "base64" ? "Attached file (included in the vault download)" : conflict.remote?.content ?? "File deleted in the synced copy"} /></label>
        </div>
        <div className="profile-storage-directory-actions">
          <button className="thread-dialog-button" disabled={busy} onClick={() => void run(() => vault.resolveConflict(conflict.id, "local"))}>Use this device’s version</button>
          <button className="thread-dialog-button" disabled={busy} onClick={() => void run(() => vault.resolveConflict(conflict.id, "remote"))}>Use synced version</button>
          <button className="thread-dialog-button" disabled={busy} onClick={() => void run(() => vault.resolveConflict(conflict.id, "current"))}>Keep current file</button>
        </div>
      </details>)}
    </div> : null}
    <p className="profile-storage-footnote">Browser-private files are removed if you clear this site’s data. Download a vault for an independent copy, especially before clearing storage. Files already synchronized remain in the cloud.</p>
  </>;
}
