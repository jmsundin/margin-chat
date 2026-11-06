import type { VaultSync } from "./vaultSync";
import type { VaultTransport } from "./vaultTypes";
import type { VaultBridgeApi } from "@margin-chat/vault-sync/bridgeProtocol";
import { bridgeRequest } from "@margin-chat/vault-sync/bridgeDirectory";

/** The engine surface the vault hook uses: `VaultSync` itself on the web, a proxy to the main process on desktop. */
export type VaultEngine = Pick<VaultSync, "read" | "edit" | "restoreDeleted" | "purgeTrash" | "rememberDirectory" | "import" | "resolve"
  | "importChatHistory" | "undoChatHistory" | "deferFresh" | "pull" | "hydrate" | "evict" | "sync" | "transport"> & {
  onDownload?: VaultSync["onDownload"];
  onUpload?: VaultSync["onUpload"];
};

/**
 * The desktop app's vault, which lives in the main process, seen from the page.
 * Every engine call is a bridge request; `sync()` asks the main process for one
 * complete pass (read the folder, sync with the cloud, write the folder) and
 * resolves when it is done, so the hook's save-then-publish discipline holds
 * unchanged. Index and search go straight to the API from the page, as they
 * are read-only and already proxied through the app's session.
 */
export class BridgeVaultEngine implements VaultEngine {
  onDownload?: VaultSync["onDownload"];
  onUpload?: VaultSync["onUpload"];

  constructor(private readonly api: VaultBridgeApi, readonly transport: VaultTransport) {}

  private call<T>(operation: string, ...args: unknown[]): Promise<T> {
    return bridgeRequest(() => this.api.request("vault", operation, ...args)) as Promise<T>;
  }

  read: VaultEngine["read"] = () => this.call("read");
  edit: VaultEngine["edit"] = (next, expected, directory) => this.call("edit", next, expected, directory);
  restoreDeleted: VaultEngine["restoreDeleted"] = (key) => this.call("restoreDeleted", key);
  purgeTrash: VaultEngine["purgeTrash"] = (now) => this.call("purgeTrash", now);
  rememberDirectory: VaultEngine["rememberDirectory"] = (id, baseline) => this.call("rememberDirectory", id, baseline);
  import: VaultEngine["import"] = (files, directory, options) => this.call("import", files, directory, options);
  resolve: VaultEngine["resolve"] = (id, choice) => this.call("resolve", id, choice);
  importChatHistory: VaultEngine["importChatHistory"] = (files) => this.call("importChatHistory", files);
  undoChatHistory: VaultEngine["undoChatHistory"] = (receipt) => this.call("undoChatHistory", receipt);
  deferFresh: VaultEngine["deferFresh"] = (manifest, keep, ids) => this.call("deferFresh", manifest, keep, ids);
  pull: VaultEngine["pull"] = (entries) => this.call("pull", entries);
  hydrate: VaultEngine["hydrate"] = (paths) => this.call("hydrate", [...paths]);
  evict: VaultEngine["evict"] = (paths, ids) => this.call("evict", [...paths], ids);

  async sync() {
    this.onDownload?.({ done: 0, total: 1 });
    try {
      const status = await bridgeRequest(() => this.api.request("syncNow"));
      if (status.attention?.kind === "auth") throw Object.assign(new Error(status.attention.message), { statusCode: 401 });
      if (status.state === "offline") throw new TypeError("Failed to fetch");
      if (status.lastError && status.attention?.kind === "error") throw new Error(status.lastError);
      this.onUpload?.();
      return this.read();
    } finally {
      this.onDownload?.({ done: 1, total: 0 });
    }
  }
}
