import { useEffect, useEffectEvent, useRef } from "react";
import type { Capture } from "@margin-chat/capture-contracts";

export interface BrowserCaptureRequest {
  id: string;
  capture: Capture;
  /** A nonempty prompt is explicit permission to start an AI conversation. */
  prompt?: string;
}

/** Delay external imports until local vault hydration has finished. */
export function useBrowserWorkspaceCapture(
  ready: boolean,
  request: BrowserCaptureRequest | null | undefined,
  onImport: (request: BrowserCaptureRequest) => void,
  onHandled?: (id: string) => void,
) {
  const handled = useRef(new Set<string>());
  const consume = useEffectEvent((next: BrowserCaptureRequest) => {
    onImport(next);
    handled.current.add(next.id);
    onHandled?.(next.id);
  });
  useEffect(() => {
    if (!ready || !request || handled.current.has(request.id)) return;
    consume(request);
  }, [ready, request]);
}
