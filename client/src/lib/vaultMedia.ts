import { createContext, useContext } from "react";

/** Reads and stores media files in the vault for documents that embed them. */
export interface VaultMedia {
  /** The file an embed names, downloading it when it is still only in the cloud. */
  read(target: string): Promise<{ path: string; blob: Blob } | null>;
  /** Store a file under Attachments/ and return the embed Markdown that shows it. */
  save(file: File): Promise<string>;
  /** A small text file the app keeps in the vault (such as what an HTML page saved), or null when there is none. */
  readText?(path: string): Promise<string | null>;
  /** Replaces that file's text, so it syncs with the rest of the vault. */
  writeText?(path: string, text: string, contentType?: string): Promise<void>;
}

export const VaultMediaContext = createContext<VaultMedia | null>(null);
export const useVaultMedia = () => useContext(VaultMediaContext);
