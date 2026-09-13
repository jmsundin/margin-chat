import { useEffect, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { AppState, AuthenticatedUser } from "../types";
import type { StateUploadProgress } from "./api";
import { getStateSavedAtStorageKey, getStateStorageKey } from "./appState";
import { createVaultTransport } from "./vaultApi";
import { bytesToBase64, createBrowserVaultStore, exportVault, importVault } from "./vaultLocal";
import { VaultSync, pendingVaultChanges } from "./vaultSync";
import { sameVaultFile, type VaultFile, type VaultSnapshot, type VaultConflict } from "./vaultTypes";
import { normalizeVaultMarkdownIdentities, stateToVaultFiles, vaultToState, workspaceFromVault, workspaceVaultFiles } from "./vaultWorkspace";
import {
  canSyncWorkspaceToCloud, chooseLocalDirectory, clearLocalDirectory, getLocalDirectoryStatus,
  getLocalWorkspaceFileName, readLocalDirectoryWorkspace, writeLocalDirectoryWorkspace,
  readLocalDirectoryCompanions, syncLocalDirectoryCompanions,
  type LocalDirectoryStatus,
} from "./workspaceStorage";
import type { MarkdownWorkspace } from "./workspaceMarkdown";

type StorageMode = "loading" | "fallback" | "local" | "server";

export function useMarkdownVault(args: {
  user: AuthenticatedUser;
  state: AppState;
  setState: Dispatch<SetStateAction<AppState>>;
  legacyHasState: boolean;
}) {
  const { user, setState } = args;
  const stateRef = useRef(args.state);
  stateRef.current = args.state;
  const enabled = canSyncWorkspaceToCloud(user);
  const enabledRef = useRef(enabled);
  enabledRef.current = enabled;
  const [ready, setReady] = useState(false);
  const [storageMode, setStorageMode] = useState<StorageMode>("loading");
  const [matchesCloud, setMatchesCloud] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [conflicts, setConflicts] = useState<VaultConflict[]>([]);
  const [saving, setSaving] = useState(false);
  const [localSaveError, setLocalSaveError] = useState<string | null>(null);
  const [localDirectoryStatus, setDirectoryStatus] = useState<LocalDirectoryStatus>({
    directoryName: null, fileName: getLocalWorkspaceFileName(user.id), permission: "unselected", supported: false,
  });
  const engineRef = useRef<VaultSync | null>(null);
  if (!engineRef.current) engineRef.current = new VaultSync(createBrowserVaultStore(user.id), createVaultTransport(user.id));
  const engine = engineRef.current;
  const displayedFiles = useRef<Record<string, VaultFile>>({});
  const displayedState = useRef(args.state);
  const folder = useRef<MarkdownWorkspace | null>(null);
  const folderCompanions = useRef<Record<string, VaultFile>>({});
  const mounted = useRef(true);
  const queue = useRef(Promise.resolve());
  const localInFlight = useRef<Promise<VaultSnapshot> | null>(null);
  const automaticRefreshPending = useRef(false);
  const initialized = useRef(false);
  const hasVaultContent = useRef(false);
  const writing = useRef(false);

  function enqueue<T>(operation: () => Promise<T>): Promise<T> {
    const next = queue.current.then(operation);
    queue.current = next.then(() => undefined, () => undefined);
    return next;
  }

  function report(error: unknown) {
    if (!mounted.current) return;
    setStorageMode(enabledRef.current ? "fallback" : "local");
    setMatchesCloud(false);
    const detail = error instanceof Error ? error.message : "Your vault could not be synchronized.";
    setMessage(/failed to fetch|load failed|networkerror|network request failed/i.test(detail)
      || (error instanceof Error && ["AbortError", "TimeoutError"].includes(error.name))
      ? "Cloud sync is unavailable. Your local files are still available; sync will retry when connected."
      : detail);
  }

  function publish(snapshot: VaultSnapshot) {
    const next = vaultToState(snapshot.files, stateRef.current);
    displayedFiles.current = structuredClone(snapshot.files);
    displayedState.current = next;
    hasVaultContent.current = workspaceFromVault(snapshot.files).manifest.files.length > 0;
    stateRef.current = next;
    if (!mounted.current) return;
    setState(next);
    setConflicts(snapshot.conflicts);
    setMatchesCloud(enabledRef.current && pendingVaultChanges(snapshot).length === 0);
  }

  function saveAppState(): Promise<VaultSnapshot> {
    if (localInFlight.current) return localInFlight.current;
    const work = (async () => {
      try {
        let snapshot: VaultSnapshot;
        do { snapshot = await saveLatestAppState(); }
        while (stateRef.current !== displayedState.current);
        if (mounted.current) setLocalSaveError(null);
        return snapshot;
      } catch (error) {
        if (mounted.current) setLocalSaveError(error instanceof Error ? error.message : "This edit could not be saved on your device.");
        throw error;
      }
    })();
    localInFlight.current = work;
    void work.finally(() => { if (localInFlight.current === work) localInFlight.current = null; }).catch(() => undefined);
    return work;
  }

  async function saveLatestAppState() {
    if (stateRef.current === displayedState.current) return engine.read();
    // A pristine empty editor is UI, not a new document resurrected after a remote deletion.
    const conversations = Object.values(stateRef.current.conversations);
    const pristine = conversations.length === 1 && conversations[0].kind !== "note" && conversations[0].title === "New chat"
      && !conversations[0].messages.length && !conversations[0].notes?.length && !conversations[0].documents?.length;
    if (!hasVaultContent.current && pristine) { displayedState.current = stateRef.current; return engine.read(); }
    const editingState = stateRef.current;
    const next = stateToVaultFiles(editingState, displayedFiles.current);
    const snapshot = await engine.edit(next, displayedFiles.current);
    displayedFiles.current = next;
    displayedState.current = editingState;
    hasVaultContent.current = true;
    if (mounted.current) {
      setConflicts(snapshot.conflicts);
      setMatchesCloud(enabledRef.current && !pendingVaultChanges(snapshot).length);
    }
    return snapshot;
  }

  async function persistAndPublish() {
    let snapshot = await saveAppState();
    // Do not replace keystrokes entered while the last durable file write was closing.
    while (stateRef.current !== displayedState.current) snapshot = await saveAppState();
    publish(snapshot);
    return snapshot;
  }

  async function readFolder() {
    const status = await getLocalDirectoryStatus(user.id);
    if (mounted.current) setDirectoryStatus(status);
    if (status.permission !== "granted") return;
    const incoming = await readLocalDirectoryWorkspace(user.id, folder.current?.manifest);
    if (!incoming) return;
    const companions = await readLocalDirectoryCompanions(user.id, folderCompanions.current) ?? {};
    // Settings are parsed/canonicalized with Markdown; preserve raw companion bytes for disk checks.
    const withoutSettings = (files: Record<string, VaultFile>) => Object.fromEntries(Object.entries(files).filter(([path]) => path !== "workspace.json"));
    const next = { ...workspaceVaultFiles(incoming.workspace), ...withoutSettings(companions) };
    const expected = { ...(folder.current ? workspaceVaultFiles(folder.current) : {}), ...withoutSettings(folderCompanions.current) };
    // An empty newly chosen directory is an output destination, not deletion of the vault.
    if (folder.current || Object.keys(incoming.workspace.files).length || Object.keys(companions).length) await engine.edit(next, expected);
    folder.current = incoming.workspace;
    folderCompanions.current = companions;
  }

  async function writeFolder(snapshot: VaultSnapshot) {
    if (!folder.current) return;
    const workspace = workspaceFromVault(snapshot.files, folder.current);
    const status = await writeLocalDirectoryWorkspace(user.id, workspace, folder.current);
    folder.current = workspace;
    const companions = await syncLocalDirectoryCompanions(user.id, snapshot.files, folderCompanions.current);
    if (companions) folderCompanions.current = companions;
    if (mounted.current) setDirectoryStatus(status);
  }

  async function cacheAttachments() {
    const documents = new Map(Object.values(stateRef.current.conversations).flatMap((conversation) => conversation.documents ?? []).map((document) => [document.id, document]));
    for (const [id, document] of documents) {
      const current = await engine.read();
      const metadataPath = `Attachments/${id}/metadata.json`;
      const existing = current.files[metadataPath];
      if (existing && current.files[JSON.parse(existing.content).path]) continue;
      const url = `/api/documents/${encodeURIComponent(id)}/original`;
      const metadataResponse = await fetch(`${url}?metadata=1`, { credentials: "same-origin", headers: { "X-Margin-Vault-User": user.id }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!metadataResponse.ok) throw new Error(`Connect to download the original attachment “${document.filename}” before exporting the complete vault.`);
      const { attachment } = await metadataResponse.json();
      const response = await fetch(url, { credentials: "same-origin", headers: { "X-Margin-Vault-User": user.id }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!response.ok) throw new Error(`The attachment “${document.filename}” could not be saved locally.`);
      const filename = String(attachment.filename).replace(/[\\/\u0000-\u001f%:#?]/gu, "_").slice(0, 180) || "attachment";
      const path = attachment.path ?? `Attachments/${id}/${filename === "metadata.json" ? "original-metadata.json" : filename}`;
      const added = {
        [metadataPath]: { content: JSON.stringify({ ...attachment, path }, null, 2), contentType: "application/json" },
        [path]: { content: bytesToBase64(new Uint8Array(await response.arrayBuffer())), encoding: "base64" as const, contentType: attachment.mimeType ?? "application/octet-stream" },
      };
      await engine.edit(added, {});
    }
  }

  async function saveAndRefresh(sync: boolean) {
    if (!initialized.current) return;
    writing.current = true;
    if (mounted.current) setSaving(true);
    try {
      await saveAppState();
      await readFolder();
      if (sync && enabledRef.current) {
        await engine.sync();
        if (mounted.current) { setStorageMode("server"); setMessage(null); }
      }
      // Free accounts also retain originals on this device after an online upload.
      if (sync && !enabledRef.current) await cacheAttachments();
      // Capture typing that occurred while a network request or directory read was pending.
      const snapshot = await persistAndPublish();
      await writeFolder(snapshot);
      if (!enabledRef.current && mounted.current) setStorageMode("local");
    } catch (error) {
      // Even failed sync may have persisted remote revisions/conflicts. Keep later typing first.
      try { await persistAndPublish(); } catch (localError) { report(localError); }
      report(error);
      throw error;
    } finally {
      writing.current = false;
      if (mounted.current) setSaving(false);
    }
  }

  function scheduleAutomaticRefresh() {
    // A slow/offline request must not accumulate one queued sync per keystroke,
    // focus event, or interval. Local saves remain independent of this queue.
    if (automaticRefreshPending.current) return;
    automaticRefreshPending.current = true;
    void enqueue(() => saveAndRefresh(true))
      .catch(() => undefined)
      .finally(() => { automaticRefreshPending.current = false; });
  }

  useEffect(() => {
    mounted.current = true;
    void enqueue(async () => {
      if (initialized.current) return;
      try {
        const existing = await engine.read();
        const exists = Object.keys(existing.files).length > 0 || existing.remoteRevision > 0;
        if (exists) publish(existing);
        else if (args.legacyHasState) {
          const legacy = stateToVaultFiles(stateRef.current, {});
          publish(await engine.edit(legacy, {}));
        }
        initialized.current = true;
        await readFolder();
        // Display durable local files immediately, including when cloud storage is unavailable.
        publish(await engine.read());
        if (mounted.current) { setReady(true); setStorageMode(enabledRef.current ? "fallback" : "local"); }
        void navigator.storage.persist?.().catch(() => false);
        // The old workspace snapshot is migration input only. Future content comes from Markdown.
        localStorage.removeItem(getStateStorageKey(user.id));
        localStorage.removeItem(getStateSavedAtStorageKey(user.id));
        await saveAndRefresh(true);
      } catch (error) {
        report(error);
        if (initialized.current && mounted.current) setReady(true);
      }
    });
    return () => { mounted.current = false; };
  }, [engine, user.id]);

  useEffect(() => {
    if (!ready || args.state === displayedState.current) return;
    setMatchesCloud(false);
    // Queue the local write without a network dependency. Remote uploads are separately debounced.
    void (async () => {
      if (mounted.current) setSaving(true);
      try { await saveAppState(); } catch (error) { report(error); }
      finally { if (mounted.current) setSaving(false); }
    })();
    const timer = window.setTimeout(scheduleAutomaticRefresh, 900);
    return () => window.clearTimeout(timer);
  }, [args.state, ready]);

  useEffect(() => {
    if (!ready) return;
    const refresh = () => {
      if (document.visibilityState === "hidden") return;
      scheduleAutomaticRefresh();
    };
    const flush = () => { void saveAppState().catch(report); };
    const beforeUnload = (event: BeforeUnloadEvent) => {
      if (localInFlight.current || stateRef.current !== displayedState.current) { event.preventDefault(); event.returnValue = ""; }
    };
    const timer = window.setInterval(refresh, 15_000);
    window.addEventListener("online", refresh);
    window.addEventListener("focus", refresh);
    window.addEventListener("pagehide", flush);
    window.addEventListener("beforeunload", beforeUnload);
    document.addEventListener("visibilitychange", refresh);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener("online", refresh);
      window.removeEventListener("focus", refresh);
      window.removeEventListener("pagehide", flush);
      window.removeEventListener("beforeunload", beforeUnload);
      document.removeEventListener("visibilitychange", refresh);
    };
  }, [ready, enabled]);

  return {
    ready, storageMode, matchesCloud, message: localSaveError ?? message, conflicts, saving, localSaveError, localDirectoryStatus,
    async flushLocal() { await saveAppState(); },
    async chooseDirectory() {
      // The chooser must run directly in the user gesture, before asynchronous queue work.
      const status = await chooseLocalDirectory(user.id);
      setDirectoryStatus(status);
      if (status.permission !== "granted") return;
      await enqueue(async () => { folder.current = null; folderCompanions.current = {}; await saveAndRefresh(false); });
    },
    async clearDirectory() {
      await enqueue(async () => { await clearLocalDirectory(user.id); folder.current = null; folderCompanions.current = {}; setDirectoryStatus(await getLocalDirectoryStatus(user.id)); });
    },
    async syncNow(onProgress?: (progress: StateUploadProgress) => void) {
      onProgress?.({ uploadedBytes: 0, totalBytes: 1 });
      await enqueue(() => saveAndRefresh(true));
      onProgress?.({ uploadedBytes: 1, totalBytes: 1 });
    },
    async download() {
      await enqueue(async () => {
        await saveAndRefresh(false);
        await cacheAttachments();
        const snapshot = await engine.read();
        const blob = new Blob([new Uint8Array(exportVault(snapshot)).buffer], { type: "application/zip" });
        const url = URL.createObjectURL(blob);
        const link = document.createElement("a");
        link.href = url; link.download = `margin-chat-vault-${new Date().toISOString().slice(0, 10)}.zip`;
        link.click();
        window.setTimeout(() => URL.revokeObjectURL(url), 60_000);
      });
    },
    async importArchive(file: File) {
      const files = normalizeVaultMarkdownIdentities(importVault(new Uint8Array(await file.arrayBuffer())));
      // Validate content before touching the local vault; import adds/preserves files, never replaces the vault wholesale.
      workspaceFromVault(files);
      await enqueue(async () => {
        await saveAppState();
        const current = await engine.read();
        const expected = Object.fromEntries(Object.entries(current.files).filter(([path, value]) => !files[path] || sameVaultFile(value, files[path])));
        await engine.edit({ ...current.files, ...files }, expected);
        await persistAndPublish();
        await saveAndRefresh(true);
      });
    },
    async resolveConflict(id: string, choice: "local" | "remote" | "current") {
      await enqueue(async () => { await saveAppState(); await engine.resolve(id, choice); await persistAndPublish(); await saveAndRefresh(true); });
    },
  };
}
