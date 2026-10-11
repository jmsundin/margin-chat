import { normalizeServerUrl } from "@margin-chat/capture-contracts";

// Set by scripts/build.mjs from MARGIN_EXTENSION_SERVER_URL for local development builds.
declare const __MARGIN_EXTENSION_SERVER_URL__: string | undefined;

// The extension is for paid cloud accounts, which all live on the hosted site.
export const MARGIN_CHAT_SERVER_URL = normalizeServerUrl(
  typeof __MARGIN_EXTENSION_SERVER_URL__ === "string" && __MARGIN_EXTENSION_SERVER_URL__
    ? __MARGIN_EXTENSION_SERVER_URL__
    : "https://www.marginchat.com",
);
