import { extractArticle, extractSelection } from "./extraction";
import type { CaptureKind } from "@margin-chat/capture-contracts";
// This binding lives in Chrome's isolated extension world, never the page's world.
(
  globalThis as unknown as { marginExtract: (kind: CaptureKind) => unknown }
).marginExtract = (kind) => {
  try {
    const result =
      kind === "article"
        ? extractArticle(document)
        : {
            title: document.title,
            content: extractSelection(window.getSelection()?.toString() ?? ""),
          };
    return { ...result, sourceUrl: location.href };
  } catch (error) {
    return {
      error:
        error instanceof Error ? error.message : "Unable to read this page.",
    };
  }
};
