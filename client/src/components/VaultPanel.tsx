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
      <p className="thread-dialog-copy">Edits save in this browser’s private storage on your device first. No folder connection is needed. Cloud sync exchanges changes with your other devices when Margin Chat is open or resumes.</p></div>
    <div className="profile-storage-status-list">
      <div className="profile-storage-status"><span>Browser storage · this device</span><strong>{vault.localSaveError ? "Save needs attention" : vault.saving ? "Saving in this browser…" : "Saved in this browser"}</strong><small>Markdown files are stored in space reserved for Margin Chat on this device. These files aren’t visible in Finder or Files.</small></div>
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
      <div><span>Optional folder connection</span><strong>{vault.localDirectoryStatus.directoryName ?? "No folder connected"}</strong>
        <small>{vault.localDirectoryStatus.directoryName
          ? "This folder also holds Markdown files you can open in other apps. Folder edits are checked before saving and when Margin Chat resumes."
          : vault.localDirectoryStatus.supported
            ? "Choose a folder to also keep your Markdown files somewhere you can open in other apps. Saving in this browser works without a connected folder."
            : "Folder connections aren’t available in this browser. Files still save in its private storage. Use Download vault to get a copy you can open in other apps."}</small></div>
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
    <p className="profile-storage-footnote">Clearing Margin Chat’s site data removes the files saved in this browser. Use Download vault to keep an independent copy. Files already synchronized remain in the cloud, and a connected folder’s files stay in that folder.</p>
  </>;
}
