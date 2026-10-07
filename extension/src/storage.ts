import type {
  CaptureInput,
  CaptureReceipt,
} from "@margin-chat/capture-contracts";
import type { OverlayAnnotation, OverlayPage } from "./overlay-types";
import type { PageThread } from "./page-ai";
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
  overlayAnnotation?: OverlayAnnotation;
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

const pageKey = (connectionId: string, sourceUrl: string) =>
  `overlayPage:${JSON.stringify([connectionId, sourceUrl])}`;

export async function getOverlayPage(connectionId: string, sourceUrl: string): Promise<OverlayPage> {
  const key = pageKey(connectionId, sourceUrl);
  return (await chrome.storage.local.get(key))[key] as OverlayPage | undefined ?? {
    annotations: [], draft: null,
  };
}

// A page may be open in several tabs. Serialize read-modify-write operations so
// saving a capture cannot discard a concurrent draft or another annotation.
let pageWrite: Promise<unknown> = Promise.resolve();
export function updateOverlayPage(
  connectionId: string,
  sourceUrl: string,
  update: (page: OverlayPage) => OverlayPage,
): Promise<OverlayPage> {
  const operation = pageWrite.then(async () => {
    const page = update(await getOverlayPage(connectionId, sourceUrl));
    await chrome.storage.local.set({ [pageKey(connectionId, sourceUrl)]: page });
    return page;
  });
  pageWrite = operation.catch(() => undefined);
  return operation;
}

const threadsKey = (connectionId: string) => `pageThreads:${connectionId}`;
export const isThreadsKey = (key: string) => key.startsWith("pageThreads:");

export async function getThreads(connectionId: string): Promise<PageThread[]> {
  const key = threadsKey(connectionId);
  return ((await chrome.storage.local.get(key))[key] as PageThread[] | undefined) ?? [];
}

// Only the background worker writes threads, so one in-process queue serializes
// every read-modify-write across cards, tabs, and the workspace.
let threadWrite: Promise<unknown> = Promise.resolve();
export function updateThreads(
  connectionId: string,
  update: (threads: PageThread[]) => PageThread[],
): Promise<PageThread[]> {
  const operation = threadWrite.then(async () => {
    const threads = update(await getThreads(connectionId));
    await chrome.storage.local.set({ [threadsKey(connectionId)]: threads });
    return threads;
  });
  threadWrite = operation.catch(() => undefined);
  return operation;
}
