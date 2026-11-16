import { afterEach, describe, expect, test } from "bun:test";
import { createVaultTransport, unreachableKind, VAULT_REQUEST_TIMEOUT_MS, VaultUnreachableError, vaultRequestStep } from "../client/src/lib/vaultApi";
import { setApiTransport } from "../client/src/lib/apiTransport";

afterEach(() => setApiTransport(null));

describe("cloud sync says why a request got no answer", () => {
  test("a server that can't be reached names the step", async () => {
    setApiTransport({ fetch: (async () => { throw new TypeError("Failed to fetch"); }) as unknown as typeof fetch });
    const error = await createVaultTransport("u").manifest().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(VaultUnreachableError);
    expect((error as VaultUnreachableError).kind).toBe("network");
    expect((error as Error).message).toContain("couldn't reach the Margin Chat server while checking the cloud for changes");
  });

  test("a server that answers too slowly is told apart from being offline", async () => {
    setApiTransport({ fetch: (async () => { throw new DOMException("The operation timed out.", "TimeoutError"); }) as unknown as typeof fetch });
    const error = await createVaultTransport("u").commit([{ path: "a.md", baseRevision: null, content: "x" }]).catch((caught: unknown) => caught);
    expect((error as VaultUnreachableError).kind).toBe("timeout");
    expect((error as Error).message).toContain("didn't answer in time while uploading your changes");
  });

  test("an answer that says no stays its own error", async () => {
    setApiTransport({ fetch: (async () => new Response(JSON.stringify({ error: "Your plan has ended." }), { status: 403 })) as unknown as typeof fetch });
    const error = await createVaultTransport("u").manifest().catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(VaultUnreachableError);
    expect((error as Error).message).toBe("Your plan has ended.");
  });

  test("a search the person cancelled is not reported as a sync problem", async () => {
    setApiTransport({ fetch: (async () => { throw new DOMException("Cancelled", "AbortError"); }) as unknown as typeof fetch });
    const error = await createVaultTransport("u").search("x", {}, () => undefined).catch((caught: unknown) => caught);
    expect(error).not.toBeInstanceOf(VaultUnreachableError);
  });

  test("steps and kinds", () => {
    expect(vaultRequestStep("/api/vault/file?path=a.md", "PUT")).toBe("uploading your changes");
    expect(vaultRequestStep("https://www.marginchat.com/api/vault/file?path=a.md")).toBe("downloading a file");
    expect(unreachableKind(new Error("Your plan has ended."))).toBeNull();
    expect(unreachableKind(new DOMException("x", "TimeoutError"))).toBe("timeout");
    // The server may take up to 300 s; a request isn't cut off at 30 s any more.
    expect(VAULT_REQUEST_TIMEOUT_MS).toBeGreaterThanOrEqual(60_000);
  });
});
