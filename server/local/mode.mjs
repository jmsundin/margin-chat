import { randomUUID } from "node:crypto";

/**
 * Local mode: the desktop app runs this server inside itself for one person, with no account.
 * Every request is that person; documents, keys and the database stay on their computer.
 */
export const LOCAL_USER_EMAIL = "you@this-computer.local";
export const LOCAL_USER_NAME = "You";

export function isLocalMode(env = process.env) {
  return env.MARGIN_LOCAL_MODE === "1";
}

/** Nothing is billed here: AI runs on the person's own keys, and their files are their own. */
export function localBilling() {
  return {
    accessKind: "local", cancelAtPeriodEnd: false, creditBalanceMicros: 0, currentPeriodEnd: null,
    hasAccess: false, hasCustomer: false, plan: null, priceId: null, status: "inactive",
    trialCallsLimit: 0, trialCallsRemaining: 0, trialCallsUsed: 0,
  };
}

export function isLocalUser(user) {
  return user?.billing?.accessKind === "local";
}

/** The one person on this computer, created the first time the app asks. */
export function createLocalUserSource(database) {
  let pending = null;
  async function load() {
    const existing = await database.findUserForLogin(LOCAL_USER_EMAIL);
    if (existing) {
      const { passwordHash: _unused, ...user } = existing;
      return user;
    }
    // Nobody signs in with this password: it is random and never stored anywhere else.
    return database.createUser({
      displayName: LOCAL_USER_NAME, email: LOCAL_USER_EMAIL, id: randomUUID(),
      passwordHash: `local:${randomUUID()}`, role: "member",
    });
  }
  return async function localUser() {
    pending ??= load().catch((error) => { pending = null; throw error; });
    const user = await pending;
    return { ...user, emailVerified: true, billing: localBilling() };
  };
}
