import type {
  CaptureInput,
  CaptureReceipt,
} from "@margin-chat/capture-contracts";
export interface ConnectionSettings {
  serverUrl: string;
  token: string;
  connectionId: string;
  displayName: string;
  userId?: string;
  email?: string;
  expiresAt?: string;
}
// Stable across sign-out and renewal, distinct for every account and server.
export const connectionIdentity = (serverUrl: string, userId: string) =>
  JSON.stringify([serverUrl, userId]);
export interface PendingSave {
  capture: CaptureInput;
  connectionId: string;
  receipt?: CaptureReceipt["capture"];
  error?: string;
}
export interface SelectionDraft {
  text: string;
  sourceUrl: string;
  title: string;
}
export async function trustedStorage() {
  await chrome.storage.local.setAccessLevel({
    accessLevel: "TRUSTED_CONTEXTS",
  });
}
export async function getSettings(): Promise<ConnectionSettings | null> {
  return (
    ((await chrome.storage.local.get("connection")).connection as
      ConnectionSettings | undefined) ?? null
  );
}
export async function getPending(): Promise<PendingSave | null> {
  return (
    ((await chrome.storage.local.get("pendingSave")).pendingSave as
      PendingSave | undefined) ?? null
  );
}
