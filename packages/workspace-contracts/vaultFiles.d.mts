export type VaultFileKind = "pdf" | "image" | "html";
export function vaultFileKind(path: string): VaultFileKind | null;
export function isVaultFileDocumentPath(path: string): boolean;
export function vaultFileTitle(path: string): string;
export function vaultFileDocumentId(path: string): string;
