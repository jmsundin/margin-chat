import { createMarginOverlay } from "../src/overlay-ui";
import type { OverlayState } from "../src/overlay-types";

// An explicit local design sandbox. It never connects to an account or AI service.
const state: OverlayState = {
  connection: { connectionId: "preview", displayName: "Design preview" },
  pending: null, hasOtherPending: false,
  page: { draft: null, annotations: [] },
};
const overlay = createMarginOverlay(document, async (message) => {
  switch (message.type) {
    case "overlay:state": return structuredClone(state);
    case "overlay:draft": state.page.draft = message.draft as typeof state.page.draft; return { ok: true };
    case "overlay:save": {
      const capture = message.capture as NonNullable<OverlayState["pending"]>["capture"];
      const receipt = { id: capture.clientCaptureId, createdAt: new Date().toISOString() };
      state.page.annotations.push({ id: capture.clientCaptureId, title: capture.title, kind: capture.kind, excerpt: capture.content.slice(0, 400), comment: capture.comment, capturedAt: capture.capturedAt, captureId: receipt.id, ...(message.annotation as object) });
      state.pending = { capture, receipt, connectionId: "preview" };
      return { receipt, page: structuredClone(state.page) };
    }
    case "overlay:open": return { error: "Design preview: the installed extension opens this source and question in your connected Margin Chat workspace." };
    case "overlay:settings": return { error: "Design preview: install the built extension to connect your Margin Chat account." };
    default: return { ok: true };
  }
}, { shadowMode: "open" });
document.getElementById("show-margin")!.addEventListener("click", () => void overlay.open());
void overlay.open();
