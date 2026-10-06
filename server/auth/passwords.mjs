import {
  randomBytes,
  scrypt as scryptCallback,
  timingSafeEqual,
} from "node:crypto";
import { promisify } from "node:util";

const scrypt = promisify(scryptCallback);

export async function hashPassword(password) {
  const salt = randomBytes(16).toString("hex");
  const derivedKey = await scrypt(password, salt, 64);

  return `scrypt:${salt}:${Buffer.from(derivedKey).toString("hex")}`;
}

export async function verifyPassword(password, storedHash) {
  const [algorithm, salt, expectedKeyHex] = String(storedHash).split(":");

  if (
    algorithm !== "scrypt" ||
    !salt ||
    !expectedKeyHex ||
    expectedKeyHex.length % 2 !== 0
  ) {
    return false;
  }

  const expectedKey = Buffer.from(expectedKeyHex, "hex");
  const actualKey = Buffer.from(await scrypt(password, salt, expectedKey.length));

  if (expectedKey.length !== actualKey.length) {
    return false;
  }

  return timingSafeEqual(expectedKey, actualKey);
}

let decoyHash;

/**
 * Verifies against a throwaway hash so a login for an unknown email costs the
 * same scrypt work as one for a real account; response time must not reveal
 * which emails are registered.
 */
export async function verifyPasswordAgainstDecoy(password) {
  decoyHash ??= hashPassword(randomBytes(16).toString("hex"));
  await verifyPassword(password, await decoyHash);
  return false;
}
