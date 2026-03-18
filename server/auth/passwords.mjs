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
