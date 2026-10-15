// What the app's pages may use. Requests come from a page asking for something
// now; checks are Chromium asking whether something is already allowed, such as
// a vault folder chosen before, which it asks about with no page attached.

// Grant only what the vault, editor and voice typing use, and only to the app itself.
const ALLOWED_REQUESTS = new Set(["fileSystem", "clipboard-read", "clipboard-sanitized-write"]);

function microphoneOnly(permission, details) {
  return permission === "media" && Array.isArray(details?.mediaTypes) && details.mediaTypes.length > 0
    && details.mediaTypes.every((type) => type === "audio");
}

/** Whether a page at `pageUrl` may have `permission` when it asks for it. */
export function allowsPermissionRequest(permission, details, pageUrl, isAppUrl) {
  return (ALLOWED_REQUESTS.has(permission) || microphoneOnly(permission, details)) && isAppUrl(pageUrl);
}

/**
 * Whether `requestingOrigin` already has `permission`. A folder chosen before
 * stays allowed for the app itself, so the vault opens at launch without asking
 * again. Everything else keeps Electron's own answer.
 */
export function allowsPermissionCheck(permission, requestingOrigin, isAppUrl) {
  if (permission === "fileSystem") return typeof requestingOrigin === "string" && isAppUrl(requestingOrigin);
  return permission !== "deprecated-sync-clipboard-read";
}

/** Handlers for session.setPermissionRequestHandler and setPermissionCheckHandler. */
export function createPermissionHandlers(isAppUrl) {
  return {
    request(webContents, permission, callback, details) {
      callback(allowsPermissionRequest(permission, details, webContents.getURL(), isAppUrl));
    },
    // webContents is null when Chromium checks a restored folder.
    check(_webContents, permission, requestingOrigin) {
      return allowsPermissionCheck(permission, requestingOrigin, isAppUrl);
    },
  };
}
