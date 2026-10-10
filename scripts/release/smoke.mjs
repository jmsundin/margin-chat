import assert from "node:assert/strict";
import { randomUUID, randomBytes } from "node:crypto";
import { setTimeout as delay } from "node:timers/promises";
import { hashPassword } from "../../server/auth/passwords.mjs";
import { digest } from "../../server/vault/storage.mjs";

export async function checkReadiness({ baseUrl, expectedSha, fetchImpl = fetch, bypassSecret, requestTimeoutMs = 60_000 }) {
  const response = await fetchImpl(new URL("/api/health", baseUrl), {
    headers: bypassSecret ? { "x-vercel-protection-bypass": bypassSecret } : {},
    redirect: "error", signal: AbortSignal.timeout(requestTimeoutMs),
  });
  assert.equal(response.status, 200, "Database readiness failed.");
  const payload = await response.json();
  assert.equal(payload.storage?.postgres?.ready, true, "Database is not ready.");
  assert.equal(payload.storage?.vault?.configured, true, "Vault is not configured.");
  assert.equal(payload.storage?.vault?.kind, "blob", "Production release requires Blob storage.");
  if (expectedSha) assert.equal(payload.release, expectedSha, "The URL is serving a different release.");
  return { database: "ready", vault: "configured", release: payload.release };
}

/** Promotion can finish before the public origin stops serving the old release. */
export async function waitForProductionReadiness({ expectedSha, previousSha, previousUnidentified = false, assertLock = async () => {},
  sleep = delay, now = Date.now, timeoutMs = 180_000, pollMs = 1_000, ...options }) {
  if (!expectedSha || !(timeoutMs > 0) || !(pollMs > 0)) throw new Error("Invalid production readiness polling options.");
  const deadline = now() + timeoutMs;
  while (now() < deadline) {
    await assertLock();
    const remaining = deadline - now();
    if (remaining <= 0) break;
    const result = await checkReadiness({ ...options, requestTimeoutMs: Math.min(60_000, remaining) });
    if (now() >= deadline) break;
    if (result.release === expectedSha) return result;
    // Only the known previous release is a propagation delay. Missing identity,
    // an unrelated release, and unhealthy storage must still fail immediately,
    // except that a previous deployment made outside the release runner (e.g.
    // `vercel --prod`) reports no identity, so that is its known signature.
    const isPrevious = previousSha ? result.release === previousSha : previousUnidentified && result.release == null;
    if (!isPrevious) throw new Error("The production URL is serving an unexpected release after promotion.");
    await sleep(Math.min(pollMs, Math.max(1, deadline - now())));
  }
  throw new Error("Timed out waiting for the production URL to serve the promoted release.");
}

/** A fresh synthetic account owns every write. Never accepts an existing user ID. */
export async function runPersistenceSmoke({ baseUrl, database, client, blobToken, storagePrefix = "", bypassSecret, fetchImpl = fetch, blobSdk }) {
  const id = `release-smoke-${randomUUID()}`;
  const email = `${id}@example.invalid`;
  const password = randomBytes(32).toString("base64url");
  const prefix = `${storagePrefix}vaults/v1/${digest(id)}/`;
  const sdk = blobSdk ?? await import("@vercel/blob");
  let cookie;
  let created = false;
  let failure;
  async function request(path, { method = "GET", body, headers = {}, expected = 200, raw = false } = {}) {
    const response = await fetchImpl(new URL(path, baseUrl), {
      method, redirect: "error", signal: AbortSignal.timeout(60_000),
      headers: { ...(bypassSecret ? { "x-vercel-protection-bypass": bypassSecret } : {}),
        ...(cookie ? { Cookie: cookie, "X-Margin-Vault-User": id } : {}),
        ...(body !== undefined && !raw ? { "Content-Type": "application/json" } : {}), ...headers },
      body: body === undefined ? undefined : raw ? body : JSON.stringify(body),
    });
    assert.equal(response.status, expected, `Persistence smoke request failed: ${method} ${path.split("?")[0]}`);
    return response;
  }
  function projection(result) {
    assert.equal(result.projection?.status, "ready", "Vault projection is pending.");
    assert.equal(result.projection.revision, result.manifest.revision, "Projection revision mismatch.");
    return result;
  }
  // The app indexes a save in the background (status "queued"), so a save only
  // has to name its own revision; the reload below waits for the index.
  function saved(result) {
    if (result.projection?.status !== "queued") return projection(result);
    assert.equal(result.projection.revision, result.manifest.revision, "Projection revision mismatch.");
    return result;
  }
  try {
    await database.createUser({ id, email, displayName: "Automated release check", role: "admin", passwordHash: await hashPassword(password) });
    created = true;
    const login = await request("/api/auth/login", { method: "POST", body: { email, password } });
    cookie = login.headers.get("set-cookie")?.split(";")[0];
    assert.ok(cookie, "Login did not create a session.");
    assert.equal((await login.json()).user.id, id, "Login returned an unexpected account.");
    const path = "Notes/release-check.md";
    const content = "# Release check\n\nPersistence round trip — café.\n";
    const commit = async (changes, expected = 200) => request("/api/vault/commit", { method: "POST", body: { changes }, expected });
    const first = saved(await (await commit([{ path, content, baseRevision: null }])).json());
    const revision = first.manifest.files[path].revision;
    assert.equal(await (await request(`/api/vault/file?${new URLSearchParams({ path, revision })}`)).text(), content);
    const updated = saved(await (await commit([{ path, content: `${content}Updated.\n`, baseRevision: revision }])).json());
    await commit([{ path, content: "Stale update", baseRevision: revision }], 409);
    assert.equal(await (await request(`/api/vault/file?${new URLSearchParams({ path, revision })}`)).text(), content, "Immutable history changed.");
    const binaryPath = "Attachments/release-check/original.bin";
    const bytes = Buffer.from([0, 255, 17, 128, 13, 10]);
    const binary = saved(await (await request(`/api/vault/file?${new URLSearchParams({ path: binaryPath })}`, {
      method: "PUT", raw: true, body: bytes,
      headers: { "Content-Type": "application/octet-stream", "X-Margin-Vault-Write": "1" },
    })).json());
    assert.deepEqual(Buffer.from(await (await request(`/api/vault/file?${new URLSearchParams({ path: binaryPath })}`)).arrayBuffer()), bytes);
    const deleted = saved(await (await commit([{ path, content: null, baseRevision: updated.manifest.files[path].revision },
      { path: binaryPath, content: null, baseRevision: binary.manifest.files[binaryPath].revision }])).json());
    assert.equal(deleted.manifest.files[path].deleted, true, "Missing deletion tombstone.");
    const reloaded = projection(await (await request("/api/vault")).json());
    assert.equal(reloaded.manifest.revision, deleted.manifest.revision);
    assert.equal(await database.getVaultProjectionRevision(id), deleted.manifest.revision, "Deployed API and runner are not using the same database.");
    return { checks: ["login", "save/read", "stale-write rejection", "immutable history", "binary round trip", "tombstones", "SQL projection"] };
  } catch (error) { failure = error; throw error; }
  finally {
    if (created) {
      try {
        // Explicitly remove legacy tables without user foreign keys, then account cascades.
        await client.query("begin");
        try {
          for (const table of ["marginchat_user_sessions", "marginchat_password_reset_tokens", "marginchat_app_sessions"]) {
            await client.query(`delete from ${table} where user_id = $1`, [id]);
          }
          await client.query("delete from marginchat_users where id = $1 and email = $2", [id, email]);
          await client.query("commit");
        } catch (error) { await client.query("rollback"); throw error; }
        const objects = [];
        let cursor;
        const cursors = new Set();
        do {
          const page = await sdk.list({ token: blobToken, prefix, cursor, limit: 1000 });
          for (const object of page.blobs) {
            assert.ok(object.pathname.startsWith(prefix), "Cleanup crossed its synthetic account boundary.");
            objects.push(object.url);
          }
          cursor = page.hasMore ? page.cursor : undefined;
          if (page.hasMore && (!cursor || cursors.has(cursor))) throw new Error("Blob cleanup pagination did not advance.");
          if (cursor) cursors.add(cursor);
        } while (cursor);
        for (let i = 0; i < objects.length; i += 100) await sdk.del(objects.slice(i, i + 100), { token: blobToken });
      } catch (error) {
        if (failure) throw new AggregateError([failure, error], "Persistence verification and synthetic cleanup failed.");
        throw error;
      }
    }
  }
}
