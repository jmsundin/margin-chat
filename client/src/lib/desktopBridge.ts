import { VAULT_BRIDGE_GLOBAL, VAULT_BRIDGE_PROTOCOL_VERSION, type VaultBridgeApi } from "@margin-chat/vault-sync/bridgeProtocol";
import { bridgeDirectory, isBridgeHandle, type BridgeDirectory } from "@margin-chat/vault-sync/bridgeDirectory";
import type { VaultDirectory } from "@margin-chat/vault-sync/vaultFs";

export { isBridgeHandle, type BridgeDirectory };

/**
 * The desktop app's native vault, when its shell offers it.
 *
 * The desktop shell (Electron) and this client update on different cadences, so
 * the client takes the native path only when the shell's preload script is
 * present *and* speaks the protocol version this client was built against.
 * Otherwise the folder works through the browser's File System Access API as
 * before, on desktop as on the web. Nothing here is a build flag: the same
 * client bundle serves the website and the app.
 */
export function vaultBridge(target: object | undefined = typeof window === "undefined" ? undefined : window): VaultBridgeApi | null {
  const candidate = (target as Record<string, unknown> | undefined)?.[VAULT_BRIDGE_GLOBAL] as Partial<VaultBridgeApi> | undefined;
  if (!candidate || typeof candidate !== "object") return null;
  if (candidate.protocolVersion !== VAULT_BRIDGE_PROTOCOL_VERSION || typeof candidate.request !== "function" || typeof candidate.onFolderChanged !== "function"
    || typeof candidate.onSyncStatus !== "function" || typeof candidate.onVaultChanged !== "function") return null;
  return candidate as VaultBridgeApi;
}

export const hasVaultBridge = () => vaultBridge() !== null;

/** A native folder as the folder code types it. The handle is a bridge handle underneath (`isBridgeHandle`). */
export function bridgeFolderHandle(api: VaultBridgeApi, folder: { id: string; name: string }): FileSystemDirectoryHandle {
  return bridgeDirectory(api, folder) as unknown as FileSystemDirectoryHandle;
}

export const asVaultDirectory = (handle: FileSystemDirectoryHandle) => handle as unknown as VaultDirectory;
