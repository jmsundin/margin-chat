import { apiFetch } from "./apiTransport";
import {
  CAPTURE_API_PATH,
  captureToMarkdown,
  parseCaptureDetail,
  parseCapturePage,
  type Capture,
} from "@margin-chat/capture-contracts";
import { createStandaloneNoteConversation } from "../initialState";
import type { AppState, Conversation } from "../types";
import type { DocumentAIRequest } from "./documentAI";
import { focusDocument } from "./documentWorkspace";
import { getEditableDocument } from "./editableDocument";

export interface CaptureHandoff {
  captureId: string;
  intent: "ask" | "note";
}

/** The link identifies a saved capture; its private content stays out of the URL. */
export function readCaptureHandoff(search: string): CaptureHandoff | null {
  const params = new URLSearchParams(search);
  const captureId = params.get("capture");
  if (!captureId || !/^[a-zA-Z0-9_-]{1,100}$/u.test(captureId)) return null;
  return { captureId, intent: params.get("intent") === "ask" ? "ask" : "note" };
}

/** The existing document AI flow includes the full current source in its context. */
export function createCaptureAIRequest(conversation: Conversation, prompt: string): DocumentAIRequest | null {
  const block = getEditableDocument(conversation).blocks[0];
  if (!block || !prompt.trim()) return null;
  return {
    blockId: block.id,
    from: 0,
    to: 0,
    sourceContent: block.content,
    prompt: prompt.trim(),
    destination: "side",
  };
}

async function request<T>(path: string, parse: (input: unknown) => T, method = "GET"): Promise<T> {
  const response = await apiFetch(path, {
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
    return focusDocument(state, id);
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
