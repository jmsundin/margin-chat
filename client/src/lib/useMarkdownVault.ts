import { apiFetch } from "./apiTransport";
import { isAppUpdateLocked, useAppUpdateGuard } from "./appUpdateSafety";
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type Dispatch, type SetStateAction } from "react";
import type { AppState, AuthenticatedUser } from "../types";
import type { StateUploadProgress } from "./api";
import { getStateSavedAtStorageKey, getStateStorageKey, loadLastFocusedDocument, saveLastFocusedDocument } from "./appState";
import { createVaultTransport } from "./vaultApi";
import { bytesToBase64, createBrowserVaultStore, exportVault, importVault } from "./vaultLocal";
import { VaultSync, pendingVaultChanges } from "./vaultSync";
import { type VaultDownloadProgress, type VaultEntry, type VaultFile, type VaultManifest, type VaultIndex, type VaultIndexEntry, type VaultSnapshot, type VaultConflict } from "./vaultTypes";
import { preserveDeferredWorkspaceReferences, recentVaultEntries, vaultHydrationClosure } from "./vaultHydration";
import { createVaultFileRenderer, hasSameAuthoredState, normalizeVaultMarkdownIdentities, stateToVaultFiles, vaultToState, workspaceFromVault, workspaceVaultFiles } from "./vaultWorkspace";
import {
  canSyncWorkspaceToCloud, pickLocalDirectory, connectLocalDirectory, requestLocalDirectoryPermission, clearLocalDirectory, getLocalDirectoryStatus,
  getLocalWorkspaceFileName, readLocalDirectoryWorkspace, writeLocalDirectoryWorkspace,
  readLocalDirectoryCompanions, syncLocalDirectoryCompanions,
  type LocalDirectoryStatus,
} from "./workspaceStorage";
import type { MarkdownWorkspace } from "./workspaceMarkdown";
import { historyVaultFiles, type HistoryChat, type HistoryImportReceipt } from "./chatHistoryImport";

type StorageMode = "loading" | "fallback" | "local" | "server";

/** How many recently used documents a new device downloads before anything else. */
const RECENT_DOCUMENT_COUNT = 12;
/** Families downloading at once while recent documents stream in. */
const STREAM_WIDTH = 3;

export interface VaultFetchStatus {
  label: string;
}

export function useMarkdownVault(args: {
  user: AuthenticatedUser;
  storageUserId?: string;
  state: AppState;
  setState: Dispatch<SetStateAction<AppState>>;
  legacyHasState: boolean;
}) {
  const { user, setState } = args;
  const storageUserId = args.storageUserId ?? user.id;
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
    directoryName: null, fileName: getLocalWorkspaceFileName(storageUserId), permission: "unselected", supported: false,
  });
  const projectionPending = useRef(false);
  const [vaultIndex, setVaultIndex] = useState<VaultIndex | null>(null);
  const vaultIndexRef = useRef<VaultIndex | null>(null);
  const [deferredPaths, setDeferredPaths] = useState<ReadonlySet<string>>(() => new Set());
  const deferredIds = useRef<Set<string>>(new Set());
  const [downloadProgress, setDownloadProgress] = useState<VaultDownloadProgress | null>(null);
  const [preparing, setPreparing] = useState(false);
  const [streamingPaths, setStreamingPaths] = useState<ReadonlySet<string>>(() => new Set());
  const [arrivingIds, setArrivingIds] = useState<ReadonlySet<string>>(() => new Set());
  const [openingPath, setOpeningPath] = useState<string | null>(null);
  const engineRef = useRef<VaultSync | null>(null);
  if (!engineRef.current) engineRef.current = new VaultSync(createBrowserVaultStore(storageUserId), createVaultTransport(user.id, (status) => {
    projectionPending.current = status === "pending";
  }));
  const engine = engineRef.current;
  engine.onDownload = (progress) => {
    if (mounted.current) setDownloadProgress(progress.total ? progress : null);
  };
  const displayedFiles = useRef<Record<string, VaultFile>>({});
  const displayedState = useRef(args.state);
  const [initialFocus] = useState(() => loadLastFocusedDocument(storageUserId));
  const pendingFocus = useRef(initialFocus);
  const [renderFiles] = useState(createVaultFileRenderer);
  const folder = useRef<MarkdownWorkspace | null>(null);
  const folderId = useRef<string | null>(null);
  const folderCompanions = useRef<Record<string, VaultFile>>({});
  const mounted = useRef(true);
  const queue = useRef(Promise.resolve());
  const localInFlight = useRef<Promise<VaultSnapshot> | null>(null);
  const automaticRefreshPending = useRef(false);
  const initialized = useRef(false);
  const hasVaultContent = useRef(false);
  const writing = useRef(false);

  useAppUpdateGuard("vault", {
    check: () => !ready ? "A workspace is still loading. Wait a moment and try again." : null,
    canReload: () => stateRef.current === displayedState.current && !localInFlight.current && !writing.current,
    flush: async () => {
      await queue.current;
      await saveAppState();
    },
  });

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

  function rememberDeferred(snapshot: VaultSnapshot) {
    const deferred = snapshot.deferred ?? {};
    deferredIds.current = new Set(Object.values(deferred).flatMap((entry) => entry.id ? [entry.id] : []));
    if (!mounted.current) return;
    setDeferredPaths((current) => {
      const paths = Object.keys(deferred);
      return paths.length === current.size && paths.every((path) => current.has(path)) ? current : new Set(paths);
    });
  }

  function publish(snapshot: VaultSnapshot) {
    rememberDeferred(snapshot);
    const next = vaultToState(snapshot.files, stateRef.current, pendingFocus.current);
    if (pendingFocus.current === next.activeConversationId) pendingFocus.current = null;
    // Saved files are never changed in place, so the displayed set can share them.
    displayedFiles.current = { ...snapshot.files };
    displayedState.current = next;
    hasVaultContent.current = workspaceFromVault(snapshot.files).manifest.files.length > 0;
    stateRef.current = next;
    if (!mounted.current) return;
    if (!pendingFocus.current) saveLastFocusedDocument(storageUserId, next.activeConversationId);
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
    if (hasSameAuthoredState(stateRef.current, displayedState.current)) {
      displayedState.current = stateRef.current;
      return engine.read();
    }
    // Keep settings durable without turning the empty editor into a document,
    // including after the last authored document was deleted on another device.
    const conversations = Object.values(stateRef.current.conversations);
    const pristine = conversations.length === 1 && conversations[0].kind !== "note" && conversations[0].title === "New chat"
      && !conversations[0].messages.length && !conversations[0].notes?.length && !conversations[0].documents?.length
      && !conversations[0].document?.blocks.some((block) => block.content.trim());
    const editingState = stateRef.current;
    const settingsOnly = !hasVaultContent.current && pristine;
    let next = renderFiles(settingsOnly ? { ...editingState, conversations: {} } : editingState, displayedFiles.current);
    if (deferredIds.current.size && next["workspace.json"]) {
      const sidecar = preserveDeferredWorkspaceReferences(next["workspace.json"], displayedFiles.current["workspace.json"], deferredIds.current);
      if (sidecar !== next["workspace.json"]) next = { ...next, "workspace.json": sidecar };
    }
    const snapshot = await engine.edit(next, displayedFiles.current);
    displayedFiles.current = next;
    displayedState.current = editingState;
    hasVaultContent.current = !settingsOnly;
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
    const status = await getLocalDirectoryStatus(storageUserId);
    if (mounted.current) setDirectoryStatus(status);
    if (status.permission !== "granted" || !status.directoryId) {
      folderId.current = null; folder.current = null; folderCompanions.current = {};
      return;
    }
    if (folderId.current !== status.directoryId) {
      const baseline = (await engine.read()).directoryBaselines?.[status.directoryId];
      folder.current = baseline ? {
        manifest: baseline.manifest,
        files: Object.fromEntries(Object.entries(baseline.files)
          .filter(([path, file]) => /\.md$/i.test(path) && !/^(?:attachments|_conflicts|\.margin-chat)\//i.test(path) && !file.encoding)
          .map(([path, file]) => [path, file.content])),
      } : null;
      folderCompanions.current = baseline ? Object.fromEntries(Object.entries(baseline.files)
        .filter(([path]) => path === "workspace.json" || /^(?:attachments|_conflicts|\.margin-chat)\//i.test(path))) : {};
      folderId.current = status.directoryId;
    }
    const incoming = await readLocalDirectoryWorkspace(storageUserId, folder.current?.manifest, folder.current?.files, status.directoryId);
    if (!incoming) return;
    const companions = await readLocalDirectoryCompanions(storageUserId, folderCompanions.current, status.directoryId);
    if (!companions) return;
    // Settings are parsed/canonicalized with Markdown; preserve raw companion bytes for disk checks.
    const withoutSettings = (files: Record<string, VaultFile>) => Object.fromEntries(Object.entries(files).filter(([path]) => path !== "workspace.json"));
    // A new plain file without a date takes its time on disk, so it lists with recent documents
    // instead of as the oldest one. Both sides use the same dates so unchanged files never look edited.
    const dates = incoming.modifiedAt;
    const next = { ...workspaceVaultFiles(incoming.workspace, true, dates), ...withoutSettings(companions) };
    const expected = { ...(folder.current ? workspaceVaultFiles(folder.current, true, dates) : {}), ...withoutSettings(folderCompanions.current) };
    const baseline = folderBaseline(incoming.workspace, companions);
    const directory = { id: status.directoryId, baseline };
    // An empty newly chosen directory is an output destination, not deletion of the vault.
    if (folder.current) await engine.edit(next, expected, directory);
    else if (Object.keys(incoming.workspace.files).length || Object.keys(companions).length) await engine.import(next, directory);
    else await engine.rememberDirectory(directory.id, baseline);
    folder.current = incoming.workspace;
    folderCompanions.current = companions;
  }

  function folderBaseline(workspace: MarkdownWorkspace, companions: Record<string, VaultFile>) {
    return { manifest: workspace.manifest, files: {
      ...Object.fromEntries(Object.entries(workspace.files)
        .filter(([path]) => !/^(?:attachments|_conflicts|\.margin-chat)\//i.test(path))
        .map(([path, content]) => [path, { content, contentType: "text/markdown; charset=utf-8" }])),
      ...companions,
    } };
  }

  async function writeFolder(snapshot: VaultSnapshot) {
    if (!folder.current || !folderId.current) return;
    const workspace = workspaceFromVault(snapshot.files, folder.current);
    const status = await writeLocalDirectoryWorkspace(storageUserId, workspace, folder.current, folderId.current);
    if (status.permission !== "granted") return;
    const companions = await syncLocalDirectoryCompanions(storageUserId, snapshot.files, folderCompanions.current, folderId.current);
    if (!companions) return;
    await engine.rememberDirectory(folderId.current, folderBaseline(workspace, companions));
    folder.current = workspace;
    folderCompanions.current = companions;
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
      const metadataResponse = await apiFetch(`${url}?metadata=1`, { credentials: "same-origin", headers: { "X-Margin-Vault-User": user.id }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
      if (!metadataResponse.ok) throw new Error(`Connect to download the original attachment “${document.filename}” before exporting the complete vault.`);
      const { attachment } = await metadataResponse.json();
      const response = await apiFetch(url, { credentials: "same-origin", headers: { "X-Margin-Vault-User": user.id }, cache: "no-store", signal: AbortSignal.timeout(15_000) });
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

  function setIndex(index: VaultIndex | null) {
    vaultIndexRef.current = index;
    if (mounted.current) setVaultIndex(index);
  }

  /** Keep the cloud index current while some documents are only in the cloud. */
  async function refreshIndex(snapshot: VaultSnapshot) {
    if (!snapshot.deferred || !engine.transport.index) return;
    if (vaultIndexRef.current && vaultIndexRef.current.revision >= snapshot.remoteRevision) return;
    try { setIndex(await engine.transport.index()); }
    catch { /* The documents already on this device stay usable; the index retries on the next sync. */ }
  }

  /**
   * A device without a local vault leaves its documents in the cloud and then
   * streams the most recently used ones in, newest first, each usable the
   * moment it lands. Without an index (an older server, or offline) the whole
   * vault downloads as before.
   */
  async function prepareFreshDevice(): Promise<{ manifest: VaultManifest; families: string[][]; focusId: string | null } | null> {
    if (!engine.transport.index) return null;
    if (mounted.current) setPreparing(true);
    try {
      const [manifest, index] = await Promise.all([engine.transport.manifest(), engine.transport.index().catch(() => null)]);
      if (!index?.entries.length) return null;
      const focused = initialFocus ? index.entries.find((entry) => entry.id === initialFocus) : undefined;
      const recent = recentVaultEntries(index.entries, RECENT_DOCUMENT_COUNT);
      // Each family (a document with its branches, notes and linked documents) arrives as one unit.
      const families: string[][] = [];
      const planned = new Set<string>();
      for (const entry of focused ? [focused, ...recent] : recent) {
        if (planned.has(entry.path)) continue;
        const family = [...vaultHydrationClosure(index.entries, [entry.path])].filter((path) => !planned.has(path));
        for (const path of family) planned.add(path);
        if (family.length) families.push(family);
      }
      if (!await engine.deferFresh(manifest, new Set(), new Map(index.entries.map((entry) => [entry.path, entry.id])))) return null;
      setIndex(index);
      rememberDeferred(await engine.read());
      return { manifest, families, focusId: (focused ?? recent[0])?.id ?? null };
    } catch {
      // Fall back to downloading everything; the regular sync reports any network failure.
      return null;
    } finally {
      if (mounted.current) setPreparing(false);
    }
  }

  /** Publish each family as soon as it is saved on this device, most recent first. */
  async function streamRecentDocuments(plan: { manifest: VaultManifest; families: string[][]; focusId: string | null }) {
    const units: string[][] = [["workspace.json"], ...plan.families];
    if (mounted.current) setStreamingPaths(new Set(plan.families.flat()));
    // Open the most recent document as soon as it arrives, unless the user picks another first.
    if (plan.focusId && !pendingFocus.current) pendingFocus.current = plan.focusId;
    const byPath = new Map((vaultIndexRef.current?.entries ?? []).map((entry) => [entry.path, entry]));
    let publishing = Promise.resolve();
    let next = 0;
    await Promise.all(Array.from({ length: Math.min(STREAM_WIDTH, units.length) }, async () => {
      while (next < units.length) {
        const unit = units[next++];
        try {
          const entries = unit.flatMap((path) => plan.manifest.files[path] ? [[path, plan.manifest.files[path]] as [string, VaultEntry]] : []);
          if (await engine.pull(entries)) {
            // Publishing one at a time keeps a later arrival from being replaced by an earlier read.
            publishing = publishing.then(async () => {
              await persistAndPublish();
              const arrived = unit.flatMap((path) => byPath.get(path)?.type === "conversation" ? [byPath.get(path)!.id] : []);
              if (arrived.length && mounted.current) {
                setArrivingIds((current) => new Set([...current, ...arrived]));
                window.setTimeout(() => {
                  if (mounted.current) setArrivingIds((current) => new Set([...current].filter((id) => !arrived.includes(id))));
                }, 1600);
              }
            });
            await publishing;
          }
        } catch {
          // A document that cannot arrive now stays listed in the cloud index and opens on demand.
        } finally {
          if (mounted.current) setStreamingPaths((current) => new Set([...current].filter((path) => !unit.includes(path))));
        }
      }
    }));
    await publishing;
  }

  /** Download deferred documents (with their families) and return whether any were requested. */
  async function hydratePaths(paths: Iterable<string>) {
    const snapshot = await engine.read();
    if (!snapshot.deferred) return false;
    const entries = vaultIndexRef.current?.entries ?? [];
    const closure = entries.length ? vaultHydrationClosure(entries, paths) : new Set(paths);
    const requested = [...closure].filter((path) => snapshot.deferred?.[path]);
    if (!requested.length) return false;
    await engine.hydrate(requested);
    return true;
  }

  /** A document that arrived on its own (created or renamed on another device) brings its family. */
  async function hydrateIncompleteFamilies() {
    const snapshot = await engine.read();
    const entries = vaultIndexRef.current?.entries;
    if (!snapshot.deferred || !entries) return false;
    return hydratePaths(entries.filter((entry) => snapshot.files[entry.path]).map((entry) => entry.path));
  }

  /** Documents open in panes or pinned on another device should be ready here too. */
  async function hydrateWorkspaceReferences() {
    const snapshot = await engine.read();
    const sidecar = snapshot.files["workspace.json"];
    const entries = vaultIndexRef.current?.entries;
    if (!snapshot.deferred || !sidecar || sidecar.encoding || !entries) return false;
    const ids = new Set<string>();
    try {
      const view = JSON.parse(sidecar.content)?.workspace?.view;
      for (const id of Array.isArray(view?.pinnedItemIds) ? view.pinnedItemIds : []) if (typeof id === "string") ids.add(id);
      const panes = view?.documentDock?.tree ? [view.documentDock.tree] : [];
      while (panes.length) {
        const pane = panes.pop();
        if (pane?.type === "pane" && typeof pane.documentId === "string") ids.add(pane.documentId);
        else if (pane?.type === "split") panes.push(pane.first, pane.second);
      }
    } catch { return false; }
    return hydratePaths(entries.filter((entry) => ids.has(entry.id)).map((entry) => entry.path));
  }

  /** Exports and folder copies must contain the complete vault. */
  async function hydrateEverything() {
    const snapshot = await engine.read();
    if (!snapshot.deferred) return;
    if (!enabledRef.current) throw new Error("Connect to cloud sync to download the rest of your vault first.");
    await engine.hydrate(Object.keys(snapshot.deferred));
    await saveAndRefresh(true);
    if ((await engine.read()).deferred) throw new Error("Some documents are still in the cloud. Connect and try again.");
  }

  async function saveAndRefresh(sync: boolean) {
    if (!initialized.current) return;
    writing.current = true;
    if (mounted.current) setSaving(true);
    try {
      await saveAppState();
      await readFolder();
      if (sync && enabledRef.current) {
        await refreshIndex(await engine.sync());
        if (await hydrateIncompleteFamilies()) await engine.sync();
        if (mounted.current) {
          setStorageMode("server");
          setMessage(projectionPending.current
            ? "Your files are saved in the cloud. Search and attachment features are still updating; sync will retry automatically."
            : null);
        }
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
    if (isAppUpdateLocked()) return;
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
        localStorage.removeItem(getStateStorageKey(storageUserId));
        localStorage.removeItem(getStateSavedAtStorageKey(storageUserId));
        const stream = !exists && !args.legacyHasState && enabledRef.current ? await prepareFreshDevice() : null;
        if (stream) await streamRecentDocuments(stream);
        await saveAndRefresh(true);
        if (await hydrateWorkspaceReferences()) await saveAndRefresh(true);
      } catch (error) {
        report(error);
        if (initialized.current && mounted.current) setReady(true);
      }
    });
    return () => { mounted.current = false; };
  }, [engine, storageUserId]);

  useLayoutEffect(() => {
    if (!ready) return;
    // Keep the startup preference while its document is still arriving from the
    // cloud. A new selection takes precedence over that pending restoration.
    if (args.state.activeConversationId !== displayedState.current.activeConversationId) pendingFocus.current = null;
    if (!pendingFocus.current) saveLastFocusedDocument(storageUserId, args.state.activeConversationId);
  }, [args.state.activeConversationId, ready, storageUserId]);

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

  const cloudDocuments = useMemo(() => !vaultIndex || !deferredPaths.size ? []
    : recentVaultEntries(vaultIndex.entries.filter((entry) => deferredPaths.has(entry.path))), [vaultIndex, deferredPaths]);
  const openingTitle = openingPath ? vaultIndex?.entries.find((entry) => entry.path === openingPath)?.title : null;
  const fetchStatus: VaultFetchStatus | null = preparing ? { label: "Finding your recent documents…" }
    : streamingPaths.size ? { label: "Bringing in your recent documents…" }
    : openingPath ? { label: `Opening “${openingTitle ?? "document"}”…` }
    : downloadProgress ? { label: "Syncing documents…" }
    : null;

  const folderAccessMessage = localDirectoryStatus.directoryName && localDirectoryStatus.permission !== "granted"
    ? `Allow access to “${localDirectoryStatus.directoryName}” again so Margin Chat can see the files you add or change there.`
    : null;

  return {
    ready, storageMode, folderAccessMessage, cloudDocuments, fetchStatus, openingPath, streamingPaths, arrivingIds,
    /** Download a document that is still only in the cloud, then show it. */
    async openCloudDocument(path: string) {
      const entry = vaultIndexRef.current?.entries.find((candidate) => candidate.path === path);
      if (!entry) return;
      // A margin note opens with the document it annotates.
      const focusId = entry.type === "note" && entry.parentPath
        ? vaultIndexRef.current?.entries.find((candidate) => candidate.path === entry.parentPath)?.id ?? entry.id : entry.id;
      setOpeningPath(path);
      try {
        await enqueue(async () => {
          if (!mounted.current) return;
          await hydratePaths([path]);
          pendingFocus.current = focusId;
          await saveAndRefresh(true);
        });
      } finally {
        if (mounted.current) setOpeningPath((current) => current === path ? null : current);
      }
    }, matchesCloud, message: localSaveError ?? message, conflicts, saving, localSaveError, localDirectoryStatus,
    async flushLocal() { await saveAppState(); },
    async chooseDirectory() {
      // The chooser must run directly in the user gesture, before asynchronous queue work.
      const handle = await pickLocalDirectory();
      if (!handle) return;
      await enqueue(async () => {
        await hydrateEverything();
        const status = await connectLocalDirectory(storageUserId, handle);
        setDirectoryStatus(status);
        folderId.current = null; folder.current = null; folderCompanions.current = {};
        if (status.permission === "granted") await saveAndRefresh(false);
      });
    },
    /** Allow a remembered folder again after the browser forgot its access. */
    async allowDirectoryAccess() {
      // The permission prompt needs the user's click, so it runs before queued folder work.
      const status = await requestLocalDirectoryPermission(storageUserId);
      if (mounted.current) setDirectoryStatus(status);
      if (status.permission === "granted") await enqueue(() => saveAndRefresh(true));
    },
    async clearDirectory() {
      await enqueue(async () => { await clearLocalDirectory(storageUserId); folderId.current = null; folder.current = null; folderCompanions.current = {}; setDirectoryStatus(await getLocalDirectoryStatus(storageUserId)); });
    },
    async syncNow(onProgress?: (progress: StateUploadProgress) => void) {
      onProgress?.({ uploadedBytes: 0, totalBytes: 1 });
      await enqueue(() => saveAndRefresh(true));
      onProgress?.({ uploadedBytes: 1, totalBytes: 1 });
    },
    async download() {
      await enqueue(async () => {
        await saveAndRefresh(false);
        await hydrateEverything();
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
        await engine.import(files);
        await persistAndPublish();
        await saveAndRefresh(true);
      });
    },
    async importChatHistory(chats: HistoryChat[]) {
      return enqueue(async () => {
        if (!initialized.current || !mounted.current) throw new Error("Wait for your workspace to open before importing.");
        // Imports skip chats already in the vault, so every document must be known first.
        await hydrateEverything();
        await saveAppState();
        if (!mounted.current) throw new Error("Your account changed. Reopen the import in your current account.");
        const receipt = await engine.importChatHistory(historyVaultFiles(chats, stateRef.current));
        await persistAndPublish();
        scheduleAutomaticRefresh();
        return receipt;
      });
    },
    async undoChatHistory(receipt: HistoryImportReceipt) {
      return enqueue(async () => {
        await saveAppState();
        if (!mounted.current) throw new Error("Your account changed. Reopen your current workspace.");
        const result = await engine.undoChatHistory(receipt);
        await persistAndPublish();
        scheduleAutomaticRefresh();
        return result;
      });
    },
    async resolveConflict(id: string, choice: "local" | "remote" | "current") {
      await enqueue(async () => { await saveAppState(); await engine.resolve(id, choice); await persistAndPublish(); await saveAndRefresh(true); });
    },
  };
}
