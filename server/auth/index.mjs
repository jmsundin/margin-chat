import { createHash, randomBytes, randomUUID } from "node:crypto";
import { createStatusError } from "../lib/errors.mjs";
import {
  createAuthSessionCookie,
  createClearedAuthSessionCookie,
  readAuthSessionId,
} from "./cookies.mjs";
import { hashPassword, verifyPassword, verifyPasswordAgainstDecoy } from "./passwords.mjs";
import { getPasswordResetEmailConfiguration, sendEmailChangedNotice, sendPasswordResetEmail } from "./passwordResetEmail.mjs";
import {
  normalizeAccountDeletionPayload,
  normalizeLoginPayload,
  normalizePasswordChangePayload,
  normalizePasswordResetConfirmPayload,
  normalizePasswordResetRequestPayload,
  normalizeProfileUpdatePayload,
  normalizeSignupPayload,
} from "./validation.mjs";

export function createAuthService({
  apiKeyService = null,
  database,
  env = process.env,
  runtimeConfig,
}) {
  async function decorateUser(user) {
    return apiKeyService ? apiKeyService.decorateUser(user) : user;
  }
  function hashResetToken(token) {
    return createHash("sha256").update(token).digest("hex");
  }

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
      // Signup does not prove ownership of the supplied email address. Admin
      // access is provisioned separately on a verified existing account.
      role: "member",
    });
    const cookie = await createSessionForUser(user.id);

    return {
      cookie,
      user: await decorateUser(user),
    };
  }

  async function authenticateCredentials(payload) {
    const input = normalizeLoginPayload(payload);
    const user = await database.findUserForLogin(input.email);

    const passwordMatches = user
      ? await verifyPassword(input.password, user.passwordHash)
      : await verifyPasswordAgainstDecoy(input.password);

    if (!user || !passwordMatches) {
      throw createStatusError(401, "Email or password is incorrect.");
    }

    return {
        billing: user.billing,
        displayName: user.displayName,
        email: user.email,
        id: user.id,
        role: user.role,
    };
  }

  async function login(payload) {
    const user = await authenticateCredentials(payload);
    return {
      cookie: await createSessionForUser(user.id),
      user: await decorateUser(user),
    };
  }

  async function requestPasswordReset(payload) {
    const input = normalizePasswordResetRequestPayload(payload);
    const emailConfiguration = getPasswordResetEmailConfiguration(env);
    const allowDevelopmentToken = !emailConfiguration.configured
      && [undefined, "", "development", "test"].includes(env.NODE_ENV)
      && !env.VERCEL && !env.VERCEL_ENV && !env.VERCEL_URL;

    if (!emailConfiguration.configured && !allowDevelopmentToken) {
      console.error(emailConfiguration.reason);
      throw createStatusError(503, "Password reset is temporarily unavailable. Please try again later.");
    }

    const user = await database.findUserForLogin(input.email);

    if (!user) {
      return { ok: true };
    }

    const token = randomBytes(32).toString("base64url");

    const tokenHash = hashResetToken(token);

    await database.createPasswordResetToken({
      expiresAt: new Date(Date.now() + runtimeConfig.passwordResetTtlMs),
      tokenHash,
      userId: user.id,
    });

    if (emailConfiguration.configured) {
      try {
        const delivery = await sendPasswordResetEmail({
          email: user.email,
          env,
          token,
          tokenHash,
          ttlMs: runtimeConfig.passwordResetTtlMs,
        });

        if (!delivery.delivered) {
          console.error(delivery.reason);
        }
      } catch (error) {
        console.error("Unable to send password reset email.", error);
      }
    }

    return {
      ok: true,
      ...(allowDevelopmentToken ? { resetToken: token } : {}),
    };
  }

  async function resetPassword(payload) {
    const input = normalizePasswordResetConfirmPayload(payload);
    const passwordHash = await hashPassword(input.password);

    await database.resetPasswordWithToken({
      passwordHash,
      tokenHash: hashResetToken(input.token),
    });

    return { ok: true };
  }

  async function changePassword(userId, sessionId, payload) {
    const input = normalizePasswordChangePayload(payload);
    const currentPasswordHash = await database.getUserPasswordHash(userId);

    if (!currentPasswordHash || !(await verifyPassword(input.currentPassword, currentPasswordHash))) {
      throw createStatusError(400, "Current password is incorrect.");
    }

    if (input.password === input.currentPassword) {
      throw createStatusError(400, "Choose a different password from your current password.");
    }

    const replacementSessionId = randomUUID();
    await database.changeUserPassword({
      currentPasswordHash,
      currentSessionId: sessionId,
      expiresAt: getSessionExpiryDate(),
      passwordHash: await hashPassword(input.password),
      replacementSessionId,
      userId,
    });

    return { cookie: createAuthSessionCookie(replacementSessionId, runtimeConfig), ok: true };
  }

  /** Checks a request to delete the account; returns the verified password hash for the delete itself. */
  async function verifyAccountDeletion(userId, payload) {
    const input = normalizeAccountDeletionPayload(payload);
    const passwordHash = await database.getUserPasswordHash(userId);

    if (!passwordHash || !(await verifyPassword(input.password, passwordHash))) {
      throw createStatusError(400, "Password is incorrect.");
    }

    return passwordHash;
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
      user: await decorateUser(authSession.user),
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

  /**
   * Changing the sign-in email needs the current password, and the old address
   * is told, so a stolen session can't move the account to another inbox.
   */
  async function updateProfile(userId, payload, { currentEmail } = {}) {
    const input = normalizeProfileUpdatePayload(payload);
    const emailChanged = typeof currentEmail === "string" && input.email !== currentEmail;

    if (emailChanged) {
      if (!input.currentPassword) {
        throw createStatusError(400, "Enter your current password to change your email.");
      }
      const passwordHash = await database.getUserPasswordHash(userId);
      if (!passwordHash || !(await verifyPassword(input.currentPassword, passwordHash))) {
        throw createStatusError(400, "Current password is incorrect.");
      }
    }

    const user = await decorateUser(await database.updateUserProfile({
      displayName: input.displayName,
      email: input.email,
      userId,
    }));

    if (emailChanged) {
      try {
        const delivery = await sendEmailChangedNotice({ env, newEmail: input.email, noticeId: randomUUID(), previousEmail: currentEmail });
        if (!delivery.delivered) console.error(delivery.reason);
      } catch (error) {
        console.error("Unable to send the email-changed notice.", error);
      }
    }

    return user;
  }

  function buildClearedSessionCookie() {
    return createClearedAuthSessionCookie(runtimeConfig);
  }

  return {
    authenticateCredentials,
    buildClearedSessionCookie,
    changePassword,
    getAuthContext,
    verifyAccountDeletion,
    login,
    logout,
    requestPasswordReset,
    resetPassword,
    signup,
    updateProfile,
  };
}
