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
  return {
    async connect(request) {
      const authorization = request.headers.authorization;
      if (
        typeof authorization !== "string" ||
        !/^Bearer mc_capture_[A-Za-z0-9_-]{43}$/u.test(authorization)
      ) {
        throw new HttpError(
          401,
          "Connect the extension with a valid capture key from your Cloud Inbox.",
        );
      }
      const user = await database.authenticateCaptureToken(
        hash(authorization.slice(7)),
      );
      if (!user)
        throw new HttpError(
          401,
          "Your capture key expired or was revoked. Reconnect in extension settings.",
        );
      requireCaptureAccess(user);
      return user;
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
