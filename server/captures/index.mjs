import { createHash, randomBytes } from "node:crypto";
import { normalizeCapture } from "@margin-chat/capture-contracts";
import { HttpError } from "../lib/errors.mjs";

const hash = (value) => createHash("sha256").update(value).digest("hex");
export function requireCaptureAccess(user) {
  if (user?.role !== "admin" && user?.billing?.accessKind !== "subscription") {
    throw new HttpError(
      403,
      "Cloud Inbox requires a paid plan or an admin account.",
    );
  }
}

export function createCaptureService({ database }) {
  async function issueSession(user, ttlMs, scope = "capture") {
    requireCaptureAccess(user);
    // Hash the complete token, including its capability prefix. Changing a
    // capture token's prefix can never turn it into a workspace credential.
    const token = `mc_${scope === "workspace" ? "workspace" : "extension"}_${randomBytes(32).toString("base64url")}`;
    const expiresAt = new Date(Date.now() + ttlMs);
    await database.createExtensionSession({ userId: user.id, tokenHash: hash(token), expiresAt });
    return {
      token,
      expiresAt: expiresAt.toISOString(),
      user: { id: user.id, displayName: user.displayName, email: user.email },
      ...(scope === "workspace" ? { scope } : {}),
    };
  }
  return {
    async connect(request) {
      const authorization = request.headers.authorization;
      if (
        typeof authorization !== "string" ||
        !/^Bearer mc_(capture|extension|workspace)_[A-Za-z0-9_-]{43}$/u.test(authorization)
      ) {
        throw new HttpError(
          401,
          "Sign in to Margin Chat in the extension settings.",
        );
      }
      const token = authorization.slice(7);
      const user = token.startsWith("mc_capture_")
        ? await database.authenticateCaptureToken(hash(token))
        : await database.authenticateExtensionSession(hash(token));
      if (!user)
        throw new HttpError(
          401,
          "Your session expired or was revoked. Sign in again in the extension settings, then retry your save.",
        );
      requireCaptureAccess(user);
      return user;
    },
    issueSession(user, ttlMs) {
      return issueSession(user, ttlMs);
    },
    issueWorkspaceSession(user, ttlMs) {
      return issueSession(user, ttlMs, "workspace");
    },
    async authenticateWorkspace(request) {
      const authorization = request.headers.authorization;
      if (typeof authorization !== "string" || !/^Bearer mc_workspace_[A-Za-z0-9_-]{43}$/u.test(authorization)) {
        throw new HttpError(401, "Sign in again to connect your extension to the Margin Chat workspace.");
      }
      const user = await database.authenticateExtensionSession(hash(authorization.slice(7)));
      if (!user) throw new HttpError(401, "Your workspace session expired or was revoked. Sign in again in extension settings.");
      requireCaptureAccess(user);
      return user;
    },
    async signOut(request) {
      const authorization = request.headers.authorization;
      if (typeof authorization !== "string" || !/^Bearer mc_(extension|workspace)_[A-Za-z0-9_-]{43}$/u.test(authorization)) {
        throw new HttpError(401, "A valid extension session is required to sign out.");
      }
      // Idempotent, even if expired, already revoked, or the account lost cloud access.
      await database.deleteExtensionSession(hash(authorization.slice(7)));
    },
    async issueToken(userId) {
      const token = `mc_capture_${randomBytes(32).toString("base64url")}`;
      const summary = await database.setCaptureToken({
        userId,
        tokenHash: hash(token),
        expiresAt: new Date(Date.now() + 90 * 86400_000),
      });
      return { token, summary };
    },
    async save(userId, input) {
      let capture;
      try {
        capture = normalizeCapture(input);
      } catch (error) {
        throw new HttpError(400, error.message);
      }
      return database.createCapture({
        userId,
        capture,
        payloadHash: hash(JSON.stringify(capture)),
      });
    },
    list(userId, encodedCursor) {
      let cursor = null;
      if (encodedCursor) {
        try {
          if (encodedCursor.length > 300) throw new Error();
          cursor = JSON.parse(
            Buffer.from(encodedCursor, "base64url").toString(),
          );
          if (
            !cursor ||
            typeof cursor.createdAt !== "string" ||
            !Number.isFinite(Date.parse(cursor.createdAt)) ||
            typeof cursor.id !== "string" ||
            !/^[0-9a-f-]{36}$/u.test(cursor.id)
          )
            throw new Error();
          cursor.createdAt = new Date(cursor.createdAt).toISOString();
        } catch {
          throw new HttpError(400, "Invalid Inbox page cursor.");
        }
      }
      return database.listCaptures({ userId, cursor });
    },
  };
}
