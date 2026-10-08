# Margin Chat · Chrome extension

Extension **0.3.0** opens the current Margin Chat workspace above a web page. Highlight and comment on passages, save a readable page or link, edit documents, and ask AI without leaving the page. Captures retain the source URL, title, and capture date. Chrome 127 or newer is required.

The extension bundles the same `App` and `WorkspaceApp` used by the website into an extension-origin `workspace.html` iframe. Its document editors, notes, model controls, AI streaming and branching, workspace search, and Markdown vault sync use the current application code. The visited page hosts the layout controls and passage highlights; private workspace editors run inside the separate extension origin.

Choose **Docked**, **Floating**, **Expanded**, or **Peek at page** from the ⋮ menu beside the close button; the header stays one slim row. All layouts keep the same live workspace mounted. Drag the floating header or resize its corner. Expanded leaves a strip of the source visible; **Uncover page** or **Peek** reveals the page, and **Return to Margin** restores the workspace. Changing layouts does not create another capture or AI request.

Community discussions are not part of the extension yet, so there is no Community control. See the [third-space design and implementation notes](../docs/browser-third-space.md).

## Ask about the page

Click the toolbar button once on a page to arm it; select text and a small popover offers **Explain** and **Ask…**. The answer streams into a card beside the passage, using the passage as the focus and the readable page as context. Choose **Pin as margin note** to leave a marker in the page's right margin and a dotted underline under the passage, or **Open in workspace** to continue it as a chat. Answers are saved to your workspace automatically. The card, your question and the answer live in the extension's own frame; the page itself never contains them. See the [design and implementation notes](../docs/extension-page-ai.md).

## Build, install, and upgrade

From the repository root:

```sh
bun install
bun run build:extension
```

1. Deploy the compatible website and API before updating the installed extension. Version 0.3.0 adds workspace-session routes and scoped access to existing application APIs. It reuses the existing extension-session table and requires no new database migration.
2. Open `chrome://extensions` and enable **Developer mode**.
3. Choose **Load unpacked** and select `extension/dist`. For an existing unpacked installation, click **Reload** on its card after rebuilding.
4. Pin **Margin Chat**, reopen the source page if needed, and open the extension's **Settings**.
5. Choose **Workspace + AI + capture** and sign in again. Existing sessions retain capture-only access; upgrading the package never silently expands their permissions.

Both capture-only and workspace sign-in currently require a paid subscription or admin account, matching Cloud Inbox eligibility. Although the website supports local workspaces for other accounts, 0.3.0 does not provide a free-account or signed-out local workspace through the extension.

## Connect and work above a page

1. Enter your Margin Chat website origin in extension **Settings**, such as your HTTPS deployment or `http://localhost:5173`. The address also appears under **Cloud Inbox → Connect extension** on the website.
2. Enter your Margin Chat email and password, choose **Workspace + AI + capture**, click **Sign in**, and grant access to that website. The password is sent to that configured origin and is not stored.
3. Open a normal web page and click the Margin Chat toolbar button. Select a passage on the page, or right-click selected text and choose **Annotate in Margin Chat**.
4. Open **Page context**. Choose **Selected passage**, **Readable page**, or **Link only**, and review the source preview. In **Annotate / save**, add an optional thought and choose **Save & open document**. The capture is saved to Cloud Inbox and imported as an editable source document in the workspace below.
5. Choose **Ask page** or **Ask AI**, review the source and question, and press **Save source & ask AI**. That explicit submission saves the source, opens its document, and starts the current Margin Chat document AI flow in the same overlay. Selecting text, opening Ask, saving a note, or switching layouts does not itself call AI.
6. Continue editing, following up, choosing models, branching conversations, or searching your existing workspace using the normal Margin Chat controls. Source metadata remains in the imported document. Reopening the same saved capture preserves edits already made to that document.

Thoughts and AI questions keep separate drafts. **Saved on this page → Find on page** locates a saved passage when its anchor can still be resolved. An altered or ambiguous passage keeps its saved text without guessing a replacement location.

The extension mounts on an explicit toolbar or context-menu action and must be reopened after a full navigation. Version 0.3.0 targets normal Chrome windows; its workspace iframe does not support incognito mode. Browser-restricted surfaces and selections inside embedded frames use the original capture popup where possible. Some Chrome surfaces cannot be read or overlaid at all; complex sites may require selected-passage or link-only capture.

Use extension Settings to sign out or change connections. Sessions use the server's `AUTH_SESSION_DAYS` lifetime, 30 days by default. Expired sessions require another sign-in. Account creation, password reset, account/security changes, API-key changes, and billing purchases remain on the website; workspace controls open the relevant website settings. Normal AI usage still follows the account's configured models, keys, and billing rules.

## Storage, isolation, and permissions

- The workspace iframe is bundled extension code, not a remotely embedded website. The visited page cannot read its private editor DOM through ordinary page scripting. The frame connects through a broker bound to its tab, page, and frame session; credentials are not sent to the page or content scripts.
- The extension talks to the server API, never directly to Postgres or model providers. Native authenticated requests preserve streamed AI responses and cancellation. The website continues to use its normal same-origin transport.
- Chrome grants temporary page access through `activeTab`. Persistent host permission is requested only for the configured Margin Chat hostname and scheme; API requests use the exact configured origin and port. Chrome's host permission itself covers all ports on that host.
- Passwords are never stored. Session tokens are local to trusted extension contexts, not Chrome Sync; the server stores their hashes. Each browser receives an independent session. Resetting the account password revokes extension sessions and legacy capture keys.
- Documents use the current Markdown vault: local browser files first, then file-level cloud sync and conflict handling. Website and extension origins have separate local stores and exchange documents through the cloud. Extension storage is scoped by server and account; switching accounts does not hydrate the previous account's offline workspace. Clearing extension storage or uninstalling removes local copies, so retain independent vault exports where needed.
- Source drafts, annotations, and quote anchors are local to this browser, account/server, and exact visited URL. Anchors do not yet synchronize across browsers or merge URL variants. Captured content and comments are saved in Cloud Inbox; imported documents then participate in workspace sync.
- A pending capture is persisted before upload and bound to its server and account. Retry reuses its capture ID. There is one pending save at a time, with no background upload schedule; another page's pending capture must be reviewed first. The fallback popup persists its capture only after Save is pressed.
- Signing out in Settings removes the local credential and server permission and attempts server revocation. An unreachable server does not prevent local sign-out; the remaining server session expires normally. Local drafts are retained for the same connection until dismissed or extension storage is removed.
- Article extraction excludes form fields, scripts, embedded frames, and images. Only submitted capture content is uploaded. Capture by itself does not invoke AI. Source text supplied to AI is reference material, not trusted instructions.
- Captures remain separate from workspace snapshots. Workspace imports, resets, or whole-workspace saves cannot erase Cloud Inbox captures.

## Authentication and API compatibility

Installed extensions may lag behind the website. Keep existing `/api/v1` routes and required fields backward-compatible. Add optional fields for v1 evolution; use a new API version for breaking changes.

| Route or capability | Authentication | Behavior |
| --- | --- | --- |
| `POST /api/v1/extension-session` | Email and password | Issues a capture-only `mc_extension_…` session without a website cookie. |
| `POST /api/v1/extension-workspace-session` | Email and password | Issues a distinct `mc_workspace_…` session with `scope: "workspace"`; requires paid/admin capture eligibility. |
| `DELETE /api/v1/extension-session` | Capture or workspace session | Revokes that session idempotently. |
| `GET /api/v1/capture-connection` | Capture/workspace session or legacy key | Returns connection identity and expiry. |
| `POST /api/v1/captures` | Capture/workspace session or legacy key | Saves a validated source and returns its receipt. |
| `GET /api/v1/captures?cursor=…`, `GET /api/v1/captures/:id` | Website session or workspace session | Reads owner-scoped capture summaries or source content. |
| Workspace document, Markdown vault, chat, search, and graph APIs | Website session or scoped workspace session | Reuses current application routes with account checks; workspace sessions authorize only their explicit route allowlist. |
| Account/security/API-key mutations and billing purchases | Website session | Remain website-only. The extension can read its current account and billing state. |
| `/api/settings/capture-token` | Website session | Maintains legacy capture-key support and its existing settings-write checks. |

Legacy `mc_capture_…` keys and existing `mc_extension_…` sessions do not gain document-reading or AI access. Sign in again with **Workspace + AI + capture** to opt in. Existing legacy pending drafts migrate only when their previous credential can verify the same owner.

Capture payloads contain `schemaVersion: 1`, `clientCaptureId`, `kind` (`selection`, `article`, or `bookmark`), `title`, `sourceUrl`, Markdown `content`, plain-text `comment`, and ISO `capturedAt`. Reusing an ID with a different payload returns 409. Limits remain 200,000 content characters, 10,000 comment characters, 300 title characters, 4,096 URL characters, and 1.5 MB per request. Unsupported versions return 400.

## Release package

The independent extension version is in `extension/package.json` and copied into the built manifest. Website builds remain separate.

```sh
bun run release:extension
```

This builds `extension/dist` and creates `extension/releases/margin-chat-0.3.0.zip` using the system `zip` utility. The archive contains extension runtime assets, including the bundled workspace and local fonts. Uploading it to the Chrome Web Store is a separate publishing step, with listing/privacy disclosures that match the extension's behavior.

## Original design preview

```sh
bun extension/scripts/preview.mjs
```

The preview at `http://127.0.0.1:5194/` retains the **original design demo**, implemented by `overlay-ui.ts`. It uses a sample article and in-memory saves, with no server, AI, or social requests. It does not render the new bundled `App`/`WorkspaceApp` integration, is excluded from the release package, and is not proof that the installed extension works in Chrome. Set `MARGIN_PREVIEW_PORT` to change its port.

## Validation and manual Chrome smoke test

```sh
bun test
bun run build
bun run build:extension
```

Automated coverage includes session capability boundaries, password-reset revocation, account changes, frame-broker validation, API transport/streaming, source import after vault hydration, retry behavior, and reused client flows. Database integration tests use isolated fixtures rather than the configured local or cloud database.

An installed Chrome runtime has **not been verified in this implementation session**; the available browser tool could not run Chrome extension pages. Complete this manual check against the updated website/API before treating the package as release-accepted:

1. Load or reload 0.3.0 in Chrome. Confirm the version and sign in through **Workspace + AI + capture** using an eligible test account. Confirm a retained capture-only session requests an explicit new sign-in for workspace access.
2. Open a normal article, select a passage, inspect its preview, add a thought, and save. Confirm its highlight, Inbox receipt, and editable source document. Repeat with readable-page and link-only context.
3. Submit **Save source & ask AI**. Confirm the response streams in the same overlay, retains the source, accepts follow-ups, and supports stopping a response. Verify simply opening Ask makes no AI request.
4. Edit the imported document in the extension and open it on the website. Sync in both directions. Make overlapping edits in both surfaces and verify the existing conflict workflow preserves both versions or resolves them explicitly.
5. Switch among Docked, Floating, and Expanded while editing and during a response. Move/resize the floating surface, peek at the page, and return. Confirm the live document, draft, and conversation remain intact and no request is duplicated.
6. Reopen a source URL and locate its saved passage. Navigate to a different URL, including a same-page application route, and confirm the old draft is not attached to the new source. Check popup fallback on a restricted surface or embedded-frame selection.
7. Switch servers/accounts, including while requests are pending and while offline. Confirm private documents, drafts, and pending captures never appear under another connection. Verify account/security/API-key and billing actions open the website.

Remaining scope includes synchronized anchors, live Community, PDF-specific capture, screenshots/images, transcripts, full-page archiving, automatic capture tagging, and Inbox deletion/archiving. The extension does not bypass website access controls. Keyboard repositioning, detailed focus restoration, and every site-specific layout interaction are not asserted as completed acceptance work.
