import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { HttpError } from "../lib/errors.mjs";

const ALGORITHM = "aes-256-gcm";
const VERSION = "v1";

function getEncryptionKey(env) {
  const value = env.API_KEY_ENCRYPTION_KEY?.trim();

  if (!value) {
    throw new HttpError(
      503,
      "Personal API keys are not configured. Add API_KEY_ENCRYPTION_KEY to the server environment.",
    );
  }

  const key = /^[a-f\d]{64}$/iu.test(value)
    ? Buffer.from(value, "hex")
    : Buffer.from(value, "base64");

  if (key.length !== 32) {
    throw new HttpError(
      503,
      "API_KEY_ENCRYPTION_KEY must be a 32-byte base64 or 64-character hex value.",
    );
  }

  return key;
}

export function encryptSecret(value, env) {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGORITHM, getEncryptionKey(env), iv);
  const ciphertext = Buffer.concat([
    cipher.update(value, "utf8"),
    cipher.final(),
  ]);

  return [
    VERSION,
    iv.toString("base64url"),
    cipher.getAuthTag().toString("base64url"),
    ciphertext.toString("base64url"),
  ].join(":");
}

export function decryptSecret(value, env) {
  const [version, ivValue, authTagValue, ciphertextValue] = String(value).split(":");

  if (
    version !== VERSION ||
    !ivValue ||
    !authTagValue ||
    !ciphertextValue
  ) {
    throw new HttpError(500, "A saved personal API key has an invalid format.");
  }

  try {
    const decipher = createDecipheriv(
      ALGORITHM,
      getEncryptionKey(env),
      Buffer.from(ivValue, "base64url"),
    );
    decipher.setAuthTag(Buffer.from(authTagValue, "base64url"));

    return Buffer.concat([
      decipher.update(Buffer.from(ciphertextValue, "base64url")),
      decipher.final(),
    ]).toString("utf8");
  } catch (error) {
    if (error instanceof HttpError) {
      throw error;
    }

    throw new HttpError(
      500,
      "A saved personal API key could not be decrypted. Check API_KEY_ENCRYPTION_KEY.",
    );
  }
}
