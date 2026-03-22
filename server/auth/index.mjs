import { randomUUID } from "node:crypto";
import { createStatusError } from "../lib/errors.mjs";
import {
  createAuthSessionCookie,
  createClearedAuthSessionCookie,
  readAuthSessionId,
} from "./cookies.mjs";
import { hashPassword, verifyPassword } from "./passwords.mjs";
import {
  normalizeLoginPayload,
  normalizeProfileUpdatePayload,
  normalizeSignupPayload,
} from "./validation.mjs";

const ADMIN_EMAILS = new Set(["sundinjon@gmail.com"]);

function resolveUserRole(email) {
  return ADMIN_EMAILS.has(String(email).trim().toLowerCase())
    ? "admin"
    : "member";
}

export function createAuthService({ database, runtimeConfig }) {
  function getSessionExpiryDate() {
    return new Date(Date.now() + runtimeConfig.authSessionTtlMs);
  }

  async function createSessionForUser(userId) {
    const sessionId = randomUUID();

    await database.createAuthSession({
      expiresAt: getSessionExpiryDate(),
      id: sessionId,
      userId,
    });

    return createAuthSessionCookie(sessionId, runtimeConfig);
  }

  async function signup(payload) {
    const input = normalizeSignupPayload(payload);
    const passwordHash = await hashPassword(input.password);
    const user = await database.createUser({
      displayName: input.displayName,
      email: input.email,
      id: randomUUID(),
      passwordHash,
      role: resolveUserRole(input.email),
    });
    const cookie = await createSessionForUser(user.id);

    return {
      cookie,
      user,
    };
  }

  async function login(payload) {
    const input = normalizeLoginPayload(payload);
    const user = await database.findUserForLogin(input.email);

    if (!user || !(await verifyPassword(input.password, user.passwordHash))) {
      throw createStatusError(401, "Email or password is incorrect.");
    }

    const cookie = await createSessionForUser(user.id);

    return {
      cookie,
      user: {
        billing: user.billing,
        displayName: user.displayName,
        email: user.email,
        id: user.id,
        role: user.role,
      },
    };
  }

  async function getAuthContext(request) {
    const sessionId = readAuthSessionId(request);

    if (!sessionId) {
      return {
        sessionId: null,
        shouldClearSession: false,
        user: null,
      };
    }

    const authSession = await database.getUserByAuthSession(sessionId);

    if (!authSession) {
      return {
        sessionId,
        shouldClearSession: true,
        user: null,
      };
    }

    return {
      sessionId,
      shouldClearSession: false,
      user: authSession.user,
    };
  }

  async function logout(request) {
    const sessionId = readAuthSessionId(request);

    if (sessionId) {
      await database.deleteAuthSession(sessionId);
    }

    return {
      cookie: createClearedAuthSessionCookie(runtimeConfig),
    };
  }

  async function updateProfile(userId, payload) {
    const input = normalizeProfileUpdatePayload(payload);

    return database.updateUserProfile({
      displayName: input.displayName,
      email: input.email,
      userId,
    });
  }

  function buildClearedSessionCookie() {
    return createClearedAuthSessionCookie(runtimeConfig);
  }

  return {
    buildClearedSessionCookie,
    getAuthContext,
    login,
    logout,
    signup,
    updateProfile,
  };
}
