# Desktop vault sync: design note

The desktop app is Margin Chat's main surface, and its vault is a folder on the
computer. This note records the Phase 0 audit for the desktop-first spec
(2026-11-05, revision 2): where the vault engine lives today, what the desktop
app changes, and what it keeps. It builds on [markdown-vault.md](markdown-vault.md),
which remains the contract for file formats, merge semantics, trash, history
and cloud sync.

## What the audit found

The vault code already splits into three layers, and only the bottom one is
tied to the browser.

1. **The engine** — `client/src/lib/vaultSync.ts` (`VaultSync`), `vaultMerge.ts`,
   `vaultMergeAnchors.ts`, `vaultTrash.ts`, `vaultRecovery.ts`, `vaultWorkspace.ts`,
   `folderDeletionGuard.ts`, and the codec in `packages/workspace-contracts`. It
   works on two interfaces, `VaultStore` (this device's durable copy, with a
   lock) and `VaultTransport` (the cloud), uses only `crypto`, `TextEncoder` and
   plain data, and the server's own tests already drive it from Node
   (`tests/vault-sync.test.ts`). **Nothing here changes.**
2. **The folder logic** — `client/src/lib/workspaceStorage.ts` (scan, write,
   companions, listings, signature), `desktopVault.ts` (preview, new-vault
   folder) and `fileSnapshot.ts` (fresh-snapshot retries). All of it is written
   against the browser's *directory handle* shape, duck-typed: the existing
   tests run it on in-memory fakes. `vaultLocal.ts`'s journal store
   (`createBrowserVaultStore`) is written against the same shape, over OPFS.
3. **The platform** — `workspaceStorage.ts`'s handle storage (IndexedDB),
   permission queries, the directory picker, `FileSystemObserver`/polling
   watch, and the OPFS root. This is the only browser-specific part, and the
   one that fails on desktop: permission fragility, no real recursive watch, no
   sync while the renderer is away.

The orchestration (`useMarkdownVault.ts`: `readFolder`, `writeFolder`,
`folderBaseline`, the deletion-guard hold, baselines keyed by directory id) is a
React hook today. It is platform-neutral in what it does, and is the piece the
main process must own on desktop (Phase 3).

## The decision: one interface, two adapters, no rewrite

`packages/vault-sync/vaultFs.ts` names the directory-handle subset the folder
logic uses: `VaultDirectory`, `VaultFileHandle`, `VaultFileSnapshot`,
`VaultWritable`, with DOM error names. A `FileSystemDirectoryHandle` satisfies
it as it is, so **web and mobile keep their adapter without a line changing**.
`packages/vault-sync/nodeVaultFs.ts` is the native adapter. The conformance
test (`tests/vault-sync-node-fs.test.ts`) runs the unchanged browser folder code
against a real temporary folder through it.

This is the smallest extraction that gives the spec's "one engine, three
filesystem adapters": the engine was already separable, the folder logic
needed only a name for its interface, and the browser-specific layer is what
desktop replaces. Moving the twenty engine files out of `client/src/lib` would
be churn without value at this stage; the package is the platform boundary,
and documents that the engine's home stays where the server tests already find
it.

### What the native adapter adds

- **Atomic writes**: temp file beside the target, fsync, rename over it; a
  crash leaves the old file or the new one, never a mix. On macOS the old
  file is cloned first (`copyFile` uses `copyfile(3)`), so Finder tags and
  comments survive. On Windows the rename is retried while another program
  holds the file, then surfaces as `TargetBusyError` for the sync loop to
  queue.
- **No symlink escapes**: links are invisible, so nothing the vault does can
  read or write outside its folder.
- **Snapshots that notice change**: like Chromium, a read after the file
  changed rejects with `InvalidStateError`, so half-copied files are never
  taken as whole and the existing retry (`readFreshFile`) keeps working.
- **A real path** for Reveal in Finder, Open vault folder and the watcher.

### Watching (decision recorded)

`fs.watch(recursive)` from Node, no library; the rationale and the Linux
new-folder mitigation are in `packages/vault-sync/README.md`. The watcher
(`folderWatcher.ts`) debounces per path, checks stability twice (size, date,
hash, and the file opening), skips the ignore list, drops the app's own writes
by hash, and reports *paths*. Classification stays with the scan, which already
handles every row of the spec's table (external edit by identity, unknown
identity import, plain drop-in, companions, renames, deletes, the deletion
guard) for the browser's connected folder.

## Renderer assumptions the desktop path unwinds (inventory for Phase 1 and 3)

- `getStoredDirectorySelection` / `setStoredDirectorySelection` keep handles in
  IndexedDB and ids per handle. Desktop keeps a path list in the shell's
  settings instead; the directory id (which keys baselines) becomes the vault
  identity (`workspace.json` id, filesystem identity as tiebreaker).
- `queryDirectoryPermission` / `requestLocalDirectoryPermission` / the `allow`
  prompt: no permission exists on desktop; the bridge answers `granted`.
- `pickLocalDirectory` and `createVault`'s parent picker: native dialogs in the
  main process.
- `watchLocalDirectory` (observer or polling signature): the main process
  watcher drives scans; the renderer loop is off when the bridge is present.
- `createBrowserVaultStore` opens `navigator.storage.getDirectory()`: the same
  store runs over the node adapter in `userData` when given that root (Phase 3).
- `readLocalDirectoryFile` wraps a `File` in a `Blob` for too-large local
  files: the bridge returns real bytes for that call.
- `supportsDirectoryPicker` requires `window.top === window` and
  `indexedDB`; desktop reports support when the bridge is present.

Everything else in the renderer is independent of where the folder lives.

## Phases, as landed

- **Phase 0 (this note)**: interface, native adapter, watcher decision, tests.
  No behaviour change anywhere.
- **Phase 2 library**: watcher, stability, ignore list, echo suppression and
  atomic writes landed with Phase 0 as pure library code with tests, because
  the native adapter needs the write discipline from its first use.
- **Phase 1 (landed)**: preload bridge exposing `VaultDirectory` over IPC with a
  protocol version (`bridgeProtocol.ts`, `bridgeService.ts`,
  `bridgeDirectory.ts`, `desktop/preload.cjs`, `desktop/vaultBridge.mjs`);
  native folder choice and zero-click reopen; the client takes the native path
  by runtime detection of the bridge. Behind `nativeVault` in the shell's
  settings, default off.
- **Phase 3 (landed)**: `desktopVaultService.ts` runs the engine, the journal
  store (`createJournalVaultStore` over the node adapter in `userData/vaults`),
  the folder mirror (`client/src/lib/vaultFolderMirror.ts`, extracted from the
  hook and shared with the web) and the loop in the main process; the page
  uses `BridgeVaultEngine` and shows the reported status. The live-buffer rule
  of §4.4 is met by the existing save-then-publish discipline: the page saves
  its edits (an engine `edit` with the files it displayed as the expected
  base, merged three-way in the main process) before it publishes a new
  snapshot, so a cloud pull never replaces unsaved typing and no reload prompt
  exists.
- **Phase 4 (partly landed)**: Open Vault Folder and Reveal in Finder in the
  File menu; the sync indicator and Vault settings → Sync; this documentation.
  The dismissible desktop-web notice already existed (`DesktopAppPrompt`).
  OS drag-and-drop into the workspace already lands through the upload path.

## Known costs and follow-ups

- Engine calls cross IPC with whole snapshots (every file's content). Fine for
  vaults of a few thousand notes; a delta protocol is the follow-up if large
  vaults make saves sluggish.
- The vault id inside `workspace.json` (§4.5) is a manifest change and is left
  for review; folder identity today is the remembered path or its device and
  inode.
- Acceptance tests 2 (partial writes), 5 (kill during write) and 8 (Obsidian
  interop) are covered at the library level (watcher stability, atomic
  replacement, three-way merge) and still need their end-to-end Electron runs
  under Playwright before the default flips.

See the spec for the acceptance tests each phase must pass.
