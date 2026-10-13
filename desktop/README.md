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
.dmg and .zip, a 64-bit Windows installer and a Linux AppImage and .deb on
their own runners, and publishes them as the GitHub release
`desktop-v<version>` together with the client's `version.json` and
`desktop-update.json` (each installer's size and SHA-512, written by
`scripts/desktop-update-manifest.mjs`).

marginchat.com/download reads the latest release from
`GET /api/downloads/desktop` and offers the visitor's system. Each button goes
to `/api/downloads/desktop/<mac|windows|linux|linux-deb>`, which saves a row in
`marginchat_desktop_downloads` (IP address, user agent, system, language,
referrer, which button, the signed-in account if any, and Vercel's approximate
country, region, city and coordinates) and then redirects to a signed GitHub
download link. The repository is public, so no token is needed;
`DESKTOP_RELEASES_TOKEN` (read-only Contents access) is only for a private
repository. Without a release the page keeps offering the web app.

## Updates

The desktop app updates itself. Every 15 minutes, and when its window comes
back into focus, it compares its client's `version.json` with the website's.
When the website runs a newer build it downloads that build, using the file
list and SHA-256 checksums in `desktop-bundle.json` (written by
`client/build/desktop-bundle.mjs`), into `client-bundles/<commit>` in the
app's data folder. Files that did not change are copied from the client it
already has. Once every file checks out, the app serves the new client and
tells the page, which reloads at a quiet moment (minimized, or just opened)
after saving edits, or when the person clicks Restart now. A failed or
tampered download leaves the current client in place. The previous client is
kept so an open page can still load its chunks, and a newer installer always
wins over an older download.

So every Production release reaches desktop users without a new installer.

The app itself (Electron, `main.mjs`) updates from the latest Desktop release
(`desktop/shellUpdater.mjs`). Thirty seconds after launch and every four
hours it reads `desktop-update.json` from
`github.com/jmsundin/margin-chat/releases/latest/download/`
(`MARGIN_DESKTOP_UPDATE_FEED` overrides it). When the release's version is
higher, it downloads the file for its system into `app-updates/` in its data
folder and checks its size and SHA-512. The update installs when the person
quits, or when the page restarts into it at a quiet moment or on Restart now
(after saving edits), which reopens the app:

- Windows runs the new installer silently.
- macOS swaps the new .app bundle in place (no Squirrel, so it works
  unsigned) and puts the old one back if the move fails.
- Linux replaces the AppImage.

A .deb install, a Mac app opened straight from the disk image, or an app in a
folder it can't write to can't replace itself; it shows a "download the new
version" prompt once per version instead.

## Not done yet

- Signing and notarization: the installers are unsigned. macOS blocks the app
  on first open until the person chooses Open Anyway in System Settings >
  Privacy & Security, and Windows SmartScreen asks them to choose More info >
  Run anyway. Signing needs an Apple Developer ID certificate with
  notarization credentials, and a Windows code-signing certificate, passed to
  electron-builder in the Desktop release workflow.
- Copies built before this updater can't update themselves; install a
  release made after it once by hand.
