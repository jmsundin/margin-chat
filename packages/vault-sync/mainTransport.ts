/**
 * The cloud transport for the desktop app's main process. The client's own
 * transport (`client/src/lib/vaultApi.ts`) is reused; only its fetch changes:
 * requests go through Electron's `net.fetch` with the app's session cookie jar,
 * so the credential never leaves the main process, as `/api` requests from the
 * page already don't (`desktop/main.mjs`).
 */
import { setApiTransport } from "../../client/src/lib/apiTransport";
import { createVaultTransport } from "../../client/src/lib/vaultApi";
import type { VaultTransport } from "../../client/src/lib/vaultTypes";

export interface MainTransportOptions {
  /** Electron's `net.fetch`, or any fetch that carries the session. Receives absolute URLs. */
  fetchImpl: (url: string, init?: RequestInit) => Promise<Response>;
  /** The backend's origin, e.g. https://www.marginchat.com. */
  serverUrl: string;
  userId: string;
  onProjectionStatus?: (status: "pending" | "ready") => void;
}

export function createMainTransport({ fetchImpl, serverUrl, userId, onProjectionStatus }: MainTransportOptions): VaultTransport {
  const origin = serverUrl.replace(/\/$/u, "");
  // The client's api module is a singleton; in this process there is one backend, so one transport.
  setApiTransport({
    serverUrl: origin,
    fetch: (input, init) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url;
      return fetchImpl(new URL(url, `${origin}/`).toString(), { ...init, credentials: "include" });
    },
  });
  return createVaultTransport(userId, onProjectionStatus);
}
