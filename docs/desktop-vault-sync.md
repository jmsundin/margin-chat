# Desktop vault sync: phase 0 audit

Design note for the spec "Margin Chat — Desktop-First + Seamless Local/Cloud Vault Sync" (2026-11-04). Phase 0 changes no behaviour: it maps the code the later phases move, adds the `VaultFs` folder interface in `packages/vault-sync/`, and runs the existing browser folder code through it. [Markdown vault](markdown-vault.md) stays the contract for formats, merge and sync.

## Where the code lives today

| Concern | Where | Notes |
|---|---|---|
| Markdown codec, paths, relations, frontmatter | `packages/workspace-contracts` | Canonical, plain `.mjs`. Unchanged. |
| Sync engine: pending changes, pull/push, conditional commits, rename pairs, tombstones, trash, recovery | `client/src/lib/vaultSync.ts` (`VaultSync`, `applyVaultEdits`, `pendingVaultChanges`), `vaultTrash.ts`, `vaultRecovery.ts` | Has no DOM or browser storage dependency. `bun build --target=node` bundles it with its imports (about 0.33 MB) and it loads in Node. |
| Three-way merge | `client/src/lib/vaultMerge.ts` (`mergeVaultFile`), `vaultMergeAnchors.ts` | Called by the engine; not touched. |
| Vault ↔ workspace mapping | `client/src/lib/vaultWorkspace.ts`, `workspaceMarkdown.ts` (re-exports the codec) | Pulls in some client modules (`appState`, `services`, `documentMedia`), all DOM-free. |
| Cloud transport (`/api/vault/*`) | `client/src/lib/vaultApi.ts` (`createVaultTransport`) via `apiTransport.ts` | Uses relative `fetch`. In the desktop app those requests already go through the main process (`forwardToBackend`). |
| Device copy of the vault (durable journal + checkpoint, base revisions, folder baselines) | `client/src/lib/vaultLocal.ts` (`createBrowserVaultStore`) in OPFS, behind the `VaultStore` interface in `vaultTypes.ts` | A full second copy of every file today, desktop included. |
| Folder scan, stability of reads, write discipline, companions | `client/src/lib/workspaceStorage.ts`, `fileSnapshot.ts` | Now runs on `VaultFs` (this phase). |
| Folder reconcile loop (read folder → deletion guard → `engine.edit`/`import` → write folder) | `useMarkdownVault.ts` (`readFolder`, `writeFolder`, `checkFolderAccess`) | Inside the React hook, not a library. |
| Deletion guard | `client/src/lib/folderDeletionGuard.ts` | Pure function; reusable as is. |
| Folder watching | `workspaceStorage.ts` (`watchLocalDirectory`) | Browser folder observer when present, otherwise a signature poll every 2.5–60 s while the page is visible. |
| First-run folder choice | `components/VaultFolderGate.tsx`, `lib/desktopVault.ts` | Uses the browser directory picker and folder handles. |
| Keeping folder access across launches | `desktop/permissions.mjs` | Answers Chromium's permission check for `margin://app`. |

## The VaultFs interface

`packages/vault-sync/index.d.mts` defines what the vault engine needs from a folder: `list` (one level), `stat`, `read` (bytes plus the stat of the same snapshot), `writeAtomic`, `move`, `delete`, `availability` (missing is never empty) and an optional `watch`. Errors use DOMException-style names (`NotFoundError`, `NotAllowedError`, …) so callers treat every adapter alike, and every path is checked to stay inside the folder.

Adapters:

- `fsAccessVaultFs` (`client/src/lib/vaultFsAccess.ts`): the browser folder handle, as used today. It keeps handles found while listing, so a scan costs no extra lookups, and reads through `fileSnapshot.ts` as before.
- `createMemoryVaultFs` (`packages/vault-sync`): reference behaviour and test double.
- Phase 1 adds a `node:fs` adapter for the desktop main process. `tests/helpers/vaultFsConformance.ts` is the shared suite every adapter must pass.

`workspaceStorage.ts`'s exported folder functions accept either a folder handle or a `VaultFs`, so the same scan and write code (including the "changed again while saving" checks and companions-before-Markdown order) runs on a native folder unchanged. `tests/vault-fs.test.ts` runs it on the in-memory folder.

## Watcher choice: `fs.watch`, events as hints

Decision: the desktop main process uses `node:fs.watch` directly, not chokidar.

- macOS and Windows: `fs.watch(root, { recursive: true })`, which uses the system's own recursive watcher (FSEvents, ReadDirectoryChangesW).
- Linux: one non-recursive `fs.watch` per folder, added and removed as folders appear. Node's recursive mode on Linux is a JavaScript layer over inotify and has had crash bugs as recently as October 2026 (nodejs/node#66791: an unreadable subfolder throws an uncaught EACCES).
- Every event only says "look here". Within the debounce window the watcher stats the files under that folder and keeps the stability check (size and time unchanged across two checks and the file opens). So a missed, merged or duplicate event cannot change the result. A slow full scan on launch, focus, wake and every few minutes catches anything the system dropped, such as an inotify overflow or a folder on a network drive.

Why not chokidar: the desktop app ships without `node_modules` (`desktop/package.json` `files`), so any dependency must be bundled into the main process. Version 6, the first with a native recursive backend, came out in October 2026 as a full rewrite. Version 5 watches folder by folder on every platform. Both bring the stability checks we would write anyway, and we would still re-read files ourselves before ingesting. The pieces we need are a small, well-tested module of our own on top of `fs.watch`. If Linux watching proves unreliable in practice, chokidar's `polling` backend is the fallback to bundle.

## What the renderer assumes that desktop must unwind

1. The folder is a `FileSystemDirectoryHandle` stored in IndexedDB (`workspaceStorage.ts` `getStoredDirectorySelection`), with `queryPermission`/`requestPermission`, the directory picker, and the "Allow access" button.
2. `VaultFolderGate.tsx` and `desktopVault.ts` (`previewLocalDirectory`, `createVaultFolder`) walk and create folders through handles. Phase 1 gives them native dialog and preview calls over IPC.
3. The device copy (`VaultStore`) is in OPFS. While a folder is connected the folder and the cloud hold the bytes, but OPFS holds a full third copy plus base revisions. Phase 3 moves the store to the app's `userData`. Its journal format is written against folder handles, so it can move onto `VaultFs` with the `node:fs` adapter instead of being rewritten.
4. Sync runs in the page: the reconcile loop is in `useMarkdownVault.ts`, and watching stops while the page is hidden. Phase 3 lifts `readFolder`/`writeFolder` out of the hook into a plain module that the main process can run, with web behaviour unchanged.
5. `fileSnapshot.ts`'s stale-snapshot retries (and the worker that reads OPFS directly) are browser-only. The `node:fs` adapter doesn't need them.

## Where the spec doesn't fit the code

- **The sync core is not separable as a package without moving about 5,000 lines of client TypeScript.** The spec's `packages/vault-sync/` holds the interface and adapters. For the engine, the smallest step is to bundle the existing client modules into the desktop main process at build time (`bun build --target=node`, which already works) rather than move or rewrite them. The merge stays where it is, and web and desktop run the same source.
- **The client updates separately from the desktop shell** (`desktop/clientBundles.mjs` downloads the newest client from the website). A new client can run in an old shell, and an old client in a new shell. So the native path is used only when the shell's preload bridge is present, and the browser folder path stays in the client for older shells. The "desktop build flag" is the shell exposing the bridge (off by default until the §9 tests pass), not a client build flag.
- **There is no preload script today.** Phase 1 adds one using only `contextBridge` and `ipcRenderer`, which work with `sandbox: true`. `contextIsolation`, `sandbox` and `nodeIntegration: false` stay as they are.
- **Files Margin Chat doesn't sync are skipped silently today.** The scan only looks at Markdown, PDFs and images. The "Files Margin Chat doesn't sync" list in Vault settings is new UI (phase 2).
- **The desktop main process can't call the backend on its own yet.** `forwardToBackend` serves page requests. Main-process sync (phase 3) calls `net.fetch` with the same session cookie jar, and needs the signed-in user's ID, which today only the page knows (for `X-Margin-Vault-User`).

None of these needs a change to the manifest, the merge, the frontmatter, the trash or history layout, or `/api/vault/*`.

## Phase plan

1. **Native vault in the main process.** `node:fs` `VaultFs` adapter (root containment, symlink checks, temp file + fsync + rename), a preload bridge, native first-run dialogs and a remembered folder with zero clicks. The renderer uses the bridge when it's there. Off by default behind a shell flag.
2. **Watcher and drop-in rules.** The watcher above, ignore list, classification (spec §5.2), echo suppression by content hash, the unsupported-files list, and tests that start from outside the app.
3. **Main-process sync.** Bundle the engine for Node, move `VaultStore` to `userData`, lift the reconcile loop out of the hook, add IPC status, the sync indicator, and Vault settings → Sync.
4. **Desktop-first pass.** The soft desktop-web notice, OS drag and drop, Reveal in Finder / Open vault folder, a phone-width regression pass, and updates to this doc and `desktop/README.md`.
