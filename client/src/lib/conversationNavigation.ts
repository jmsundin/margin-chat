import type { Conversation, MainViewMode } from "../types";

export function getConversationSelectionViewMode({
  currentViewMode,
  requestedViewMode,
}: {
  currentViewMode: MainViewMode;
  requestedViewMode?: MainViewMode;
  targetKind?: Conversation["kind"];
}): MainViewMode {
  if (requestedViewMode) return requestedViewMode;
  if (currentViewMode === "tiles") return "chat";
  return currentViewMode;
}
