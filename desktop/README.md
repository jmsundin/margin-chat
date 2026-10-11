# Margin Chat desktop (macOS, Windows, Linux)

An Electron shell around the existing web client. The app bundles the built
client (`../dist`) and serves it from `margin://app`; requests to `/api/*` are
forwarded from the main process to the hosted backend, so the client code runs
unchanged with its same-origin relative fetches.

- Auth: the backend's HttpOnly session cookie is stored in Electron's cookie
  jar under the backend's domain. The renderer never sees it.
- Vault: the File System Access API works as it does in Chrome. The app grants
  the folder permission itself instead of prompting.
- Links to other sites open in the default browser.
- Only one instance runs at a time, so two windows never write the same vault.

## Run it

```sh
bun install              # root dependencies, for the client build
bun run desktop:install  # Electron and electron-builder (desktop/ is not a workspace)

bun run desktop:start    # build the client, open the app against www.marginchat.com
bun run desktop:dev      # load the Vite dev server (start `bun run dev` first)
bun run desktop:dist     # build the client and package a macOS .dmg into desktop/release
bun run --cwd desktop dist:win    # Windows installer (.exe)
bun run --cwd desktop dist:linux  # Linux AppImage and .deb
```

`MARGIN_DESKTOP_API_URL` picks the backend for `start` and packaged builds, for
example `MARGIN_DESKTOP_API_URL=http://127.0.0.1:8787 bun run desktop:start`.
The default is `https://www.marginchat.com`, so the bundled client must stay
compatible with whatever production runs.

## Publishing a release

Run Actions > Desktop release > Run workflow with a version number (and the
commit production runs). It builds the client once, packages a universal macOS
.dmg, a 64-bit Windows installer and a Linux AppImage and .deb on their own
runners, and publishes them as the GitHub release `desktop-v<version>` together
with the client's `version.json`.

marginchat.com/download reads the latest release from
`GET /api/downloads/desktop` and offers the visitor's system. Each button goes
to `/api/downloads/desktop/<mac|windows|linux|linux-deb>`, which saves a row in
`marginchat_desktop_downloads` (IP address, user agent, system, language,
referrer, which button, the signed-in account if any, and Vercel's approximate
country, region, city and coordinates) and then redirects to a signed GitHub
download link. The repository is private, so the server needs
`DESKTOP_RELEASES_TOKEN`: a fine-grained token with read-only Contents access.
Without it the page keeps offering the web app.

The app's update check compares itself with that same latest release, so it
only offers an update when a newer installer exists.

## Not done yet

- Signing and notarization: the installers are unsigned. macOS blocks the app
  on first open until the person chooses Open Anyway in System Settings >
  Privacy & Security, and Windows SmartScreen asks them to choose More info >
  Run anyway. Signing needs an Apple Developer ID certificate with
  notarization credentials, and a Windows code-signing certificate, passed to
  electron-builder in the Desktop release workflow.
- Installing updates: the web app's service worker update flow does not run
  under `margin://`. Instead the app compares its bundled `version.json` with
  the latest desktop release every hour and, when that is newer (by commit time),
  shows an "Update available" dialog. "Download update" opens
  `MARGIN_DESKTOP_DOWNLOAD_URL` (default: marginchat.com/download).
  `electron-updater` would make updating one click, but it needs signed builds
  and a public update feed.
