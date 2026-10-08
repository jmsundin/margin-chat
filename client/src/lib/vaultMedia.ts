import { createContext, useContext } from "react";

/** Reads and stores media files in the vault for documents that embed them. */
export interface VaultMedia {
  /** The file an embed names, downloading it when it is still only in the cloud. */
  read(target: string): Promise<{ path: string; blob: Blob } | null>;
  /** Store a file under Attachments/ and return the embed Markdown that shows it. */
  save(file: File): Promise<string>;
}

export const VaultMediaContext = createContext<VaultMedia | null>(null);
export const useVaultMedia = () => useContext(VaultMediaContext);
