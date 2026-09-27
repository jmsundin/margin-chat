import type { CaptureInput, CaptureKind, CaptureReceipt } from "@margin-chat/capture-contracts";

export interface TextQuoteAnchor {
  exact: string;
  prefix: string;
  suffix: string;
  start: number;
  end: number;
}

export type OverlayMode = "annotate" | "comment" | "ingest" | "ask";
export interface OverlayDraft {
  title: string;
  kind: CaptureKind;
  content: string;
  comment: string;
  question?: string;
  mode?: OverlayMode;
  anchor?: TextQuoteAnchor;
}

export interface OverlayAnnotation {
  id: string;
  title: string;
  kind: CaptureKind;
  excerpt: string;
  comment: string;
  capturedAt: string;
  captureId?: string;
  anchor?: TextQuoteAnchor;
}

export interface OverlayPage {
  annotations: OverlayAnnotation[];
  draft: OverlayDraft | null;
}

export interface OverlayPending {
  capture: CaptureInput;
  connectionId: string;
  receipt?: CaptureReceipt["capture"];
  error?: string;
  overlayAnnotation?: OverlayAnnotation;
}

export interface OverlayState {
  connection: { connectionId: string; displayName: string } | null;
  pending: OverlayPending | null;
  hasOtherPending: boolean;
  page: OverlayPage;
}
