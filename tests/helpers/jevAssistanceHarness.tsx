import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://jev.test/" });
for (const name of ["window", "document", "navigator", "localStorage", "HTMLElement", "Element", "Node", "Text", "Document", "DocumentFragment", "MutationObserver", "Event", "MouseEvent"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { createEmptyState, createStandaloneNoteConversation } = await import("../../client/src/initialState");
const { useJevAssistance, useJevPreference } = await import("../../client/src/lib/useJevAssistance");
const { default: JevRelatedItems } = await import("../../client/src/components/JevRelatedItems");

const realSetTimeout = globalThis.setTimeout;
const realClearTimeout = globalThis.clearTimeout;
const realDateNow = Date.now;
let simulatedTime = realDateNow();
Date.now = () => simulatedTime;
let timerId = -1;
const trailing = new Map<number, () => unknown>();
globalThis.setTimeout = ((fn: () => unknown, milliseconds: number, ...args: any[]) => {
  if (milliseconds !== 1200) return realSetTimeout(fn, milliseconds, ...args);
  const id = timerId--; trailing.set(id, fn); return id;
}) as any;
globalThis.clearTimeout = ((id: any) => { if (!trailing.delete(id)) realClearTimeout(id); }) as any;

let state = createEmptyState();
const chatId = state.rootId;
state.conversations[chatId].title = "Current story";
state.conversations[chatId].messages = [{ id: "prompt", role: "user", content: "Story idea", createdAt: state.conversations[chatId].createdAt }];
const note = createStandaloneNoteConversation({ id: "related-note", noteId: "body" });
note.title = "Related outline";
note.notes![0].content = "A related story.";
state.conversations[note.id] = note;
state.groups = { stories: { id: "stories", name: "Story project", color: "#4fbf9f", collapsed: false, conversationIds: [note.id] } };
let props = { userId: "first-account", ready: true, currentId: chatId, pending: false };
let preference: ReturnType<typeof useJevPreference>;
let assistance: ReturnType<typeof useJevAssistance>;
let selected = "";
let configured = true;
let hold = false;
let uncertainId: string | null = null;
let omitCategoryCoverage = false;
const requests: Array<{ body: any; signal: AbortSignal; resolve?: (response: Response) => void }> = [];
let statusCalls = 0;
globalThis.fetch = (async (url, init) => {
  assert.equal(new Headers(init?.headers).get("X-Margin-Vault-User"), props.userId);
  if (url === "/api/jev/status") { statusCalls++; return Response.json({ configured }); }
  assert.equal(url, "/api/jev/workspace");
  const request = { body: JSON.parse(String(init?.body)), signal: init?.signal as AbortSignal, resolve: undefined as ((response: Response) => void) | undefined };
  requests.push(request);
  if (hold) return await new Promise<Response>((resolve) => { request.resolve = resolve; });
  return responseFor(request.body);
}) as typeof fetch;
function responseFor(body: any) {
  const evaluated = body.categories ? body.items.filter((item: any) => !body.categoryIds || body.categoryIds.includes(item.id)) : [];
  return Response.json({ available: true,
    categories: evaluated.filter((item: any) => item.id !== uncertainId).map((item: any) => ({ id: item.id, categoryId: "writing", confidence: 0.9 })),
    ...(omitCategoryCoverage ? {} : { evaluatedCategoryIds: evaluated.map((item: any) => item.id) }),
    related: body.items.filter((item: any) => item.id !== body.current.id).map((item: any) => ({ id: item.id, score: 0.9 })),
    groupSuggestions: body.groups?.length ? [{ id: body.current.id, groupId: body.groups[0].id, confidence: 0.9 }] : [],
  });
}
function Harness() {
  preference = useJevPreference(props.userId);
  assistance = useJevAssistance({ ...props, enabled: preference[0], conversations: state.conversations, groups: state.groups });
  return createElement(JevRelatedItems, { ...assistance, conversations: state.conversations, currentId: props.currentId, onSelect: (id: string) => { selected = id; } });
}
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
async function render() { await act(async () => { root.render(createElement(Harness)); }); }
async function flushTrailing() {
  await act(async () => {
    const callbacks = [...trailing.values()]; trailing.clear();
    for (const callback of callbacks) void callback();
    await new Promise<void>((resolve) => realSetTimeout(resolve, 0));
  });
}
function edit(text: string) {
  state = { ...state, conversations: { ...state.conversations, [chatId]: { ...state.conversations[chatId], messages: [{ ...state.conversations[chatId].messages[0], content: text }] } } };
}
try {
  await render();
  assert.equal(preference![0], true, "New accounts start with requested automatic organization enabled");
  assert.equal(statusCalls, 1);
  assert.equal(requests.length, 0);
  await act(async () => { preference![1](false); });
  assert.equal(assistance!.status, "off");
  assert.equal(trailing.size, 0, "Explicit opt-out cancels queued organization");
  await act(async () => { preference![1](true); });
  assert.equal(statusCalls, 2);
  assert.equal(requests.length, 0, "Workspace work waits for the trailing debounce");
  edit("First edit"); await render();
  edit("Final edit"); await render();
  assert.equal(trailing.size, 1, "Typing coalesces into one request");
  await flushTrailing();
  assert.equal(requests.length, 1);
  assert(requests[0].body.current.content.includes("Final edit"));
  assert.equal(assistance!.status, "ready");
  assert.equal(assistance!.categories[chatId], "writing");
  assert.deepEqual(assistance!.groupSuggestions[chatId], { groupId: "stories", confidence: 0.9 });
  await act(async () => { container.querySelector(".jev-related-trigger")!.dispatchEvent(new browser.MouseEvent("click", { bubbles: true })); });
  assert(browser.document.querySelector(".jev-related-popover")?.textContent.includes("Related outline"));
  await act(async () => { browser.document.querySelector(".jev-related-links button")!.dispatchEvent(new browser.MouseEvent("click", { bubbles: true })); });
  assert.equal(selected, note.id, "Related suggestion navigates to its real item");

  state = { ...state, conversations: { ...state.conversations, [chatId]: { ...state.conversations[chatId], updatedAt: "2099-01-01T00:00:00Z", notes: [{ ...note.notes![0], kind: "comment", content: "PRIVATE" }] } } };
  await render(); await flushTrailing();
  assert.equal(requests.length, 1, "Private annotation changes do not issue inference requests");

  props = { ...props, currentId: note.id }; await render(); await flushTrailing();
  assert.equal(requests.length, 2);
  assert.equal(requests[1].body.categories, false, "Navigation reuses content category judgments");
  assert.deepEqual(requests[1].body.categoryIds, []);
  props = { ...props, currentId: chatId }; await render(); await flushTrailing();
  assert.equal(requests.length, 2, "Returning to unchanged context reuses related results");

  props = { ...props, pending: true }; edit("Streaming first token"); await render();
  edit("Streaming next token"); await render(); await flushTrailing();
  assert.equal(requests.length, 2);
  assert.equal(assistance!.status, "paused");
  props = { ...props, pending: false }; hold = true; await render(); await flushTrailing();
  assert.equal(requests.length, 3);
  assert.deepEqual(requests[2].body.categoryIds, [chatId], "Editing one item requests only its category");
  assert.equal(assistance!.categories[chatId], undefined, "Edited content cannot reuse its old category");
  props = { ...props, currentId: note.id }; await render();
  assert(requests[2].signal.aborted, "Navigation aborts stale analysis");
  await act(async () => { requests[2].resolve!(responseFor(requests[2].body)); });
  assert.equal(assistance!.status, "loading", "An aborted response ignored by transport still cannot replace the new view");
  hold = false; await flushTrailing();
  assert.equal(assistance!.status, "ready");

  hold = true; edit("Account switch in flight"); await render(); await flushTrailing();
  const oldAccountRequest = requests.at(-1)!;
  browser.localStorage.setItem("margin-chat-jev-assistance:second-account", "false");
  props = { ...props, userId: "second-account" }; await render();
  assert.equal(preference![0], false, "Another account retains its explicit opt-out");
  assert.equal(assistance!.status, "off");
  assert(oldAccountRequest.signal.aborted);
  await act(async () => { oldAccountRequest.resolve!(responseFor(oldAccountRequest.body)); });
  assert.equal(assistance!.status, "off");
  assert.deepEqual(assistance!.categories, {});
  assert.deepEqual(assistance!.groupSuggestions, {});

  configured = false; hold = false;
  await act(async () => { preference![1](true); }); await flushTrailing();
  assert.equal(assistance!.status, "unconfigured");
  assert.deepEqual(assistance!.related, []);
  assert.equal(container.querySelector('.jev-related-control'), null, "Unavailable suggestions do not render an empty Related control");
  await act(async () => { preference![1](false); });
  assert.equal(container.textContent, "");

  configured = true;
  await act(async () => { preference![1](true); }); await flushTrailing();
  assert.equal(assistance!.groupSuggestions[props.currentId].groupId, "stories");
  hold = true;
  state = { ...state, groups: { stories: { ...state.groups.stories, name: "Old renamed group" } } };
  await render(); await flushTrailing();
  const oldGroupRequest = requests.at(-1)!;
  assert.deepEqual(assistance!.groupSuggestions, {}, "Old group suggestions disappear while names are re-evaluated");
  state = { ...state, groups: { stories: { ...state.groups.stories, name: "Current renamed group" } } };
  await render();
  assert(oldGroupRequest.signal.aborted);
  await act(async () => { oldGroupRequest.resolve!(responseFor(oldGroupRequest.body)); });
  assert.deepEqual(assistance!.groupSuggestions, {}, "An obsolete group-name response cannot be applied");
  hold = false; await flushTrailing();
  assert.equal(assistance!.status, "ready");
  assert.equal(assistance!.groupSuggestions[props.currentId].groupId, "stories");
  assert.equal(requests.at(-1)!.body.groups[0].name, "Current renamed group");
  assert.deepEqual(requests.at(-1)!.body.categoryIds, []);
  const positiveState = state;

  uncertainId = note.id;
  state = { ...state, conversations: { ...state.conversations, [note.id]: { ...state.conversations[note.id], notes: [{ ...note.notes![0], content: "Ambiguous newly edited material" }] } } };
  await render(); await flushTrailing();
  assert.deepEqual(requests.at(-1)!.body.categoryIds, [note.id]);
  assert.equal(assistance!.categories[note.id], undefined, "Valid uncertainty clears an obsolete category");
  const uncertainState = state;
  simulatedTime += 120_000;
  state = { ...state, groups: { stories: { ...state.groups.stories, name: "Another group name" } } };
  await render(); await flushTrailing();
  assert.deepEqual(requests.at(-1)!.body.categoryIds, [], "Valid uncertainty is cached across unrelated changes");
  const laterAggregateState = state;
  const beforeUndo = requests.length;
  state = positiveState; await render(); await flushTrailing();
  assert.equal(requests.length, beforeUndo, "Undo can reuse an aggregate whose request omitted all categories");
  assert.equal(assistance!.categories[note.id], "writing", "Undo restores the earlier positive judgment after uncertainty");
  state = uncertainState; await render(); await flushTrailing();
  assert.equal(requests.length, beforeUndo, "Redo can reuse an aggregate whose request evaluated only one category");
  assert.equal(assistance!.categories[note.id], undefined, "Redo restores the valid uncertain judgment");
  assert.equal(assistance!.categories[chatId], "writing", "Subset aggregate snapshots retain reused positive judgments too");

  simulatedTime += 180_001;
  state = laterAggregateState; await render(); await flushTrailing();
  assert.equal(requests.length, beforeUndo + 1, "A fresh aggregate cannot suppress refresh of expired category coverage");
  assert.deepEqual([...requests.at(-1)!.body.categoryIds].sort(), [chatId, note.id].sort(), "Restoring snapshots preserves original category timestamps");

  omitCategoryCoverage = true;
  state = { ...state, conversations: { ...state.conversations, [note.id]: { ...state.conversations[note.id], notes: [{ ...note.notes![0], content: "Ambiguous material without server coverage" }] } } };
  await render(); await flushTrailing();
  const missingCoverageState = state;
  state = { ...state, groups: { stories: { ...state.groups.stories, name: "A temporary detour" } } };
  await render(); await flushTrailing();
  const beforeMissingCoverageReturn = requests.length;
  state = missingCoverageState; await render(); await flushTrailing();
  assert.equal(requests.length, beforeMissingCoverageReturn + 1, "Incomplete cached category coverage remains retryable");
  assert.deepEqual(requests.at(-1)!.body.categoryIds, [note.id]);
  console.log(JSON.stringify({ result: "pass" }));
} finally {
  await act(async () => { root.unmount(); });
  globalThis.setTimeout = realSetTimeout;
  globalThis.clearTimeout = realClearTimeout;
  Date.now = realDateNow;
  await browser.happyDOM.close();
}
