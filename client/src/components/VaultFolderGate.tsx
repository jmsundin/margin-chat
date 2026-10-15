import { useEffect, useState, type ReactNode } from "react";
import type { useMarkdownVault } from "../lib/useMarkdownVault";
import { describeFolderPreview, isLargeFolder, previewLocalDirectory, VaultFolderExistsError, type FolderPreview } from "../lib/desktopVault";
import { FolderUnavailableError } from "../lib/workspaceStorage";
import "./VaultFolderGate.css";

export type VaultFolderGateVault = Pick<ReturnType<typeof useMarkdownVault>,
  "vaultFolderPrompt" | "localDirectoryStatus" | "localDirectories" | "fetchStatus" | "downloadProgress" | "pickFolder" | "connectFolder"
  | "createVault" | "switchDirectory" | "allowDirectoryAccess" | "snoozeVaultFolderPrompt" | "checkFolder">;

type Phase =
  | { kind: "start" }
  | { kind: "naming" }
  | { kind: "looking"; name: string }
  | { kind: "confirm"; handle: FileSystemDirectoryHandle; preview: FolderPreview }
  | { kind: "connecting"; name: string; preview?: FolderPreview | null };

const isCancel = (error: unknown) => error instanceof Error && error.name === "AbortError";

/**
 * The desktop app's vault is a folder on the computer. Before the workspace
 * opens, this asks for one on first run, for one click to open a remembered
 * folder again, or says the remembered folder can't be found. It never writes to
 * a folder the person didn't pick.
 */
export default function VaultFolderGate({ vault, onBusyChange }: { vault: VaultFolderGateVault; onBusyChange?: (busy: boolean) => void }) {
  const [phase, setPhase] = useState<Phase>({ kind: "start" });
  const [name, setName] = useState("Margin Chat");
  const [error, setError] = useState<string | null>(null);
  const [existing, setExisting] = useState<FileSystemDirectoryHandle | null>(null);
  const [stillClosed, setStillClosed] = useState(false);
  const [working, setWorking] = useState(false);
  const [allowing, setAllowing] = useState(false);
  const busy = working || phase.kind === "looking" || phase.kind === "connecting";
  const folderName = vault.localDirectoryStatus.directoryName ?? "your vault folder";
  const others = (vault.localDirectories ?? []).filter((directory) => !directory.current);

  useEffect(() => { onBusyChange?.(busy); }, [busy]);
  useEffect(() => () => onBusyChange?.(false), []);

  /** Runs one choice; a picker closed without choosing is not an error. */
  async function run(action: () => Promise<void>, afterError: Phase = { kind: "start" }) {
    setError(null); setExisting(null);
    try { await action(); }
    catch (cause) {
      if (isCancel(cause)) return;
      if (cause instanceof VaultFolderExistsError) setExisting(cause.handle);
      setError(cause instanceof Error ? cause.message : "That didn’t work. Try again.");
      setPhase(afterError);
    }
  }

  /** Closes straight away once the folder is connected, rather than showing the first screen again. */
  function finish() {
    onBusyChange?.(false);
    setPhase({ kind: "start" });
  }

  async function connect(handle: FileSystemDirectoryHandle, preview?: FolderPreview | null) {
    setPhase({ kind: "connecting", name: handle.name, preview });
    await vault.connectFolder(handle);
    finish();
  }

  /** Count what the folder holds first, and ask before opening a very large one. */
  async function look(handle: FileSystemDirectoryHandle) {
    setPhase({ kind: "looking", name: handle.name });
    const preview = await previewLocalDirectory(handle).catch(() => null);
    if (preview && isLargeFolder(preview)) { setPhase({ kind: "confirm", handle, preview }); return; }
    await connect(handle, preview);
  }

  // The folder picker must open straight from the click, so it is the first thing each of these does.
  const openFolder = () => void run(async () => {
    const handle = await vault.pickFolder();
    if (handle) await look(handle);
  });
  const createVault = () => void run(async () => {
    if (await vault.createVault(name, (handle) => setPhase({ kind: "connecting", name: handle.name }))) finish();
  }, { kind: "naming" });
  const openExisting = (handle: FileSystemDirectoryHandle) => void run(() => look(handle), { kind: "naming" });
  const switchTo = (id: string, name: string) => void run(async () => {
    const switching = vault.switchDirectory(id);
    setPhase({ kind: "connecting", name });
    await switching;
    finish();
  });
  // Once allowed, the workspace opens while the folder is read in the background. Choosing the folder
  // again is the way forward when access can't be given back (or the folder has gone).
  const allow = () => void run(async () => {
    setAllowing(true);
    try { if (!await vault.allowDirectoryAccess()) setStillClosed(true); }
    catch { setStillClosed(true); }
    finally { setAllowing(false); }
  });
  const tryAgain = () => void run(async () => {
    setWorking(true);
    try { await vault.checkFolder(); }
    catch (cause) { throw cause instanceof FolderUnavailableError ? new Error(`Margin Chat still can’t find or open “${folderName}”.`) : cause; }
    finally { setWorking(false); }
  });
  const notNow = <button type="button" className="thread-dialog-button vault-folder-gate-quiet" disabled={busy} onClick={vault.snoozeVaultFolderPrompt}>Not now</button>;
  const usedBefore = others.length ? <ul className="vault-folder-gate-folders" aria-label="Folders used before">
    {others.map((directory) => <li key={directory.id}>
      <button type="button" className="thread-dialog-button" disabled={busy} onClick={() => switchTo(directory.id, directory.name)}>Open “{directory.name}”</button>
    </li>)}
  </ul> : null;
  const errorLine = error ? <p className="profile-dialog-error" role="alert">{error}</p> : null;

  let content: ReactNode;
  if (phase.kind === "connecting") {
    const progress = vault.downloadProgress?.total ? `${vault.downloadProgress.done.toLocaleString("en-US")} of ${vault.downloadProgress.total.toLocaleString("en-US")}` : null;
    content = <>
      <Heading title="Setting up your vault" />
      <p className="thread-dialog-copy">Copying your vault into “{phase.name}”…</p>
      {phase.preview && (phase.preview.markdownFiles || phase.preview.otherFiles)
        ? <p className="thread-dialog-warning">Found {describeFolderPreview(phase.preview)} in it.</p> : null}
      <p className="vault-folder-gate-progress" role="status">{vault.fetchStatus ? `${vault.fetchStatus.label}${progress ? ` ${progress}` : ""}` : "This can take a moment for a large vault."}</p>
    </>;
  } else if (phase.kind === "looking") {
    content = <>
      <Heading title="Opening your vault" />
      <p className="thread-dialog-copy" role="status">Looking inside “{phase.name}”…</p>
    </>;
  } else if (phase.kind === "confirm") {
    content = <>
      <Heading title={`Open “${phase.handle.name}”?`} />
      <p className="thread-dialog-copy">This folder holds {describeFolderPreview(phase.preview)}. Margin Chat reads every note in it and keeps it up to date, so a very large folder can be slow. Make sure it’s the folder you meant.</p>
      {errorLine}
      <div className="vault-folder-gate-actions">
        <button type="button" className="thread-dialog-button is-primary" onClick={() => void run(() => connect(phase.handle, phase.preview))}>Open it</button>
        <button type="button" className="thread-dialog-button" onClick={openFolder}>Choose another folder…</button>
        <button type="button" className="thread-dialog-button vault-folder-gate-quiet" onClick={() => setPhase({ kind: "start" })}>Back</button>
      </div>
    </>;
  } else if (phase.kind === "naming") {
    content = <>
      <Heading title="Create a new vault" />
      <p className="thread-dialog-copy">Margin Chat makes a folder with this name wherever you choose, and copies your vault into it.</p>
      <label className="thread-dialog-field">
        <span className="thread-dialog-label">Vault name</span>
        <input className="thread-dialog-input" value={name} maxLength={100} autoFocus onChange={(event) => setName(event.currentTarget.value)}
          onKeyDown={(event) => { if (event.key === "Enter" && name.trim()) createVault(); }} />
      </label>
      {errorLine}
      <div className="vault-folder-gate-actions">
        <button type="button" className="thread-dialog-button is-primary" disabled={!name.trim()} onClick={createVault}>Choose a location…</button>
        {existing ? <button type="button" className="thread-dialog-button" onClick={() => openExisting(existing)}>Open “{existing.name}” instead</button> : null}
        <button type="button" className="thread-dialog-button vault-folder-gate-quiet" onClick={() => { setError(null); setExisting(null); setPhase({ kind: "start" }); }}>Back</button>
      </div>
    </>;
  } else if (vault.vaultFolderPrompt === "allow") {
    content = <>
      <Heading title="Open your vault" />
      <p className="thread-dialog-copy">{stillClosed
        ? `Margin Chat still can’t open “${folderName}”. Choose the folder to give it access.`
        : `Margin Chat needs your OK to open “${folderName}” again.`}</p>
      {errorLine}
      <div className="vault-folder-gate-actions">
        {stillClosed
          ? <button type="button" className="thread-dialog-button is-primary" disabled={busy} onClick={openFolder}>Choose the folder…</button>
          : <button type="button" className="thread-dialog-button is-primary" disabled={busy || allowing} onClick={allow}>Allow access to “{folderName}”</button>}
        {notNow}
      </div>
    </>;
  } else if (vault.vaultFolderPrompt === "missing") {
    content = <>
      <Heading title="Can’t find your vault folder" />
      <p className="thread-dialog-copy">Margin Chat can’t find or open “{folderName}”. It may have been moved, renamed or be on a drive that isn’t connected. Your notes are safe in the app, and nothing in the folder has been changed.</p>
      <p className="thread-dialog-warning">If you moved it, choose it again where it is now, or choose another folder.</p>
      {errorLine}
      <div className="vault-folder-gate-actions">
        <button type="button" className="thread-dialog-button is-primary" disabled={busy} onClick={openFolder}>Choose a folder…</button>
        <button type="button" className="thread-dialog-button" disabled={busy} onClick={tryAgain}>{working ? "Looking…" : "Try again"}</button>
        {notNow}
      </div>
      {usedBefore}
    </>;
  } else if (vault.vaultFolderPrompt === "choose") {
    content = <>
      <Heading title="Where should your vault live?" />
      <p className="thread-dialog-copy">Margin Chat keeps your notes as Markdown files in a folder on this computer, so other apps can open them too. Open a folder you already use, or make a new one.</p>
      <p className="thread-dialog-copy">Notes without one get a short header with a Margin Chat ID, so each note stays the same note when it’s renamed or synced.</p>
      {errorLine}
      <div className="vault-folder-gate-actions">
        <button type="button" className="thread-dialog-button is-primary" disabled={busy} onClick={openFolder}>Open a folder…</button>
        <button type="button" className="thread-dialog-button" disabled={busy} onClick={() => { setError(null); setPhase({ kind: "naming" }); }}>Create a new vault…</button>
        {notNow}
      </div>
      {usedBefore}
      <p className="thread-dialog-warning">Until you choose, your notes are saved in the app.</p>
    </>;
  } else {
    // The folder is open; this shows only for the moment before the workspace replaces it.
    content = <>
      <Heading title="Opening your vault" />
      <p className="thread-dialog-copy" role="status">Opening “{folderName}”…</p>
    </>;
  }

  return <div className="auth-shell vault-folder-gate">
    <section className="thread-dialog" role="dialog" aria-modal="true" aria-labelledby="vault-folder-gate-title" aria-busy={busy}>{content}</section>
  </div>;
}

function Heading({ title }: { title: string }) {
  return <div className="thread-dialog-head"><div><p className="eyebrow">Markdown vault</p><h2 id="vault-folder-gate-title">{title}</h2></div></div>;
}
