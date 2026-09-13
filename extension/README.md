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

The website and server must also run the capture API from this change. The existing schema initialization creates the capture and extension-session tables; deploy the server update before installing extension 0.2.0. Cloud Inbox uses the same paid-plan/admin eligibility as cloud workspace storage.

## Connect and capture

1. Open the extension’s **Settings** and enter your Margin Chat website’s origin (for example, your deployed HTTPS origin, or `http://localhost:5173` for local development). The website address is also shown under **Cloud Inbox → Connect extension** in Margin Chat.
2. Enter the **email address and password** you use for Margin Chat, click **Sign in**, and grant access to that website. Margin Chat uses email addresses as account identifiers; there is no separate extension username or key to create.
3. Open a web page and click **Save to Margin**. Highlighted text is selected automatically; otherwise the clipper tries to extract the article. You can also choose Bookmark, or right-click highlighted text and choose **Save selection to Margin**.
4. Review the capture, adjust the title, add a comment, and click **Save to Cloud Inbox**.
5. Open the Inbox in Margin Chat, select the capture, then choose **Open as note** to edit it or use the existing note/chat workflow. The original stays in the Inbox. Reopening that capture preserves edits to its workspace note.

Sign out from the extension’s Settings. Sessions expire according to the server’s `AUTH_SESSION_DAYS` setting (30 days by default). If a session expires, sign in again and retry your pending save. Use the website to create an account or reset a forgotten password.

If Margin Chat is already open, use **Refresh** in its Inbox to see new captures.

## Reliability and permissions

- The extension communicates exclusively with the server API. It never connects to Postgres or holds model-provider keys.
- Passwords are sent only to the configured Margin Chat origin during sign-in and are never stored by the extension. Each browser receives an independent session; signing in on another browser does not disconnect existing browsers. Session credentials are hashed on the server. They authorize upload and connection status only; reading captures or accessing workspace/account/chat endpoints requires the website’s authenticated session.
- Chrome requests temporary access to the page on an explicit action (`activeTab`). Persistent host access is requested only for the Margin Chat hostname and scheme entered at connection time. Chrome host permissions cover all ports on that host; API requests use the exact configured origin and port.
- Session credentials and pending saves are stored locally in Chrome, with access restricted to trusted extension contexts. They are not placed in Chrome Sync or exposed to content scripts.
- A pending save is persisted before upload. Closing the popup or interrupting the connection does not lose that pending capture. Reopen the popup and **Retry save**; the server reuses the same receipt without creating another capture. There is one pending save at a time and no background upload schedule. A pending save is bound to its server origin and account, so signing back into the same account can recover it; switching accounts cannot upload it to a different Inbox.
- Sign-out revokes that browser’s session and removes its local credential and server permission. If the server is unreachable, the local sign-out still completes and explains that server revocation could not finish. Resetting the account password revokes all extension sessions and legacy capture keys. A pending draft stays until dismissed; uninstalling the extension removes its local storage.
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
| `POST /api/v1/extension-session` | Email and password | Create a capture-only session; return `{ token, user: { id, displayName, email }, expiresAt }`, without a web cookie |
| `DELETE /api/v1/extension-session` | Extension bearer session | Revoke that session (idempotent) |
| `GET /api/v1/capture-connection` | Extension session or legacy key | User ID, display name, and session expiry |
| `POST /api/v1/captures` | Extension session or legacy key | Save a v1 payload; return `{ capture: { id, createdAt } }` |
| `GET /api/v1/captures?cursor=…` | Web session | 30 capture summaries and an opaque next cursor |
| `GET /api/v1/captures/:id` | Web session | Owner-scoped full capture |
| `GET/POST/DELETE /api/settings/capture-token` | Web session (legacy v0.1 clients) | Read metadata, replace a key, or revoke it; writes require `X-Margin-Capture-Settings: 1` |

The manual-key settings UI has been removed. Existing v0.1 clients and keys remain supported by the server until expiry/revocation. On upgrade, sign in through the new Settings form. An existing pending draft is migrated only if its old key can still verify ownership of that same account.

Uploads include `schemaVersion: 1`, `clientCaptureId`, `kind` (`selection`, `article`, `bookmark`), `title`, `sourceUrl`, `content` (Markdown), `comment` (plain text), and `capturedAt` (ISO date). Reusing an ID with a different payload returns 409. The limit is 200,000 content characters, 10,000 comment characters, 300 title characters, and 4,096 URL characters; the request byte limit is 1.5 MB. Unsupported versions return 400.

Extension tests cover permission denial, failed sign-in, password clearing, offline sign-out, draft recovery after renewal, legacy draft migration, and account changes while a popup is open.

## Validation and current scope

```sh
bun test
bun run build
bun run build:extension
```

Capture integration tests run the real schema and repository queries in isolated PGlite/Postgres, with no access to the configured local or cloud database. They cover password sign-in, independent sessions, sign-out, password-reset revocation, authentication scopes, legacy token rotation/expiry/revocation, payload validation, pagination, duplicate retries, and workspace-save isolation.

This MVP captures text and links from normal web pages. PDFs, screenshots, images, transcripts, full-page archiving, automatic tagging, global semantic search, and Inbox deletion/archiving are outside this release. Complex sites may need selection or bookmark mode. The extension does not bypass site access controls. The popup preserves captures after Save is pressed; unfinished comments before submission are not yet persisted.
