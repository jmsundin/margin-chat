import { apiStorageNamespace } from "./apiTransport";
import type { AuthenticatedUser } from "../types";

const key = () => apiStorageNamespace("margin-chat-offline-identity");

/** Local workspace selection only. Server endpoints always enforce the real session cookie. */
export function rememberOfflineUser(user: AuthenticatedUser) {
  try { localStorage.setItem(key(), JSON.stringify(user)); } catch { /* Local content may still save in OPFS. */ }
}

export function forgetOfflineUser() {
  try { localStorage.removeItem(key()); } catch { /* Storage may be unavailable. */ }
}

export function loadOfflineUser(): AuthenticatedUser | null {
  try {
    const user = JSON.parse(localStorage.getItem(key()) ?? "null");
    return user && typeof user.id === "string" && typeof user.email === "string" && user.billing && user.apiKeys ? user : null;
  } catch { return null; }
}
