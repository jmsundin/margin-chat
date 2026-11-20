# Desktop local mode

The desktop app is free and needs no account. You download it, open a folder of Markdown files, and use every feature with your own AI API keys. Syncing between computers is optional: keep the folder in iCloud Drive or Google Drive and let the operating system sync it. An account is only needed for the web app (Cloud or Cloud + AI), and signing in from the desktop app is optional.

## How it works

The app runs Margin Chat's own server inside its main process instead of sending `/api` to marginchat.com.

- `server/local/server.mjs` starts the server on a loopback port (`127.0.0.1`, random). Every request must carry the `x-margin-local-token` header with a random token made at each launch, so nothing else on the computer can use it.
- The database is PGlite (Postgres compiled to WebAssembly, `server/db/pglitePool.mjs`) in `<userData>/local/database`. The same migrations and repositories as production run against it. The pool hands out its one connection to one lease at a time, so transactions never interleave.
- Vault files are kept by the file storage that local development already used (`VAULT_STORAGE_DIR`), in `<userData>/local/vault`. The folder on disk is synced to it by the desktop vault sync (`desktop/vaultSync.mjs`), the same code that syncs with the cloud. So the folder the person opens stays the source, and the app's copy is like the cloud copy.
- There is one local person (`server/local/mode.mjs`). The auth service answers every request as that person, and billing reports `accessKind: "local"`. Nothing is hosted, so AI uses the person's own keys. Account, billing, Chrome extension and connector routes answer 404 with "runs on your computer without an account".
- API keys saved in the app are encrypted in the database with a key made once per computer. That key is locked by the system keychain (Electron `safeStorage`) in `<userData>/local/keys/secret.locked`. On Linux without a keyring it is kept in a file only the user can read.
- Hosted provider keys from the surrounding shell never reach the local server: it starts with a fixed environment (`localModeEnv`).
- Local mode serves only the client that came with the app. The website's newer client could call routes the bundled server doesn't have yet, so client self-updates are off. App updates bring the client and the server together.

## Building

`bun run desktop:engine` builds both the vault sync engine and the local server. `scripts/build-desktop-server.mjs` bundles the server into `desktop/local-server/server.mjs` and copies beside it what it reads while it runs: the migrations and PGlite's `pglite.wasm`, `pglite.data`, `initdb.wasm` and `vector.tar.gz`. The folder is gitignored. The Desktop release workflow builds it and packs it with the app.

## Which mode the app is in

`desktop/appMode.mjs` keeps the mode in `<userData>/app-mode.json`. A new install starts in local mode. An install that was already used signed in (it has a cookie jar from before local mode existed) stays signed in. `MARGIN_DESKTOP_LOCAL=1` or `0` picks a mode for development.

- In local mode, Settings shows **Sign in** where Log out was. It opens `/__margin/use-account`: the app saves the mode, restarts, and opens on the sign-in form.
- When the app is signed out, the sign-in page offers **Use Margin Chat without an account**, which opens `/__margin/use-local`.
- A page checks `/__margin/capabilities` before offering either one. An older app answers that path with the page itself, so the offer stays hidden there.
- Nothing is deleted when switching. Each mode keeps its own data: local mode under `<userData>/local/`, its folder choice and sync state under the local person's id, and the account's under the account's id. Switching forgets only the person remembered for opening offline.
- Local mode also turns on native vault folder access. Its data lives in `<userData>/local/`.

## First launch

The vault folder screen ("Open a folder / Create a new vault") comes before anything else. The "Start here" sample documents are added only after that choice, and only when the workspace is still empty. A folder that already holds notes therefore never gets them, while a new empty vault (or "Not now") does.

## Your own keys for everything

Settings → API keys has the AI model keys and, under **Other services**, keys for the features that call other services. With these, local mode (or any account) has every feature without a plan:

- **Web search:** a Tavily key. The person's own key is used without billing here (`server/webSearch`).
- **Translation in Language mode:** a DeepL or Google Cloud Translation key. Wiktionary and AI meanings work without one (`server/languageTerms/lookup.mjs`).
- **Read-aloud voices:** an Azure Speech key saved as `region:key`. The device's own voice works without one (`server/languageTerms/speech.mjs`).
- **Explore's Ask** and search by meaning use the person's own AI keys (an OpenAI key for embeddings), like every other AI request.

The person's own keys have no daily caps, since their own account pays. Migration `0036_service_api_keys` allows the new providers. `hasAny` still means a model key, so a search key alone doesn't count as having AI.

## iCloud Drive and Google Drive

Sync between computers is left to the operating system: the vault folder can live in iCloud Drive, Google Drive or Dropbox. What their sync does to the folder must never read as the person deleting notes.

- **iCloud before macOS Sonoma** ("Optimize Mac Storage") replaces a file with `.<name>.icloud`. A scan treats the file as still there, with the text it was last read with (`evictedFileName` in `packages/vault-sync`, `scanMarkdownDirectory` and the companion reads in `client/src/lib/workspaceStorage.ts`). A note never read on this computer is asked for (`brctl download`, `download` in `desktop/vaultFs.mjs`) and taken in once it arrives. Writing to such a file waits: the write asks for the file and stops with a conflict, which is retried shortly, so iCloud never ends up with two versions side by side. Leaving it alone writes nothing.
- **iCloud on Sonoma and later, and Google Drive streaming** keep the name and download a file when it is read. A file unchanged since it was last read is never read again (its size and date match), so nothing is downloaded for it. A read that fails, such as offline, fails the whole pass, which is retried; it is never taken as a deletion or as empty text.
- **Temporary transfers** (`.tmp.drivedownload`, `.tmp.driveupload`, `.dropbox.cache`, and `*.icloud`, `*.download`, `*.part` files) are ignored by the scan and the folder watcher alike.
- **Conflict copies** ("Note 2.md" from iCloud, "Note (1).md" or "(conflicted copy)" from others) are ordinary notes and are taken in as their own documents, so neither version is lost.
- A folder that suddenly looks empty or mostly gone (unmounted, signed out of the drive) still holds the deletions for the person to confirm, as before (`client/src/lib/folderDeletionGuard.ts`).

## Steps

1. The app runs the server on the computer with no account (this note).
2. First launch opens straight to "Open a folder / Create a new vault". Local mode is on by default for new installs. Signing in is optional, from Settings, for Cloud sync or hosted AI.
3. The features that use keys only the hosted server has (embeddings, web search, voice, translation) use the person's own keys, or say which key they need.
4. iCloud Drive and Google Drive folders: files that haven't downloaded yet, conflict copies, and temporary files (above).
5. Web sign-up starts a free trial with a card, for Cloud ($10/mo) or Cloud + AI ($20/mo).
6. A signed and notarized Mac download.
