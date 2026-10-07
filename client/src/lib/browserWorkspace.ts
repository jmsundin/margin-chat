import { useEffect, useEffectEvent, useRef } from "react";
import type { Capture } from "@margin-chat/capture-contracts";
import { createMainConversation } from "../initialState";
import type { AppState } from "../types";
import { focusDocument } from "./documentWorkspace";
import { addRootConversation } from "./workspaceCommands";

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

/** A finished page conversation, already answered in the browser extension. */
export interface BrowserThread {
  id: string;
  createdAt: string;
  /** Short conversation title, normally the reader's request. */
  title: string;
  /** Markdown shown as the reader's message: the quoted passage, its source, and the request. */
  userContent: string;
  answer: string;
}

export interface BrowserThreadRequest {
  /** Unique per delivery so a later "open" of the same thread is not mistaken for a repeat. */
  id: string;
  thread: BrowserThread;
  /** Make the conversation active, instead of importing it quietly. */
  focus: boolean;
}

/**
 * Add the thread as an ordinary root chat so it can be continued like any other.
 * The id is derived from the thread, so repeated delivery never duplicates it,
 * and no AI request is made.
 */
export function openThreadAsChat(state: AppState, thread: BrowserThread, focus: boolean): AppState {
  const id = `web-thread-${thread.id}`;
  if (state.conversations[id]) return focus ? focusDocument(state, id) : state;
  const conversation = createMainConversation({
    createdAt: thread.createdAt, id, modelId: state.defaultModelId, serviceId: state.defaultServiceId,
  });
  conversation.title = thread.title.slice(0, 120) || "Page conversation";
  conversation.messages = [
    { id: `${id}:user`, role: "user", content: thread.userContent, createdAt: thread.createdAt },
    { id: `${id}:assistant`, role: "assistant", content: thread.answer, createdAt: thread.createdAt },
  ];
  const added = addRootConversation(state, conversation);
  // A background import must not take over whatever the reader is looking at.
  return focus ? added : { ...added, activeConversationId: state.activeConversationId, rootId: state.rootId };
}

/** Import page conversations once, after local vault hydration has finished. */
export function useBrowserThreadImports(
  ready: boolean,
  requests: readonly BrowserThreadRequest[] | null | undefined,
  onImport: (request: BrowserThreadRequest) => void,
  onHandled?: (request: BrowserThreadRequest) => void,
) {
  const handled = useRef(new Set<string>());
  const consume = useEffectEvent((next: BrowserThreadRequest) => {
    handled.current.add(next.id);
    onImport(next);
    onHandled?.(next);
  });
  useEffect(() => {
    if (!ready || !requests) return;
    for (const request of requests) if (!handled.current.has(request.id)) consume(request);
  }, [ready, requests]);
}
