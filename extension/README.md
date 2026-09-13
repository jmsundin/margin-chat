# Save to Margin · Chrome extension

Save selected passages, readable articles, and bookmarks to Margin Chat’s Cloud Inbox, with an optional personal note. Captures retain the source URL, title, and capture date. Chrome 127 or newer is required.

## Build and install locally

From the repository root:

```sh
bun install
bun run build:extension
```

1. Open `chrome://extensions` in Chrome and enable **Developer mode**.
2. Choose **Load unpacked** and select this repository’s `extension/dist` directory.
3. Pin **Save to Margin** to the toolbar.

The website and server must also run the capture API from this change. The existing schema initialization creates the two new capture tables. Cloud Inbox uses the same paid-plan/admin eligibility as cloud workspace storage.

## Connect and capture

1. In Margin Chat, click the **Cloud Inbox** tray icon beside New note in the sidebar.
2. Choose **Connect extension → Create capture key**. Copy the key.
3. In the extension’s **Settings**, enter the Margin Chat website’s origin (for example, your deployed HTTPS origin, or `http://localhost:5173` for local development) and paste the key.
4. Click **Connect** and grant access to that website. The key lasts 90 days. Replacing or revoking it in the Inbox disconnects existing installations using it.
5. Open a web page and click **Save to Margin**. Highlighted text is selected automatically; otherwise the clipper tries to extract the article. You can also choose Bookmark, or right-click highlighted text and choose **Save selection to Margin**.
6. Review the capture, adjust the title, add a comment, and click **Save to Cloud Inbox**.
7. Open the Inbox in Margin Chat, select the capture, then choose **Open as note** to edit it or use the existing note/chat workflow. The original stays in the Inbox. Reopening that capture preserves edits to its workspace note.

If Margin Chat is already open, use **Refresh** in its Inbox to see new captures.

## Reliability and permissions

- The extension communicates exclusively with the server API. It never connects to Postgres or holds model-provider keys.
- Capture credentials are hashed on the server. They authorize upload and connection status only; reading captures or accessing workspace/account/chat endpoints requires the website’s authenticated session.
- Chrome requests temporary access to the page on an explicit action (`activeTab`). Persistent host access is requested only for the Margin Chat hostname and scheme entered at connection time. Chrome host permissions cover all ports on that host; API requests use the exact configured origin and port.
- Credentials and pending saves are stored locally in Chrome, with access restricted to trusted extension contexts. They are not placed in Chrome Sync or exposed to content scripts.
- A pending save is persisted before upload. Closing the popup or interrupting the connection does not lose that pending capture. Reopen the popup and **Retry save**; the server reuses the same receipt without creating another capture. There is one pending save at a time and no background upload schedule. A pending save is bound to the connection that created it.
- Disconnect removes the browser’s credential and server permission. Revoke the key in Margin Chat to invalidate it everywhere. A pending draft stays until dismissed; uninstalling the extension removes its local storage.
- Page form fields, scripts, embedded frames, and images are excluded from article extraction. Only content you submit is uploaded. Capture itself makes no AI requests.
- Captures are stored independently of workspace snapshots. Whole-workspace saves, imports, and resets cannot erase the Inbox.

## Independent releases

The extension’s version lives in `extension/package.json`; it is written into the built manifest. Website builds stay independent (`bun run build`).

```sh
bun run release:extension
```

This builds and creates `extension/releases/margin-chat-<version>.zip`, containing only extension runtime assets. To release another version, update the extension package version, run tests and the build, inspect the unpacked extension in Chrome, and create a new archive. Uploading an archive to the Chrome Web Store is a separate manual publishing step. Store distribution also requires a listing and privacy disclosures matching the behavior above.

The `zip` utility is required for the release command. Rebuilding an unpacked installation requires clicking **Reload** on its card in `chrome://extensions`.

## Package boundaries and API compatibility

- `client/`: Margin Chat web app and Cloud Inbox.
- `server/`: authentication, capture API, and persistence.
- `extension/`: independent Chrome package, build, tests, and release archive.
- `packages/capture-contracts/`: browser-safe v1 payload validation, types, limits, paths, and Markdown conversion; no server or UI dependencies.

Installed extensions may lag behind the website. Keep `/api/v1` routes and required fields backward-compatible. Add optional fields for v1 evolution; introduce `/api/v2` for breaking changes while retaining v1 support.

| Route | Authentication | Behavior |
| --- | --- | --- |
| `GET /api/v1/capture-connection` | Capture bearer key | Display name and key expiry |
| `POST /api/v1/captures` | Capture bearer key | Save a v1 payload; return `{ capture: { id, createdAt } }` |
| `GET /api/v1/captures?cursor=…` | Web session | 30 capture summaries and an opaque next cursor |
| `GET /api/v1/captures/:id` | Web session | Owner-scoped full capture |
| `GET/POST/DELETE /api/settings/capture-token` | Web session | Read metadata, replace a key, or revoke it; writes require `X-Margin-Capture-Settings: 1` |

Uploads include `schemaVersion: 1`, `clientCaptureId`, `kind` (`selection`, `article`, `bookmark`), `title`, `sourceUrl`, `content` (Markdown), `comment` (plain text), and `capturedAt` (ISO date). Reusing an ID with a different payload returns 409. The limit is 200,000 content characters, 10,000 comment characters, 300 title characters, and 4,096 URL characters; the request byte limit is 1.5 MB. Unsupported versions return 400.

## Validation and current scope

```sh
bun test
bun run build
bun run build:extension
```

Capture integration tests run the real schema and repository queries in isolated PGlite/Postgres, with no access to the configured local or cloud database. They cover authentication scopes, token rotation/expiry/revocation, payload validation, pagination, duplicate retries, and workspace-save isolation.

This MVP captures text and links from normal web pages. PDFs, screenshots, images, transcripts, full-page archiving, automatic tagging, global semantic search, and Inbox deletion/archiving are outside this release. Complex sites may need selection or bookmark mode. The extension does not bypass site access controls. The popup preserves captures after Save is pressed; unfinished comments before submission are not yet persisted.
