# Margin Chat for macOS

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
bun run desktop:dist     # build the client and package release/Margin Chat-<version>.dmg
```

`MARGIN_DESKTOP_API_URL` picks the backend for `start` and packaged builds, for
example `MARGIN_DESKTOP_API_URL=http://127.0.0.1:8787 bun run desktop:start`.
The default is `https://www.marginchat.com`, so the bundled client must stay
compatible with whatever production runs.

## Not done yet

- Signing and notarization: `dist:mac` builds an unsigned app. macOS will
  block it on first open (right-click > Open, or `xattr -dr
  com.apple.quarantine "/Applications/Margin Chat.app"`). Shipping it to
  others needs an Apple Developer ID certificate and notarization credentials
  passed to electron-builder.
- Installing updates: the web app's service worker update flow does not run
  under `margin://`. Instead the app compares its bundled `version.json` with
  production's every hour and, when production is newer (by commit time),
  shows an "Update available" dialog. "Download update" opens
  `MARGIN_DESKTOP_DOWNLOAD_URL` (default: the GitHub releases page). Builds are
  not published there yet, so installing still means rebuilding with
  `desktop:dist`; `electron-updater` with published builds would make it one
  click.
