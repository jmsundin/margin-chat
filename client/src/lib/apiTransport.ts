export interface ApiTransport {
  /** Receives the original API path and request, including streaming/cancellation. */
  fetch: typeof globalThis.fetch;
  serverUrl?: string;
}

let transport: ApiTransport | null = null;

/** Configure before rendering the extension workspace; the website uses native fetch. */
export function setApiTransport(value: ApiTransport | null) {
  transport = value;
}

export function apiFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
  return transport ? transport.fetch(input, init) : globalThis.fetch(input, init);
}

export function apiServerUrl(): string {
  return transport?.serverUrl?.replace(/\/$/u, "") ?? (typeof window === "undefined" ? "" : window.location.origin);
}

/** An extension origin can connect to different servers with overlapping account IDs. */
export function apiStorageNamespace(userId: string): string {
  return transport?.serverUrl ? JSON.stringify([apiServerUrl(), userId]) : userId;
}

export function hasApiTransport(): boolean {
  return transport !== null;
}
