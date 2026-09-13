import type { AuthenticatedUser } from "../types";

const KEY = "margin-chat-offline-identity";

/** Local workspace selection only. Server endpoints always enforce the real session cookie. */
export function rememberOfflineUser(user: AuthenticatedUser) {
  try { localStorage.setItem(KEY, JSON.stringify(user)); } catch { /* Local content may still save in OPFS. */ }
}

export function forgetOfflineUser() {
  try { localStorage.removeItem(KEY); } catch { /* Storage may be unavailable. */ }
}

export function loadOfflineUser(): AuthenticatedUser | null {
  try {
    const user = JSON.parse(localStorage.getItem(KEY) ?? "null");
    return user && typeof user.id === "string" && typeof user.email === "string" && user.billing && user.apiKeys ? user : null;
  } catch { return null; }
}
