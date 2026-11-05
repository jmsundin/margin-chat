# Vault sync: the platform boundary

This package holds what the desktop app needs to run the vault on a real folder
in its main process, and nothing the web client does not already do. It is the
output of the desktop-first spec's Phase 0 audit (`docs/desktop-vault-sync.md`).

- `vaultFs.ts` — the `VaultDirectory` / `VaultFileHandle` / `VaultWritable`
  interface: the subset of the browser's directory-handle API the folder code
  uses. A `FileSystemDirectoryHandle` satisfies it unchanged
  (`asVaultDirectory`), so **the web and mobile adapter is the browser's own
  handle**, and the browser-side folder code (`client/src/lib/workspaceStorage.ts`,
  `desktopVault.ts`, `vaultLocal.ts`) is the engine's folder logic for every
  platform. Error names follow the DOM.
- `nodeVaultFs.ts` — the same interface over `node:fs`, for Electron's main
  process: lists and opens entries, never follows symbolic links, takes
  snapshots that refuse to read a file that changed since (Chromium's
  behaviour, so `readFreshFile` keeps working), and replaces files atomically
  (temp file beside the target, fsync, rename; cloned first on macOS so Finder
  tags and comments survive; retried on Windows while another program holds
  the file, then reported as `TargetBusyError`).
- `ignore.ts` — names and folders that are never content: system and editor
  noise, partial downloads, lock files, other tools' hidden folders.
- `echoSuppression.ts` — the app's own writes recorded by path and hash, so the
  watcher drops their echoes and never re-ingests a cloud pull.
- `folderWatcher.ts` — recursive `fs.watch` with per-path debounce, a two-read
  stability check (size, date and hash, plus the file opening for reading), a
  one-time listing of folders that appear, ignore and echo filtering, and
  batched delivery. It reports *which paths changed*; classifying them is the
  scan's job, exactly as on the web.

Import `@margin-chat/vault-sync` from browser code (platform-neutral) and
`@margin-chat/vault-sync/node` from Node (adds the adapter and watcher).

## Watcher decision (Phase 0)

`node:fs.watch` with `recursive: true`, no library. Reasons:

- The desktop shell has no runtime dependencies beyond Electron, and every
  platform it ships on has native recursive watching in its Node: FSEvents on
  macOS, `ReadDirectoryChangesW` on Windows, and inotify-per-folder on Linux
  (Node 20+, which Electron 44 exceeds).
- The known Linux gap, files created inside a folder that itself just appeared
  before the inotify watch for it is attached, is covered by listing a new
  folder once when its event arrives (`reportFolderContents`). This case is
  tested in `tests/vault-sync-watcher.test.ts` and under plain Node.
- Events carry a path on all three platforms; an event without one (seen on
  some network filesystems) becomes a whole-folder look, which the scan handles
  cheaply through its size-and-date checks.
- A periodic safety rescan is available (`rescanEveryMs`) and off by default:
  events are the mechanism, not polling.

Revisit with `chokidar` or `@parcel/watcher` only if a platform proves to miss
events in practice; both drop in behind `RawWatchSource` without touching the
debounce, stability or echo logic.

## Tests

`bun test tests/vault-sync-node-fs.test.ts tests/vault-sync-watcher.test.ts`
runs the adapter against a real temporary folder, including the existing
browser folder code (`readDirectoryWorkspace`, `writeConnectedDirectoryWorkspace`,
companions, listings, previews, `createVaultFolder`) unchanged, and the
watcher with both an injected event source and the real one.
