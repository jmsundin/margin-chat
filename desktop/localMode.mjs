// Local mode: the app runs Margin Chat's own server inside itself (desktop/local-server/, built by
// scripts/build-desktop-server.mjs), so everything works on this computer with no account.
// See docs/desktop-local-mode.md.
import { randomBytes } from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import path from "node:path";

export const LOCAL_TOKEN_HEADER = "x-margin-local-token";

/**
 * The key that locks API keys saved in the local database. It is made once, then kept in a file that the
 * system keychain encrypts (Electron safeStorage), so a copy of the app's data folder alone can't unlock them.
 */
export async function loadLocalSecret({ dir, safeStorage, random = randomBytes }) {
  await mkdir(dir, { recursive: true });
  const lockedPath = path.join(dir, "secret.locked");
  const plainPath = path.join(dir, "secret.key");
  const canLock = Boolean(safeStorage?.isEncryptionAvailable?.());
  const existing = canLock
    ? await readFile(lockedPath).then((bytes) => safeStorage.decryptString(bytes), () => null)
    : null;
  if (existing) return existing.trim();
  // Linux without a keyring can't lock it; the file is then readable by this user only.
  const plain = await readFile(plainPath, "utf8").catch(() => null);
  if (plain?.trim()) {
    if (canLock) {
      await writeAtomically(lockedPath, safeStorage.encryptString(plain.trim()));
      await rm(plainPath, { force: true });
    }
    return plain.trim();
  }
  const secret = random(32).toString("base64");
  if (canLock) await writeAtomically(lockedPath, safeStorage.encryptString(secret));
  else {
    await writeAtomically(plainPath, secret);
    await chmod(plainPath, 0o600).catch(() => {});
  }
  return secret;
}

async function writeAtomically(filePath, data) {
  const temporary = `${filePath}.${process.pid}.tmp`;
  await writeFile(temporary, data, { mode: 0o600 });
  await rename(temporary, filePath);
}

/** Starts the in-app server. `loadServer` imports the bundle, so a missing build fails here and not at launch. */
export async function startLocalBackend({ dataDir, safeStorage, loadServer, random = randomBytes }) {
  const encryptionKey = await loadLocalSecret({ dir: path.join(dataDir, "keys"), safeStorage, random });
  // A new token each launch: only this process ever knows it.
  const token = random(32).toString("hex");
  const { startLocalServer } = await loadServer();
  const server = await startLocalServer({ dataDir, encryptionKey, token });
  return {
    origin: server.url,
    /** Requests from the app to its own server carry the token; nothing else on the computer does. */
    headers: { [LOCAL_TOKEN_HEADER]: token },
    ready: server.ready,
    close: server.close,
  };
}
