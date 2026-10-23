const loginKey = "margin-chat:logged-in";

/**
 * Remembers, for this tab, that the account signed in with the login form rather than
 * signing up: an existing account, so an empty vault here means a new device.
 */
export function rememberLogin(userId: string) {
  try { sessionStorage.setItem(loginKey, userId); }
  catch { /* Without storage the new-device notice is skipped. */ }
}

/** Whether this tab's sign-in was a login, not a sign-up, for this account. */
export function loggedInThisTab(userId: string): boolean {
  try { return sessionStorage.getItem(loginKey) === userId; }
  catch { return false; }
}

export const NEW_DEVICE_NOTICE = "Documents from your other devices aren’t here. On the Free plan each browser keeps its own vault: use Download vault on the other device, then Import vault here.";
