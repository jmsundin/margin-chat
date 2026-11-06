# Margin Chat — Desktop-First + Seamless Local/Cloud Vault Sync
## A spec for Claude Code

**Date:** 2026-11-05 (revision 2; first draft 2026-11-04)
**Status:** Phases 0–3 and the Phase 4 menu/indicator items are implemented on branch `claude/desktop-vault-sync` (2026-11-06), behind the shell’s `nativeVault` setting. What landed and what remains: `docs/desktop-vault-sync.md`.
**Revision 2 changes:** §4.2 runtime detection + bridge handshake (replaces the
"desktop build flag" idea); §4.4 editor-buffer ownership; §4.5 vault identity
for the journal; §5.1 hash on second stability check, Linux watcher note;
§5.2 trash copies for external deletes come from the local copy, case rules;
§5.3 Windows rename retry + macOS xattr/Finder-tag handling, bounded echo map;
§6 window-closed sync made consistent; §8 Phase 1 flag wording; §9 test
host split; new tests 11–13.
**Repo:** `github.com/jmsundin/margin-chat` (reviewed from Jon's Mac clone at
`/Users/jon/src/margin-chat`, HEAD `f51f94c`, pulled 2026-11-04 22:14 EST)
**Read first:** `docs/markdown-vault.md` (the vault/sync contract — this spec
builds on it, it does not replace it), `desktop/README.md`,
`packages/workspace-contracts/README.md`, and the MCP authorship/update spec
(2026-11-04) for the provenance/history rules this work must not break.

---

## 1. The product decision (Jon, 2026-11-04)

Margin Chat's primary surface changes:

1. **Desktop app = the main product.** The big view, the big version — the
   Obsidian position. Full workspace, maps/graphs, multi-pane work, deep
   editing, vault management. New large-screen features are designed,
   built, and tested desktop-first.
2. **Web app = mobile, for now.** On a phone browser, Margin Chat stays a
   first-class companion: Jon uses it *a lot* — plausibly more often than
   desktop — for capture, reading, Ask AI, and quick edits. It must stay
   fast and reliable at phone width.
3. **Web app on a desktop browser = maintenance mode.** It keeps working
   (existing users, links, Stripe/password-reset flows, first-run before a
   download), but it is no longer the design target for new features. Do
   not break it; do not optimise new work for it.
4. Both surfaces can still be worked on — this is a priority order, not a
   deletion list. Priority when time/trade-offs conflict:
   **desktop app > mobile web > desktop web.**

### What this is *not*

- Not a native rewrite. The desktop app stays Electron + the existing
  React client (see §3 for what moves and what does not).
- Not a new sync protocol, a CRDT, or a new server. The cloud vault
  (private Vercel Blob, per-file revisions, sharded manifest schema 2,
  three-way merge) already works — the gap is on the *device* side.
- Not making the vault a Git repository. "Locally versioned" means the
  existing model — immutable per-file revisions + `.margin-chat/history/`
  + `.margin-chat/trash/` (30-day restore) — working fully offline on
  desktop, not a `.git/` folder in the user's vault (see §5.4).
- Not a mobile native app. Mobile stays web in this spec.

---

## 2. The user story that defines success

> Jon drops a file into his Margin Chat vault folder — from Finder, from
> another editor, from Obsidian, from a download — and does nothing else.
> It appears in Margin Chat, and in his cloud vault, and on his phone.
> He edits a note on his phone on the train, offline edits a different
> note on the desktop at home, and both changes converge with no
> conflict dialog, no duplicate, and no thought from him.
> He opens the desktop app and is *in* his vault — no folder picker, no
> "Allow access" click, no sync button. Sync has no UI in the happy path;
> it is only visible when it needs him (offline, mass-deletion guard, or
> a real error).

Every requirement below exists to make that story true. If a task does
not serve it or the desktop-first shift, it is out of scope.

---

## 3. Where things stand today (verified in the codebase)

Do not re-litigate these; build on them.

- `desktop/` is an Electron **shell** around the unchanged web client:
  `desktop/main.mjs` serves the built client from `margin://app` and
  forwards `/api/*` to `https://www.marginchat.com` via `net.fetch`
  (HttpOnly session cookie stays in Electron's jar, never the renderer).
  Also present: `clientBundles.mjs` (client self-update from the site),
  `shellUpdater.mjs` (app self-update from GitHub releases),
  `deepLinks.mjs` (`marginchat://`), `permissions.mjs`, single-instance
  lock, native menu with view shortcuts. Unsigned installers are a known,
  documented gap (`desktop/README.md` → "Not done yet").
- The vault is plain Markdown at the vault root, Obsidian-compatible:
  YAML frontmatter with the `margin-chat: |-` schema-v3/4 registry,
  `<ai>` / `<user>` block wrappers with stable block IDs, `[[wiki links]]`,
  typed relations, `workspace.json` for settings (not content),
  `Attachments/<id>/`, `.margin-chat/history/`, `.margin-chat/trash/`.
  The canonical codec is `packages/workspace-contracts` — used by
  browser, Node, and Vercel. **It stays canonical.**
- Cloud sync already exists and is good: per-file sync to private Blob,
  immutable revisions, 256-shard manifest, `GET /api/vault/changes`,
  per-file **three-way merge** against each device's base revision
  (blocks matched by ID, frontmatter merged per-property/set-wise, no
  conflict markers, no user chooser, losing inputs kept in history),
  atomic rename publication, tombstones (edit beats delete),
  mass-deletion guard (>10 files or >1/5 of the folder → held for the
  user's choice), bounded working set / cloud-only documents.
  Postgres is a derived projection (Markdown is committed first) plus
  native accounts/auth/billing/MCP/capture data.
- Connected-folder sync already exists **in the renderer**: the web
  client reconciles a folder chosen via the File System Access API,
  scans by size+mtime, watches where the browser folder observer exists
  (otherwise polls names/sizes/mtimes every few seconds), and reconciles
  external edits with the same merge + deletion guard. On desktop this
  folder is mandatory-at-first-run and remembered via
  `desktop/permissions.mjs` answering Chromium's permission *checks*.

### The actual gaps (what this spec pays for)

1. **Desktop vault I/O lives in Chromium, not in the OS.** The renderer
   holds the folder through the File System Access API. Consequences:
   permission fragility across launches, no real recursive filesystem
   watcher, no sync while the window/renderer is not alive, polling
   instead of events, and a second storage world (OPFS) underneath.
2. **Sync is a page concern, not an app concern.** Reloads, renderer
   crashes, and window state can interrupt it. There is no durable,
   OS-level "this folder ↔ this cloud vault" daemon.
3. **Drop-in is incidental, not designed.** External files do arrive via
   folder scans today, but there is no specified behaviour for partial
   files (browser downloads, editor temp files), no stability check
   contract, no echo suppression contract for the app's own writes, and
   no acceptance test that starts from Finder/a shell `cp`.
4. **The client is one responsive web app.** Nothing marks desktop as
   the primary target: layout, menus, keyboard, drag-and-drop from the
   OS, and large-view features (maps, the planned Roadmap view) are all
   designed browser-first by default.

---

## 4. Architecture: what moves where

### 4.1 Principle

One vault engine, three filesystem adapters.

Extract the vault/sync core that today lives in the client into a shared,
platform-neutral package, driven by a small filesystem interface, so the
*same* merge/scan/sync logic runs everywhere:

```
packages/vault-sync/            (new — name may follow existing conventions)
  VaultFs interface:  list / read / writeAtomic / move / delete /
                      watch (events) / stat
  scan + reconcile    (today: client folder-scan logic)
  three-way merge     (reuse — do not reimplement; call the existing code
                       or workspace-contracts where it already lives)
  cloud transport     (today: /api/vault/* calls)
  durable sync journal + per-device base revisions
Adapters:
  desktop-main  → node:fs (real folder, recursive watch)
  web/mobile    → OPFS + File System Access connected folder (as today)
```

If the audit (Phase 0) finds the sync core is already cleanly separable,
prefer the smallest extraction that achieves this. Do not rewrite the
merge; its behaviour is specified in `docs/markdown-vault.md` and is
covered by tests.

### 4.2 Desktop: vault I/O moves to the Electron main process

- The main process owns the vault folder with `node:fs`. The renderer
  never touches the File System Access API in desktop builds.
- Expose the vault to the renderer over a **preload IPC bridge**
  implementing the `VaultFs` interface (plus sync-status events, §6).
  Constraints that already hold in `main.mjs` must keep holding:
  `contextIsolation: true`, `sandbox: true`, `nodeIntegration: false`,
  single instance. Validate every IPC path against the vault root
  (no `..` escapes, no symlink escapes) in the main process.
- `desktop/permissions.mjs`'s folder-check hack becomes unnecessary for
  vault access once I/O is native; remove that path only after the
  native path is the default and the fallback (§8) is decided.
- The vault folder is the **source of truth on desktop**. OPFS is not a
  second copy of a folder-backed vault: when a folder is connected, the
  renderer's local index/checkpoint may remain as a cache, but bytes
  live in the folder and in the cloud — nowhere else.
- **Exception the trash flow needs (§5.2):** the main process keeps a
  full local copy of the last known content of every document it has
  synced — including cloud-only documents it has ever pulled — in the
  app's `userData` store (not in the folder). An external delete removes
  the bytes before the watcher sees it; the trash copy and "Put them
  back" are served from this store, never from the folder.
- **Runtime detection, not a build flag.** The desktop app loads the same
  client bundle the site serves (`clientBundles.mjs`), so there is one
  client build. The client switches to the native path when the preload
  bridge is present (`window.marginVault` or the existing convention).
  The bridge carries a **protocol version**; client and shell negotiate
  at startup and the client falls back to today's File System Access
  path if the versions do not match (shell and client self-update on
  different cadences and *will* drift).
- **One engine per vault.** Whenever the native bridge is present and
  negotiated, the renderer's in-page sync and folder-scan loops are
  disabled for that vault. Two engines running against one folder is a
  release blocker, same as echo loops (§5.3).
- First run keeps today's choices (Open a folder… with the >5,000 files
  / >2 GB sanity prompt, Create a new vault…, previous folders, Not now)
  but they are native dialogs/state, and a remembered folder opens with
  **zero clicks** — no permission step exists to fail.
- Default-location suggestion for a *new* vault: `~/Documents/Margin Chat`
  (platform equivalent), offered, never imposed.

### 4.3 Sync runs in the main process on desktop

- On desktop, the sync loop (scan → merge → push/pull → project status)
  runs in the **main process**, using the shared package with the native
  adapter. It starts at app launch, survives renderer reloads/crashes,
  and its journal/base-revisions live in the app's `userData` (per vault
  folder identity, following the existing "baseline follows the directory,
  not its name" rule) — **not** inside the synced folder.
- The renderer subscribes to sync status over IPC and renders it (§6);
  it does not drive sync. Web/mobile keep the existing in-page sync.
- Auth: reuse the existing session. `/api/*` already flows through the
  main process (`forwardToBackend` in `main.mjs`); the main-process sync
  transport must use the same cookie jar / `net.fetch` path so the
  renderer and any other process never see the credential.
- Cloud plan gating is unchanged (local editing/export free; cloud sync
  keeps its existing paid/admin requirement). A local-only vault with
  sync unavailable must still get full watcher + versioning behaviour —
  "seamless" applies to the local vault even with the cloud off.

### 4.4 Who owns the open editor buffer

Today the renderer owns both the editor buffer and the disk/cloud state.
Once the main process writes to disk (cloud pull, merge result, external
edit ingested), a document the user is editing can change underneath the
renderer. Rule:

- Main never writes a document and stays silent: every write emits a
  `document-changed` IPC event carrying the new disk content and its
  revision/base id.
- The renderer treats that event as a **new base** and runs the same
  three-way merge (device base → disk content × unsaved buffer) into the
  live editor, preserving caret/selection where blocks are unchanged.
  No reload prompt, no "file changed on disk" dialog, no conflict
  markers — §5.5 applies to the buffer exactly as to files.
- An in-app save goes through the bridge, which records the echo hash
  (§5.3) and returns the resulting revision so the renderer's base is
  updated atomically with the write.
- Acceptance: test 11 (§9).

### 4.5 Vault identity for the journal

The journal, base revisions and local-copy store (§4.2) live in
`userData` keyed by **vault identity**, following the existing "baseline
follows the directory, not its name" rule. Identity is resolved in this
order, and Phase 0 records the exact fields:

1. A stable vault id written to `workspace.json` on first open (or
   reused if present — it is the same id the cloud vault already uses
   for this folder).
2. Filesystem identity of the root (device + inode on macOS/Linux, file
   ID on Windows) as a tiebreaker when two folders claim the same id
   (a copied vault). A copy is a new vault with the same documents and
   follows §5.2's unknown-id import rules; it does not inherit the
   original's journal.

A folder moved across volumes keeps its `workspace.json` id, so it keeps
its journal. A folder with no `workspace.json` and an unknown
filesystem identity is a fresh vault.

---

## 5. The drop-in contract (the heart of this spec)

### 5.1 Watching

- Native recursive watch on the vault folder (`node:fs.watch` recursive
  where the platform supports it, or `chokidar` / `@parcel/watcher` if
  the audit shows `fs.watch` is insufficient — decide in Phase 0 and
  record why in `desktop/README.md`). Known going in: Linux recursive
  `fs.watch` misses files created inside *new* subdirectories, so the
  audit must test that case explicitly; expect to land on a library.
  No polling as the primary mechanism on desktop.
- Events are coalesced: debounce per-path (~500 ms, tunable in one named
  constant) and a **stability check** before ingesting a create/modify —
  size+mtime unchanged across two checks, **and the content hash on the
  second check equals the first** (mtime granularity is 1 s on some
  filesystems, so size+mtime alone can miss an in-place save), and the
  file opens for reading; this is what keeps half-copied and
  half-downloaded files out.
- **Ignore list** (never ingested, never synced, never counted by the
  deletion guard): OS/editor noise — `.DS_Store`, `Thumbs.db`,
  `desktop.ini`, `~$*` Office locks, `*.tmp`, `*.swp`/`*.swo`, `4913`,
  `*.crdownload`, `*.part`, `*.download`, `.git/`, `.obsidian/`
  workspace state files that Obsidian churns (decide the exact list
  against a real Obsidian vault in Phase 2; vault *content* in
  `.obsidian/` is not Margin Chat content). Everything under
  `.margin-chat/` is app-owned: watched only for the app's own
  consistency, never treated as user drop-ins.

### 5.2 Classifying what arrives

For each stable create/modify/rename/delete the watcher detects:

| Arrival | Behaviour |
|---|---|
| `.md` with a `margin-chat-id` already known | External edit of that document — reconcile via three-way merge against the device base, exactly like today's folder scans. Filename changes keep identity; managed incoming links update as today. |
| `.md` with an unknown `margin-chat-id` | A document from another device/vault copy or another app — import under that identity (collision rules as in ZIP import: current writing stays current, divergent text preserved in history, no duplicate document). |
| Plain `.md`, no Margin Chat header | A genuine drop-in. Import as a new document; add `margin-chat-id` + `created` on first read, as today's first folder read does — and the user-facing copy must say this happens (it already does on the web folder flow; keep it). Preserve the file's name and location in the folder. |
| PDF / DOCX / image / other supported type | Attachment/ingestion path as today: lands under `Attachments/<id>/` semantics or as an indexed vault document per existing rules in `docs/markdown-vault.md`. Unsupported types: leave the file alone in the folder, list it once in Vault settings → "Files Margin Chat doesn't sync" — do not delete, rename, or nag. |
| Rename / move within the folder | Identity follows the file (Markdown) or bytes (binary), as today; renames are not deletions and do not trip the deletion guard. Publish rename pairs atomically to the cloud as today. |
| Delete | Tombstone flow as today: a trash copy lands in `.margin-chat/trash/` first, 30-day restore, edit-beats-delete if a competing offline edit arrives. For an **external** delete the bytes are already gone when the watcher fires, so the trash copy is written from the main process's local-copy store (§4.2), never read from the folder. |
| Burst that would delete >10 files or >1/5 of the vault | **Hold**, exactly as today: nothing is deleted anywhere until Jon chooses "Put them back" or "Delete them everywhere". Cloud sync of non-deletion changes continues while held. |

Subfolders: files dropped into subfolders keep their path (today,
externally chosen paths stay where the user put them; only *generated*
documents go to the vault root). Do not flatten drop-ins.

Case: macOS and Windows vault folders are usually case-insensitive; the
cloud manifest is case-sensitive. Rules: (a) a rename that differs only
in case is a rename, never a delete + create, and never trips the
deletion guard; (b) if a cloud pull would create two paths that collide
case-insensitively on this device, the second is written under a
de-duplicated name (today's import collision rule) and the rename is
published back so the cloud converges — never silently overwrite.

### 5.3 Echo suppression and write discipline

- Every write the app itself makes (cloud pull, merge result, in-app
  save) records the resulting content hash in an in-memory + journaled
  suppression map; watcher events matching that hash are not re-ingested.
  The map is **bounded**: one entry per path (latest hash wins), entries
  expire once the watcher has reported the matching event or after a
  named timeout (~60 s), and the journaled copy is pruned on launch.
  A sync loop that re-uploads its own downloads is a release blocker.
- All app writes to the folder are **atomic**: write to a temp file in
  the same directory, fsync, rename over the target. A crash mid-write
  leaves the previous file intact (test it by killing the app mid-pull).
  Platform realities the implementation must handle, with tests:
  - **Windows:** rename-over fails (`EPERM`/`EBUSY`) while another
    program holds the target open. Retry with bounded backoff (reuse the
    existing retry bounds); if still blocked, keep the temp file, leave
    the target untouched, queue the write, and surface nothing unless
    it persists past the "repeated failure" threshold (§6).
  - **macOS:** rename replaces the inode, dropping extended attributes
    (Finder tags, comments, quarantine flags). Copy xattrs from the old
    file to the temp file before the rename (`node:fs` has no xattr API;
    Phase 0 picks a dependency or decides to document the loss — the
    default in this spec is **preserve Finder tags and comments**).
  - Hard links or symlinks *to* a vault file are broken by rename-over;
    document this, do not special-case it.
- If the folder changes *during* an app write batch, abort the batch and
  re-scan — today's rule ("a write puts attachments/history/trash copies
  in place before any Markdown changes; a file that fails partway keeps
  its previous contents") is preserved verbatim.
- A folder that disappears mid-session (unplugged drive, moved folder):
  stop watching, keep the workspace open on the last state, show the
  "folder can't be found" notice (today's copy), write nothing. A folder
  that is missing at launch is never read as empty.

### 5.4 Local versioning

- Every locally detected change and every merge produces the history
  records the system already defines (`.margin-chat/history/<id>/`,
  immutable cloud revisions). Desktop adds no second history format.
- Requirement added by this spec: **history must be browsable and
  restorable fully offline on desktop** (it is the local versioning
  story), and restoring a version is itself a new revision that syncs.
- Do not init Git in the vault, do not shell out to Git, and do not
  require Git to be installed. (Provenance/blame is the separate
  2026-11-04 MCP authorship spec; keep its sidecar rules intact.)

### 5.5 Convergence guarantees (unchanged semantics, now testable)

- Offline on desktop + offline edit on phone-web → both edits merge on
  reconnect via each device's base revision; reconnect order must not
  change the result except in the already-documented tie cases
  (equal/missing timestamps → committed cloud wording wins; originals
  retained in history either way).
- No conflict markers ever appear in a user's file. No conflict
  *dialogs* exist. The only user decisions sync may ever request are:
  the mass-deletion hold, a missing folder, and a real error retry.

---

## 6. Sync status UX (desktop)

One quiet indicator in the workspace chrome, fed by IPC status events:

`Synced · <time>` / `Syncing…` / `Offline — changes saved locally` /
`Paused` (user toggle in Vault settings) / `Needs attention` (only for:
mass-deletion hold, folder missing, auth expired, repeated sync failure).

Rules: no toasts for ordinary sync; no modal for anything except the
mass-deletion choice; clicking the indicator opens Vault settings →
Sync, which shows vault folder path, cloud vault state, last sync,
pending-change count, the unsupported-files list (§5.2), and buttons:
**Open vault folder** (Finder/Explorer), **Pause sync**, **Sync now**
(present for reassurance/diagnostics, never *required*).

Also: macOS/Windows/Linux menu + tray is out of scope. On macOS, where
closing the window leaves the app running, main-process sync simply
continues — that is a consequence of §4.3, needs no toggle, and is the
default. "Launch at login" (a login-item helper) is **out of scope** for
this spec; do not build a separate background daemon. (Revision 2: the
earlier default-off toggle contradicted §4.3 and is removed.)

---

## 7. Desktop-first client work

In priority order; stop when Jon says the spec's scope is done:

1. **Design targets.** Desktop app is the reference viewport for new
   features (reference sizes: 1440×920 default window, per `main.mjs`).
   New large-view features (maps, Roadmap view) are specced and QA'd
   there first.
2. **Mobile web guardrails.** The same client at phone width must not
   regress: capture, document read, Ask AI, quick edit, search
   (Cmd/Ctrl+K equivalents) get an explicit phone-width test pass per
   phase. Desktop-first does not mean mobile-last in *quality* — it is
   Jon's most frequent surface.
3. **Desktop-web notice (soft).** Signed-in desktop-browser users see a
   dismissible "Margin Chat works best in the desktop app" notice with
   the existing download/Open-the-app flow (`marginchat://` deep links
   already exist). Never block the web workspace; Stripe returns and
   password resets already bypass the app offer and must keep doing so.
4. **OS integration that serves the vault story:** drag-and-drop files
   from the OS into the workspace (same ingestion path as §5 — it is a
   drop-in with extra steps), **Reveal in Finder/Explorer** for a
   document, **Open vault folder**, external-editor interop (a file
   opened from Margin Chat in another editor is the watcher flow, no
   special casing). Native menu items live beside the existing view
   shortcuts in `main.mjs`'s menu.
5. **Multi-pane / big-view polish** beyond the above is explicitly
   *follow-up* work, specced separately (e.g. the Roadmap view spec).
   This spec buys the platform those features will stand on.

---

## 8. Phases (each lands independently; CI promotion rules unchanged)

Every commit on `main` releases to production — so every phase must be
safe for web/mobile production users on its own, behind the flags noted.

**Phase 0 — Audit (no behaviour change).**
Map where scan/merge/sync/journal code lives today; define the
`VaultFs` interface against the existing folder-adapter; choose the
watcher (`fs.watch` vs `chokidar`) with a written rationale; inventory
renderer assumptions about OPFS/FS-Access that desktop must unwind.
Output: a short design note in `docs/` + the interface in
`packages/vault-sync/` with the existing web adapter implemented against
it and all current tests green.

**Phase 1 — Native vault in the main process.**
Preload IPC `VaultFs` for desktop; desktop builds use it instead of the
File System Access API; first-run/remembered-folder flow is native with
zero-click reopen. Web/mobile untouched. Gate it on the bridge handshake
(§4.2): the shell exposes the bridge only when a shell-side setting
(default off until §9 passes) is on, so the shared client bundle takes
the native path purely by runtime detection. Then flip the shell default,
and retire the `permissions.mjs` folder-check path once no supported
shell version still needs it.

**Phase 2 — Watcher + drop-in contract.**
Native recursive watch, debounce/stability, ignore list, classification
table (§5.2), echo suppression, atomic writes. Acceptance tests start
from outside the app (`cp` / Finder-style rename / partial-file writes).

**Phase 3 — Main-process sync.**
Sync loop + journal move to the main process on desktop; IPC status;
§6 indicator + Vault settings → Sync; offline queue drains on launch,
on wake/focus, and on network return, with bounded backoff (reuse
existing retry bounds). Renderer reload mid-sync must not duplicate or
lose changes.

**Phase 4 — Desktop-first surface pass.**
§7 items 1–4: reference-viewport QA, phone-width regression pass,
soft desktop-web notice, OS drag-and-drop + Reveal/Open-folder.
Update `docs/markdown-vault.md` (Desktop app section) and
`desktop/README.md` to describe the shipped behaviour — docs land with
the code they describe, as the repo already practises.

**Explicitly deferred:** code signing/notarization (already tracked in
`desktop/README.md`), a native mobile app, background sync with the app
fully quit, Git-based versioning, any change to the cloud manifest/
merge semantics or to Postgres.

---

## 9. Acceptance tests (minimum bar per phase)

Extend the existing `bun test` suite (328 test files at last review);
follow its conventions. Test hosts: the shared `packages/vault-sync`
package and the node:fs adapter are tested in `bun test` with a real
temp directory (this covers most of the list). Anything that needs the
Electron main process itself — IPC validation, kill-during-write of the
real shell, missing-folder notices — runs under Playwright's Electron
driver, which already matches the repo's Playwright usage; `bun test`
cannot host Electron. Add at least:

1. **Drop-in:** with the desktop app running, copy a plain `.md`, a
   `.md` with a known `margin-chat-id`, a PDF, and an unsupported file
   into the vault folder from outside the app → first three converge to
   the cloud vault and appear on a second simulated device; the fourth
   is untouched and listed once as unsupported.
2. **Partial write:** write a large `.md` in chunks over ~2 s → exactly
   one ingestion, of the final bytes. A `.crdownload` renamed into place
   is ingested once, on completion.
3. **No echo:** a cloud change pulled to desktop produces zero uploads;
   an in-app save produces exactly one.
4. **Offline convergence:** desktop offline edit + simulated phone-web
   edit to the same and to different documents → merge per §5.5, no
   markers, originals in history, either reconnect order.
5. **Kill-during-write:** terminate the main process mid-pull and
   mid-push → previous files intact, journal recovers, next launch
   converges with no duplicates.
6. **Deletion guard:** external delete of >10 files → held, nothing
   deleted in cloud, both resolutions work; a 2-file delete flows
   through with trash copies.
7. **Missing folder:** rename the vault folder while the app is closed
   and while it is open → never treated as empty, nothing deleted,
   notice shown, recovery on restore.
8. **Obsidian interop:** edit a document in a script simulating Obsidian
   (including a rename and a frontmatter property edit) while Margin
   Chat edits a different block of the same document → both survive
   with block identities intact.
9. **Mobile regression:** phone-width pass over capture/read/Ask AI/
   quick-edit/search after Phases 1–3 (these must not have changed web
   behaviour at all) and after Phase 4.
10. **Cloud opt-in check:** `bun scripts/test-cloud-vault.mjs` still
    passes (it exercises concurrent saves, conflicts, history,
    deletions, binaries against the real Blob store).
11. **Live buffer merge (§4.4):** with a document open and an unsaved
    edit in one block, a cloud pull changes another block → the editor
    shows both, no prompt; the subsequent save uploads exactly one
    revision containing both. Same test with the *same* block edited →
    merge per §5.5, originals in history.
12. **Case-only rename:** rename `Note.md` → `note.md` externally →
    identity kept, no deletion-guard count, cloud shows the new name.
13. **Windows locked target / macOS xattrs (§5.3):** hold a vault file
    open in another process on Windows during a pull → the write is
    retried then queued, the target is never truncated. On macOS, a
    Finder-tagged file keeps its tags across an app write.

---

## 10. Guardrails for Claude Code

- `packages/workspace-contracts` remains the canonical Markdown codec.
  If the vault-sync extraction needs codec behaviour, import it — never
  fork or copy it.
- Do not change: manifest schema, merge semantics, frontmatter format,
  block-ID/authorship wrappers, relation vocabulary, trash/history
  layout, or `/api/vault/*` contracts — unless a phase's audit proves a
  change necessary, in which case stop and surface it to Jon before
  changing it.
- Preserve the repo's release discipline: every commit on `main`
  promotes to production once CI passes, so flags and defaults matter;
  never ship a phase that changes web/mobile behaviour by default.
- Renderer security posture is not negotiable (§4.2). No new
  `nodeIntegration`, no disabling `sandbox`, no credential in the
  renderer.
- No data loss beats no feature: any test failure in §9 items 4–7 or
  11 blocks the phase, not the test.
- One sync engine per vault at any time (§4.2); a renderer-side loop
  still running while the native bridge is active is a bug, not a
  belt-and-braces safeguard.
- Keep user-facing copy consistent with the existing voice in
  `docs/markdown-vault.md` ("Reading “Name”…", "folder can't be found",
  etc.) rather than inventing new sync jargon.

## 11. Decisions left to Jon (defaults taken above — veto in review)

1. New-vault default location `~/Documents/Margin Chat` (§4.2).
2. "Keep syncing when the window is closed" toggle default **off** (§6).
3. Desktop-web notice is dismissible and non-blocking (§7.3) — the
   alternative, a hard redirect to the app, was rejected in this draft
   because links, billing, and resets still need the web.
4. Signing/notarization stays a separate, later purchase (§8) — the
   desktop-first push makes it more valuable, but it is not smuggled
   into this spec's scope.
5. (Rev 2) The desktop keeps a full local copy of every synced
   document in `userData` so external deletes can be trashed and
   restored (§4.2). This duplicates folder bytes on disk; the
   alternative — trash only what the folder still has — breaks "Put
   them back" for external deletes and was rejected.
6. (Rev 2) macOS Finder tags/comments are preserved across app writes
   via an xattr dependency rather than documented as lost (§5.3).
7. (Rev 2) "Launch at login" is out of scope; window-closed sync on
   macOS is simply on, with no toggle (§6).
