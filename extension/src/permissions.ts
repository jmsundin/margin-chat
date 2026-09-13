import { normalizeServerUrl } from "@margin-chat/capture-contracts";

// Chrome host permissions cover all ports on a host. Keep the exact port only
// in the API destination so changing dev ports cannot revoke the new grant.
export function serverPermissionPattern(serverUrl: string) {
  const url = new URL(normalizeServerUrl(serverUrl));
  return `${url.protocol}//${url.hostname}/*`;
}
