import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { Conversation, ConversationGroup } from "../../client/src/types";

const browser = new Window({ url: "http://jev-group-categories.test/" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { useJevGroupCategories } = await import("../../client/src/lib/useJevGroupCategories");
const { createMainConversation } = await import("../../client/src/initialState");

type Pending = { body: any; userId: string; signal: AbortSignal; resolve(response: Response): void };
const requests: Pending[] = [];
globalThis.fetch = (async (url, init) => {
  assert.equal(url, "/api/jev/workspace", "Group ordering reuses the deployed workspace endpoint");
  assert.equal(init?.credentials, "same-origin");
  const body = JSON.parse(String(init!.body));
  assert.equal(body.enabled, true);
  assert.equal(body.categories, true);
  assert.deepEqual(body.categoryIds, body.items.map((item: any) => item.id));
  assert(!body.groups, "Synthetic group items do not ask for group assignment suggestions");
  return new Promise<Response>((resolve) => requests.push({ body, userId: new Headers(init?.headers).get("X-Margin-Vault-User")!, signal: init!.signal!, resolve }));
}) as typeof fetch;

const conversations: Record<string, Conversation> = {};
const groups: Record<string, ConversationGroup> = {};
for (const [id, name] of [["writing", "Editorial"], ["code-a", "Platform"], ["code-b", "Interfaces"]]) {
  const chat = createMainConversation({ id: `${id}-chat` });
  chat.title = `${name} discussions`;
  chat.messages = [{ id: `${id}-message`, role: "user", content: `Permitted ${name} context`, createdAt: chat.createdAt }];
  conversations[chat.id] = chat;
  groups[id] = { id, name, color: "#4fbf9f", collapsed: false, conversationIds: [chat.id] };
}
let props = { userId: "semantic-map-a", enabled: false, ready: true, conversations, groups };
let latest!: ReturnType<typeof useJevGroupCategories>;
function Harness() { latest = useJevGroupCategories(props); return null; }
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container);
async function render() { await act(async () => { root.render(createElement(Harness)); }); }
async function settle() { await act(async () => { await new Promise((resolve) => setTimeout(resolve, 430)); }); }
async function respond(request: Pending, categories: Array<{ id: string; categoryId: string; confidence: number }>, available = true) {
  await act(async () => { request.resolve(Response.json({ available, categories, evaluatedCategoryIds: request.body.items.map((item: any) => item.id), related: [] })); });
}
const confident = (id: string, categoryId: string) => ({ id, categoryId, confidence: 0.9 });

try {
  await render(); await settle();
  assert.equal(latest.status, "off"); assert.equal(requests.length, 0);
  props = { ...props, enabled: true, ready: false };
  await render(); await settle();
  assert.equal(latest.status, "off"); assert.equal(requests.length, 0, "Unready workspaces do not send group content");
  props = { ...props, ready: true };
  await render(); await settle();
  assert.equal(requests.length, 1);
  assert.deepEqual(latest.orderedGroupIds, ["writing", "code-a", "code-b"], "Loading preserves the existing group order");
  await respond(requests[0], [confident("writing", "writing"), confident("code-a", "coding"), confident("code-b", "coding")]);
  assert.equal(latest.status, "ready");
  assert.deepEqual(latest.orderedGroupIds, ["code-a", "code-b", "writing"]);
  assert.equal(latest.categoryLabels["code-a"], "Coding");
  const stable = latest;
  props = { ...props, groups: { ...props.groups, writing: { ...props.groups.writing, collapsed: true, color: "#123456" } },
    conversations: { ...props.conversations, "writing-chat": { ...props.conversations["writing-chat"], updatedAt: "2026-09-22", notes: [{ id: "private", kind: "comment", content: "Private margin annotation" } as any] } } };
  await render(); await settle();
  assert.equal(requests.length, 1, "Camera-like rerenders, colors, collapsing, and private annotations never request reanalysis");
  assert.equal(latest.orderedGroupIds, stable.orderedGroupIds, "Unchanged semantics preserve the exact ordering reference for map geometry");
  assert.equal(latest.categories, stable.categories);

  props = { ...props, groups: { ...props.groups, "code-a": { ...props.groups["code-a"], name: "Visual direction" } } };
  await render(); await settle();
  assert.deepEqual(requests[1].body.items.map((item: any) => item.id), ["code-a"], "Only changed group evidence is reclassified");
  assert.deepEqual(latest.orderedGroupIds, stable.orderedGroupIds, "Pending reclassification retains the completed layout");
  await respond(requests[1], [confident("code-a", "design")]);
  assert.deepEqual(latest.orderedGroupIds, ["code-b", "writing", "code-a"]);

  props = { ...props, groups: { ...props.groups, "code-a": { ...props.groups["code-a"], name: "Miscellaneous ambiguous material" } } };
  await render(); await settle();
  await respond(requests[2], [{ id: "code-a", categoryId: "design", confidence: 0.2 }]);
  assert(!Object.hasOwn(latest.categories, "code-a"), "Uncertain judgments use fallback ordering rather than an invented category");
  await act(async () => { root.render(null); }); await render(); await settle();
  assert.equal(requests.length, 3, "Successful uncertainty is cached across remounts");

  props = { ...props, groups: { ...props.groups, writing: { ...props.groups.writing, name: "Changed editorial" } } };
  await render(); await settle();
  const stale = requests[3];
  props = { ...props, enabled: false };
  await render();
  assert(stale.signal.aborted, "Disabling Jev aborts pending group analysis");
  await respond(stale, [confident("writing", "personal")]);
  assert.equal(latest.status, "off"); assert.deepEqual(latest.categories, Object.create(null));
  props = { ...props, enabled: true };
  await render(); await settle();
  assert.equal(requests.length, 5, "An abort-ignoring response cannot populate the semantic cache");
  await respond(requests[4], [confident("writing", "writing")]);

  props = { ...props, userId: "semantic-map-b" };
  await render();
  assert.deepEqual(Object.keys(latest.categories), [], "Account changes never show another account's categories");
  await settle();
  assert.equal(requests[5].userId, "semantic-map-b");
  assert.equal(requests[5].body.items.length, 3, "A new account does not reuse the previous account's judgments");
  await respond(requests[5], [], false);
  assert.equal(latest.status, "unavailable");
  assert.deepEqual(latest.orderedGroupIds, Object.keys(props.groups), "Service failures preserve usable original ordering");
  props = { ...props, userId: "semantic-map-a" };
  await render(); await settle();
  assert.equal(requests.length, 6, "Returning to an account restores cached category judgments");
  assert.equal(latest.categories.writing, "writing");

  const manyGroups = Object.fromEntries(Array.from({ length: 23 }, (_, index) => {
    const id = `group-${String(index).padStart(2, "0")}`;
    return [id, { id, name: `Workspace group ${index}`, color: "#4fbf9f", collapsed: false, conversationIds: ["writing-chat"] }];
  }));
  props = { ...props, userId: "semantic-map-batches", groups: manyGroups };
  await render(); await settle();
  assert.equal(requests.length, 8, "Group batches run at most two requests concurrently");
  assert.equal(requests[6].body.items.length, 10); assert.equal(requests[7].body.items.length, 10);
  await respond(requests[6], requests[6].body.items.map((item: any) => confident(item.id, "writing")));
  assert.equal(requests.length, 9); assert.equal(requests[8].body.items.length, 3);
  assert.equal(latest.status, "loading");
  assert.deepEqual(Object.keys(latest.categories), [], "Partial batches do not progressively rearrange the map");
  await respond(requests[7], requests[7].body.items.map((item: any) => confident(item.id, "coding")));
  assert.equal(latest.status, "loading");
  await respond(requests[8], requests[8].body.items.map((item: any) => confident(item.id, "research")));
  assert.equal(latest.status, "ready"); assert.equal(Object.keys(latest.categories).length, 23);
  assert.equal(latest.orderedGroupIds[0], "group-10");
  console.log("Jev map groups preserve consent, cached evidence, stable layout, uncertainty, account isolation, cancellation, and bounded batches.");
} finally {
  await act(async () => { root.unmount(); });
  await browser.happyDOM.close();
}
