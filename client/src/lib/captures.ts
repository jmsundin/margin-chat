import {
  CAPTURE_API_PATH,
  captureToMarkdown,
  parseCaptureDetail,
  parseCapturePage,
  type Capture,
} from "@margin-chat/capture-contracts";
import { createStandaloneNoteConversation } from "../initialState";
import type { AppState } from "../types";

async function request<T>(path: string, parse: (input: unknown) => T, method = "GET"): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    cache: "no-store",
    headers: method === "GET" ? {} : { "X-Margin-Capture-Settings": "1" },
  });
  const result = await response.json().catch(() => null);
  if (!response.ok)
    throw new Error(typeof result?.error === "string" ? result.error : "Unable to reach your Cloud Inbox.");
  return parse(result);
}
export const listCaptures = (cursor?: string) =>
  request(
    `${CAPTURE_API_PATH}${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ""}`,
    parseCapturePage,
  );
export const loadCapture = (id: string) =>
  request(
    `${CAPTURE_API_PATH}/${encodeURIComponent(id)}`,
    parseCaptureDetail,
  );
export function openCaptureAsNote(state: AppState, capture: Capture): AppState {
  const id = `web-capture-${capture.id}`;
  // Reopening an imported capture preserves all edits and branches on that note.
  if (state.conversations[id])
    return { ...state, activeConversationId: id, rootId: id };
  const conversation = createStandaloneNoteConversation({
    id,
    noteId: `web-capture-body-${capture.id}`,
    createdAt: capture.createdAt,
    modelId: state.defaultModelId,
    serviceId: state.defaultServiceId,
  });
  conversation.title = capture.title;
  conversation.notes![0].content = captureToMarkdown(capture);
  return {
    ...state,
    activeConversationId: id,
    rootId: id,
    conversations: { ...state.conversations, [id]: conversation },
  };
}
