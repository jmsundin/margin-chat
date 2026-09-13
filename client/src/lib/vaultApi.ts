import { ApiError } from "./apiError";
import type { VaultEntry, VaultFile, VaultManifest, VaultTransport } from "./vaultTypes";
import { bytesToBase64, vaultFileBytes } from "./vaultLocal";

async function request(path: string, init?: RequestInit) {
  const response = await fetch(path, { credentials: "same-origin", cache: "no-store", signal: AbortSignal.timeout(30_000), ...init });
  if (!response.ok) {
    const payload = await response.json().catch(() => null);
    throw new ApiError(response.status, payload?.error ?? "Unable to synchronize the vault.");
  }
  return response;
}

export function createVaultTransport(userId?: string): VaultTransport {
  const accountRequest = (path: string, init?: RequestInit) => request(path, {
    ...init,
    headers: { ...Object.fromEntries(new Headers(init?.headers)), ...(userId ? { "X-Margin-Vault-User": userId } : {}) },
  });
  return {
    async manifest(): Promise<VaultManifest> {
      const payload = await (await accountRequest("/api/vault")).json();
      if (payload.configured === false) throw new Error("Cloud vault storage has not been configured. Your files are saved on this device.");
      if (payload.manifest?.schemaVersion !== 1 || !payload.manifest.files) throw new Error("The server returned an invalid vault manifest.");
      for (const entry of Object.values(payload.manifest.files) as Array<Record<string, unknown>>) {
        if (entry.encoding === "utf8") delete entry.encoding;
      }
      return payload.manifest;
    },
    async read(path: string, entry: VaultEntry): Promise<VaultFile> {
      const response = await accountRequest(`/api/vault/file?${new URLSearchParams({ path, revision: entry.revision })}`);
      return { content: entry.encoding === "base64"
        ? bytesToBase64(new Uint8Array(await response.arrayBuffer())) : await response.text(),
        ...(entry.encoding === "base64" ? { encoding: "base64" as const } : {}),
        ...(entry.contentType ? { contentType: entry.contentType } : {}),
      };
    },
    async commit(changes) {
      if (changes.length === 1 && changes[0].encoding === "base64" && changes[0].content !== null) {
        const change = changes[0];
        const payload = await (await accountRequest(`/api/vault/file?${new URLSearchParams({ path: change.path, baseRevision: change.baseRevision ?? "" })}`, {
          method: "PUT", headers: { "Content-Type": change.contentType ?? "application/octet-stream", "X-Margin-Vault-Write": "1" },
          body: new Uint8Array(vaultFileBytes({ content: change.content!, encoding: "base64" })).buffer,
        })).json();
        return payload.manifest;
      }
      const payload = await (await accountRequest("/api/vault/commit", {
        method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ changes }),
      })).json();
      return payload.manifest;
    },
  };
}
