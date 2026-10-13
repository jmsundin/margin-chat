import { useEffect, useRef, useState } from "react";
import type { useMarkdownVault } from "../lib/useMarkdownVault";
import "./VaultSwitcher.css";

type Vault = ReturnType<typeof useMarkdownVault>;

function FolderIcon() {
  return (
    <svg aria-hidden="true" className="vault-switcher-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.8">
      <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
    </svg>
  );
}

function ChevronIcon() {
  return (
    <svg aria-hidden="true" className="vault-switcher-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor"
      strokeLinecap="round" strokeLinejoin="round" strokeWidth="2">
      <path d="m8 10 4-4 4 4M8 14l4 4 4-4" />
    </svg>
  );
}

/** What the sidebar calls the open vault, and a line about where it is kept. */
export function describeVault(vault: Pick<Vault, "localDirectoryStatus" | "folderAccessMessage" | "saving" | "localSaveError" | "storageMode">, cloudSync: boolean) {
  const folder = vault.localDirectoryStatus.directoryName;
  const name = folder ?? "App vault";
  const cloud = !cloudSync ? "" : vault.storageMode === "server" ? " · synced to the cloud" : " · not synced yet";
  const where = vault.folderAccessMessage ? "Needs access to see new files"
    : vault.localSaveError ? "Save needs attention"
    : vault.saving ? "Saving…"
    : `${folder ? "Folder on this device" : "Saved in the app"}${cloud}`;
  return { name, where, folder };
}

/**
 * The open vault at the foot of the sidebar, like Obsidian's vault switcher:
 * shows which folder is open and lets the user open another one without
 * going to settings.
 */
export default function VaultSwitcher({ vault, cloudSync, onOpenSettings }: {
  vault: Vault;
  cloudSync: boolean;
  onOpenSettings: () => void;
}) {
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [uploading, setUploading] = useState(false);
  const [uploaded, setUploaded] = useState<string | null>(null);
  const uploadRef = useRef<HTMLInputElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const { name, where, folder } = describeVault(vault, cloudSync);
  const supported = vault.localDirectoryStatus.supported;
  const others = (vault.localDirectories ?? []).filter((directory) => !directory.current);

  useEffect(() => {
    if (!open) return;
    menuRef.current?.querySelector<HTMLButtonElement>("button:not(:disabled)")?.focus();
    const outside = (event: Event) => {
      if (event.target instanceof Node && !menuRef.current?.contains(event.target) && !triggerRef.current?.contains(event.target)) setOpen(false);
    };
    const key = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      event.preventDefault();
      setOpen(false);
      triggerRef.current?.focus();
    };
    document.addEventListener("pointerdown", outside, true);
    document.addEventListener("keydown", key);
    return () => { document.removeEventListener("pointerdown", outside, true); document.removeEventListener("keydown", key); };
  }, [open]);

  async function upload(files: File[]) {
    setBusy(true); setUploading(true); setError(null); setUploaded(null);
    try {
      // The menu stays open to say what was added.
      setUploaded((await vault.uploadFiles(files)).summary);
      setOpen(true);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Those files couldn’t be added. Try again.");
      setOpen(true);
    } finally {
      setBusy(false); setUploading(false);
    }
  }

  async function run(action: () => Promise<unknown>) {
    setBusy(true); setError(null); setUploaded(null);
    try {
      await action();
      setOpen(false);
    } catch (failure) {
      // Closing the folder chooser is not an error.
      if (failure instanceof DOMException && failure.name === "AbortError") return;
      setError(failure instanceof Error ? failure.message : "That didn’t work. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="vault-switcher">
      <button ref={triggerRef} type="button" className={`vault-switcher-trigger${vault.folderAccessMessage ? " needs-access" : ""}`}
        aria-haspopup="menu" aria-expanded={open} aria-controls={open ? "vault-switcher-menu" : undefined}
        aria-label={`Vault: ${name}. ${where}. Switch vault`} title={`${name} · ${where}`}
        onClick={() => { setError(null); setUploaded(null); setOpen((value) => !value); }}>
        <FolderIcon />
        <span className="vault-switcher-name">{name}</span>
        {vault.folderAccessMessage ? <span className="vault-switcher-dot" aria-hidden="true" /> : null}
        <ChevronIcon />
      </button>
      {open ? (
        <div ref={menuRef} id="vault-switcher-menu" className="vault-switcher-menu" role="menu" aria-label="Vaults">
          <div className="vault-switcher-current" role="none">
            <strong>{name}</strong>
            <small>{where}</small>
          </div>
          {vault.folderAccessMessage ? (
            <button type="button" role="menuitem" className="vault-switcher-item is-primary" disabled={busy}
              onClick={() => void run(vault.allowDirectoryAccess)}>
              Allow access to “{folder}”
            </button>
          ) : null}
          {others.length ? <div className="vault-switcher-label" role="none">Folders used before</div> : null}
          {others.map((directory) => (
            <button key={directory.id} type="button" role="menuitem" className="vault-switcher-item" disabled={busy}
              onClick={() => void run(() => vault.switchDirectory(directory.id))}>
              <FolderIcon /><span>{directory.name}</span>
            </button>
          ))}
          <button type="button" role="menuitem" className="vault-switcher-item" disabled={busy}
            onClick={() => uploadRef.current?.click()}>
            {uploading ? "Adding files…" : "Upload files…"}
          </button>
          <button type="button" role="menuitem" className="vault-switcher-item" disabled={busy || !supported}
            onClick={() => void run(vault.chooseDirectory)}>
            {folder ? "Open another folder…" : "Open folder as vault…"}
          </button>
          {!supported ? <p className="vault-switcher-note" role="none">
            This browser can’t open folders. Upload files adds notes, PDFs, photos or a zipped vault folder instead.
          </p> : null}
          {cloudSync ? (
            <button type="button" role="menuitem" className="vault-switcher-item" disabled={busy} onClick={() => void run(() => vault.syncNow())}>
              {busy ? "Working…" : "Sync now"}
            </button>
          ) : null}
          {folder ? (
            <button type="button" role="menuitem" className="vault-switcher-item" disabled={busy} onClick={() => void run(vault.clearDirectory)}>
              Disconnect folder
            </button>
          ) : null}
          <button type="button" role="menuitem" className="vault-switcher-item" onClick={() => { setOpen(false); onOpenSettings(); }}>
            Vault settings…
          </button>
          {uploaded ? <p className="vault-switcher-note" role="status">{uploaded}</p> : null}
          {error ? <p className="vault-switcher-error" role="alert">{error}</p> : null}
        </div>
      ) : null}
      {/* No accept list: phones grey out .md files they don't recognise. Unsupported files are named afterwards. */}
      <input ref={uploadRef} hidden multiple type="file" data-vault-upload
        onChange={(event) => {
          const files = Array.from(event.currentTarget.files ?? []); event.currentTarget.value = "";
          if (files.length) void upload(files);
        }} />
    </div>
  );
}
