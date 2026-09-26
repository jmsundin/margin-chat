# Local frontend with the production backend

Add this server-side development setting to the repository's ignored `.env.development.local` file:

```dotenv
BACKEND_URL=https://www.marginchat.com
```

Start the frontend from the repository root:

```sh
bun run dev:client
```

Open `http://localhost:5173/` and log in with your existing production account. The development proxy forwards `/api` requests to the production service, including authentication and streaming responses. Localhost has its own browser session, so signing in on the production website does not automatically sign you in locally. Changes made in the local app are saved to your production account.

The proxy keeps requests same-origin and rewrites cookie domains for localhost while preserving HttpOnly, SameSite, and Secure attributes. Backend credentials stay on the production server; do not put credentials or this setting in a `VITE_` variable. A local API server or database is unnecessary for this mode.

Check the connection at `http://localhost:5173/api/health`. It should return the production backend's `status: "ok"` response. The local frontend uses the deployed API version; features that depend on undeployed server changes require a matching backend deployment.

To use the local backend again, remove `BACKEND_URL` from `.env.development.local` and restart Vite. `/api` will use `http://127.0.0.1:${BACKEND_PORT}` (port 8787 by default). Run `bun run dev` to start both local processes.

## Test password changes before deploying the API

The profile form requires `POST /api/auth/password/change`. A newer local frontend connected to an older deployed API receives a 404 when a signed-in user submits this form.

To test this endpoint locally while keeping other requests on the configured hosted backend, add this development-only override to `.env.development.local`:

```dotenv
PASSWORD_CHANGE_BACKEND_URL=http://127.0.0.1:8787
```

Run the matching local API and restart Vite. The local API must use the same account database as the hosted API so it can authenticate the existing session. This changes the password on that shared account database and signs out its other sessions. Other API requests continue to use `BACKEND_URL`. Cookie forwarding and domain rewriting work the same way for both targets.

Remove the override after deploying the matching password-change API. This setting does not affect production builds or publish the backend.
