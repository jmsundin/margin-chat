import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { AppState } from "../../client/src/types";
import type { ConversationGraphViewProps } from "../../client/src/components/ConversationGraphView";
import type { TopicExpansion } from "../../client/src/lib/topicExpansion";

const browser = new Window({ url: "http://topic-expansion-interactions.test/" });
for (const name of ["window", "document", "navigator", "localStorage", "sessionStorage", "HTMLElement", "Element", "Node", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "ResizeObserver", "DOMRect"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
Object.defineProperties(browser.HTMLElement.prototype, {
  clientWidth: { configurable: true, get: () => 1000 },
  clientHeight: { configurable: true, get: () => 700 },
});
browser.HTMLElement.prototype.getBoundingClientRect = () => new browser.DOMRect(0, 0, 1000, 700);
let frameId = 0;
const frames = new Map<number, FrameRequestCallback>();
browser.requestAnimationFrame = (callback) => { frames.set(++frameId, callback); return frameId; };
browser.cancelAnimationFrame = (id) => { frames.delete(id); };

interface PendingRequest { signal: AbortSignal; payload: any; userId: string; finish: (expansion: unknown) => void }
const requests: PendingRequest[] = [];
// Deferred network responses deliberately may arrive after abort, exercising the hook's guard.
globalThis.fetch = (async (input, init) => {
  assert.equal(String(input), "/api/graph/topic", "The test makes no live AI or public-data requests");
  assert.equal(init?.method, "POST");
  assert.equal(init?.credentials, "same-origin");
  return await new Promise<Response>((resolve) => {
    requests.push({
      signal: init!.signal as AbortSignal, payload: JSON.parse(String(init!.body)),
      userId: new Headers(init?.headers).get("X-Margin-Vault-User")!,
      finish(expansion) {
        resolve(new Response([
          JSON.stringify({ type: "progress", message: "Organizing the topic into a small outline…" }),
          JSON.stringify({ type: "done", expansion }), "",
        ].join("\n"), { headers: { "Content-Type": "application/x-ndjson" } }));
      },
    });
  });
}) as typeof fetch;

const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: KnowledgeGraphWorkspace } = await import("../../client/src/components/KnowledgeGraphWorkspace");
const { default: ConversationTreeNode } = await import("../../client/src/components/ConversationTreeNode");
const { useTopicExpansion } = await import("../../client/src/lib/useTopicExpansion");
const { createEmptyState } = await import("../../client/src/initialState");
const { buildThreadSummaries } = await import("../../client/src/lib/conversationSearch");
const { addMapChildNote } = await import("../../client/src/lib/graphWorkspaceEdits");
const { savePublicTopic } = await import("../../client/src/lib/publicTopicWorkspace");
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const accounts = new Map<string, AppState>();
const parentId = "public-topic-Q990101";
const parentTitle = "Systems thinking";
let account = "topic-expansion-account-a";
let focusSequence = 0;
let childSequence = 0;
let directExpand: (() => void) | undefined;
let billingRefreshes = 0;

function initialState() {
  const saved = savePublicTopic(createEmptyState(), {
    id: "Q990101", aliases: [], label: parentTitle, description: "Seeing connected parts and their interactions.",
    wikidataUrl: "https://www.wikidata.org/wiki/Q990101", retrievedAt: "2026-09-20T00:00:00.000Z",
  }).state;
  saved.conversations[parentId].notes![0].content = "My authored topic note stays intact.";
  saved.conversations[parentId].ai = { mode: "balanced", contextScope: "workspace", selectedConversationIds: [saved.rootId] };
  return saved;
}

function Workspace() {
  const [state, setState] = useState(() => accounts.get(account) ?? initialState());
  const [focus, setFocus] = useState<ConversationGraphViewProps["focusRequest"]>(null);
  accounts.set(account, state);
  const expansion = useTopicExpansion({
    state, setState, userId: account,
    onReady(id) { setFocus({ conversationId: id, requestId: ++focusSequence, neighborhoodDepth: 2, preserveMapMode: true }); },
    onAuthExpired() { throw new Error("Unexpected authentication expiration"); },
    onBillingRefresh() { billingRefreshes++; },
  });
  directExpand = () => { void expansion.expand(parentId); };
  const reader = (id: string) => {
    const note = state.conversations[id].notes?.[0];
    return createElement("article", { className: "chat-panel", "data-reader-id": id },
      createElement("div", { className: "panel-body" }, note ? createElement("textarea", {
        "aria-label": `Edit note ${id}`, value: note.content,
        onChange(event: any) {
          const content = event.target.value;
          setState((previous) => ({ ...previous, conversations: { ...previous.conversations,
            [id]: { ...previous.conversations[id], notes: previous.conversations[id].notes!.map((item) => item.id === note.id ? { ...item, content } : item) },
          } }));
        },
      }) : "Chat content"));
  };
  return createElement(KnowledgeGraphWorkspace, {
    workspaceKey: account, activeConversationId: state.activeConversationId,
    conversations: state.conversations, groups: state.groups, graphLayouts: state.graphLayouts,
    threads: buildThreadSummaries(state.conversations), focusRequest: focus,
    onFocusRequestHandled(id) { setFocus((previous) => previous?.requestId === id ? null : previous); },
    onAddChildNote(id) {
      const childId = `manual-child-${++childSequence}`;
      setState((previous) => addMapChildNote(previous, { parentId: id, id: childId, noteId: `${childId}-body`, createdAt: "2026-09-20T01:00:00.000Z" }));
      setFocus({ conversationId: childId, requestId: ++focusSequence, openReader: true });
    },
    onExpandTopicWithAI(id) { void expansion.expand(id); },
    onCancelTopicExpansion: expansion.cancel, expandingTopicId: expansion.pendingId,
    topicExpansionProgress: expansion.progress, topicExpansionError: expansion.error,
    onDismissTopicExpansionError: expansion.dismissError,
    onSavePublicTopic() {}, onCreateMapNote() {}, onSetMapConnection() {}, onRemoveMapNote() {}, onUndoMapEdit() {},
    onActivateConversation(id) { setState((previous) => ({ ...previous, activeConversationId: id })); },
    onAssignGroup() {}, onCreateChildConversation: () => null, onOpenConversation() {}, onToggleGroup() {},
    renderDockedConversation: reader, renderExpandedConversation: reader,
  });
}

async function flushFrames() {
  for (let iteration = 0; frames.size && iteration < 20; iteration++) {
    const callbacks = [...frames.values()]; frames.clear();
    await act(async () => { callbacks.forEach((callback) => callback(0)); });
  }
  assert.equal(frames.size, 0, "Rendering settles without a frame loop");
}
async function render() { await act(async () => { root.render(createElement(Workspace, { key: account })); }); await flushFrames(); }
function element(selector: string) {
  const value = container.querySelector(selector);
  assert(value, `Missing ${selector}`);
  return value as any;
}
function button(text: string, selector = "button") {
  const value = [...container.querySelectorAll(selector)].find((item) => item.textContent.trim() === text);
  assert(value, `Missing button: ${text}`);
  return value as any;
}
async function click(target: any) { await act(async () => { target.click(); }); await flushFrames(); }
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 20)); }); await flushFrames(); }
async function finish(index: number, expansion: unknown) { await act(async () => { requests[index].finish(expansion); }); await settle(); }
function state() { return accounts.get(account)!; }
function count() { return Object.keys(state().conversations).length; }
function generated(prefix: string): TopicExpansion {
  return { nodes: [
    { id: "overview", parentId: null, title: `${prefix} principles`, content: "A short overview of interactions between parts of a system." },
    { id: "detail", parentId: "overview", title: `${prefix} feedback loops`, content: "A concrete example of an output affecting the next input." },
    { id: "questions", parentId: null, title: `${prefix} questions`, content: "Questions to investigate and connect with personal experience." },
  ] };
}
function aiButton() { return element('[aria-label="Expand Systems thinking with AI"]'); }

try {
  await render();
  const showMap = [...container.querySelectorAll("button")].find((item) => item.textContent.trim() === "Show map");
  if (showMap) await click(showMap);
  const baselineCount = count();
  const parentLayout = structuredClone(state().graphLayouts[parentId]);
  const parentBody = state().conversations[parentId].notes![0].content;
  await click(element('[aria-label="Add child note to Systems thinking"]'));
  assert.equal(count(), baselineCount + 1);
  const child = state().conversations["manual-child-1"];
  assert.equal(child.parentId, parentId, "Add child note creates a hierarchy edge, not a separate root link");
  assert.equal(child.kind, "note");
  assert(state().conversations[parentId].childIds.includes(child.id));
  assert.equal(child.publicTopic, undefined, "A personal child does not claim the saved parent’s public identity");
  assert(element('[data-conversation-id="manual-child-1"]').classList.contains("is-reader"), "The new child opens ready for editing");
  assert.equal(state().activeConversationId, child.id);
  await act(async () => {
    const input = element('[aria-label="Edit note manual-child-1"]');
    Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value")!.set!.call(input, "My own follow-up question.");
    input.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
  assert.equal(state().conversations[child.id].notes![0].content, "My own follow-up question.");

  await click(aiButton());
  assert.equal(requests.length, 1);
  assert(aiButton().disabled, "AI expansion disables duplicate starts while pending");
  assert(button("Cancel expansion"));
  await click(aiButton());
  await act(async () => { directExpand!(); directExpand!(); });
  assert.equal(requests.length, 1, "Both the UI and hook enforce a single in-flight expansion");
  assert.equal(requests[0].payload.topic.id, "Q990101");
  assert.equal(requests[0].payload.noteContent, parentBody);
  assert.deepEqual(requests[0].payload.existingTitles, ["Untitled note"]);
  assert.equal(requests[0].payload.ai.contextScope, "conversation");
  assert.deepEqual(requests[0].payload.ai.selectedConversationIds, []);
  await click(button("Cancel expansion"));
  assert(requests[0].signal.aborted);
  assert.equal(count(), baselineCount + 1);
  await finish(0, generated("Cancelled"));
  assert.equal(count(), baselineCount + 1, "A late response after Cancel cannot add draft notes");
  assert.equal(container.querySelector('[role="alert"]'), null);
  assert(!aiButton().disabled);

  await click(aiButton());
  assert.equal(requests.length, 2);
  await click(button("Public", ".knowledge-map-switcher button"));
  await finish(1, generated("Systems"));
  assert.equal(count(), baselineCount + 4, "A complete response adds the bounded three-note tree atomically");
  assert.equal(element(".public-knowledge-map").closest(".knowledge-map-panel").hidden, false, "Completion respects a more recent switch to Public");
  assert.deepEqual(state().graphLayouts[parentId], parentLayout, "The public topic keeps its authored map position");
  assert.equal(state().conversations[parentId].notes![0].content, parentBody, "AI expansion preserves the personal parent note");
  const principles = Object.values(state().conversations).find((item) => item.title === "Systems principles")!;
  const detail = Object.values(state().conversations).find((item) => item.title === "Systems feedback loops")!;
  assert.equal(principles.parentId, parentId);
  assert.equal(detail.parentId, principles.id, "Second-level detail belongs below its generated high-level note");
  assert(principles.notes![0].content.includes("AI-generated exploration"));
  assert.equal(principles.publicTopic, undefined);
  assert.equal(state().activeConversationId, child.id, "Background expansion does not replace the user's active editor");
  await click(button("My map", ".knowledge-map-switcher button"));
  assert(element(`[data-conversation-id="${parentId}"]`).classList.contains("is-selected"));
  assert(element(`[data-conversation-id="${detail.id}"]`), "The resulting neighborhood exposes low-level descendants");

  const beforeInvalid = count();
  await click(aiButton());
  await finish(2, { nodes: [{ id: "orphan", parentId: "missing", title: "Broken draft", content: "Invalid hierarchy" }] });
  assert.equal(count(), beforeInvalid, "An invalid response leaves the workspace unchanged");
  assert(element('[role="alert"]').textContent.includes("invalid topic expansion"));
  await click(button("Retry AI expansion"));
  assert.equal(requests.length, 4);
  assert(requests[3].payload.existingTitles.includes("Systems principles"), "Retry includes already created direct children in its context");
  await finish(3, generated("Further"));
  assert.equal(count(), beforeInvalid + 3);
  assert.equal(container.querySelector('[role="alert"]'), null);
  assert(billingRefreshes >= 3, "Completed attempts refresh usage state");

  await click(aiButton());
  const beforeSwitch = count();
  const pending = requests[4];
  assert.equal(pending.userId, account);
  account = "topic-expansion-account-b";
  await render();
  assert(pending.signal.aborted, "Changing accounts aborts the old account's AI operation");
  await finish(4, generated("Late account"));
  assert.equal(count(), baselineCount, "Late results never enter the new account");
  assert.equal(Object.keys(accounts.get("topic-expansion-account-a")!.conversations).length, beforeSwitch, "Late results do not mutate the departed account");
  assert.equal(container.querySelector('[role="alert"]'), null);

  await act(async () => { root.render(createElement(ConversationTreeNode, { conversation: accounts.get("topic-expansion-account-a")!.conversations[child.id], onExpand() {}, registerNodeRef() {} })); });
  assert(container.textContent.includes("Child note"));
  assert(container.textContent.includes("Private note"));
  assert(container.textContent.includes("My own follow-up question."));
  assert(!container.textContent.includes("0 messages"), "A child note is not mislabeled as an empty chat");
  console.log("Child-note editing, AI single-flight, cancel, success, retry, and account-switch checks passed.");
} finally {
  await act(async () => { root.unmount(); });
  await browser.happyDOM.close();
}
