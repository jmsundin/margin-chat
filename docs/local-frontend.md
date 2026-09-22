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
