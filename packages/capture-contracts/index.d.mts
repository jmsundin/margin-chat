export type CaptureKind = "selection" | "article" | "bookmark";
export interface CaptureInput {
  schemaVersion: 1;
  clientCaptureId: string;
  kind: CaptureKind;
  title: string;
  sourceUrl: string;
  content: string;
  comment: string;
  capturedAt: string;
}
export interface Capture extends CaptureInput {
  id: string;
  createdAt: string;
}
export interface CaptureSummary extends Omit<Capture, "content" | "comment"> {
  excerpt: string;
}
export interface CapturePage {
  captures: CaptureSummary[];
  nextCursor: string | null;
}
export interface CaptureReceipt {
  capture: { id: string; createdAt: string };
}
export interface CaptureConnection {
  userId?: string;
  displayName: string;
  expiresAt: string;
}
export interface ExtensionSession {
  token: string;
  user: { id: string; displayName: string; email: string };
  expiresAt: string;
}
export interface CaptureTokenSummary {
  createdAt: string;
  expiresAt: string;
  lastUsedAt: string | null;
}
export const CAPTURE_API_PATH: "/api/v1/captures";
export const CONNECTION_API_PATH: "/api/v1/capture-connection";
export const EXTENSION_SESSION_API_PATH: "/api/v1/extension-session";
export const CAPTURE_LIMITS: Readonly<{
  title: number;
  url: number;
  content: number;
  comment: number;
}>;
export const CAPTURE_KINDS: readonly CaptureKind[];
export function normalizeCapture(input: unknown): CaptureInput;
export function normalizeServerUrl(value: string): string;
export function escapeMarkdown(value: string): string;
export function captureToMarkdown(capture: CaptureInput): string;
