import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { Conversation } from "../../client/src/types";
import type { VaultIndexEntry } from "../../client/src/lib/vaultTypes";

const browser = new Window({ url: "http://vault-search.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "Text", "NodeFilter", "Document", "DocumentFragment", "MutationObserver", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "FocusEvent", "getComputedStyle"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value: name === "getComputedStyle" ? value.bind(browser) : value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: VaultSearchPalette } = await import("../../client/src/components/VaultSearchPalette");
const { createLocalVaultSearchProvider, createVaultSearchProvider } = await import("../../client/src/lib/vaultSearch");

const at = "2026-10-06T10:00:00Z";
const chat = (id: string, title: string, content: string, updatedAt = at, extra: Partial<Conversation> = {}) => ({
  id, title, branchAnchor: null, childIds: [], parentId: null, serviceId: "backend-services", modelId: "auto", createdAt: updatedAt, updatedAt,
  messages: [{ id: `${id}-m`, role: "assistant", content, createdAt: updatedAt }], ...extra,
}) as Conversation;
const conversations: Record<string, Conversation> = {
  heat: chat("heat", "Urban heat draft", "Shade changes the picture at street level."),
  trees: chat("trees", "Trees vs. shade sails", "Fabric shade only blocks light.", "2026-10-07T10:00:00Z", { parentId: "heat" }),
};
const cloudDocuments: VaultIndexEntry[] = [{ path: "school.md", id: "school", type: "conversation", kind: "chat", title: "Shade structures for the school yard", revision: "1", updated: "2025-03-12T10:00:00Z" }];
let provider = createLocalVaultSearchProvider(() => ({ conversations, cloudDocuments }));
const opened: string[] = [];
let explored = 0;
const kept: string[] = [];
let setOpen!: (value: boolean) => void;

function Host() {
  const [open, updateOpen] = useState(false), [query, setQuery] = useState("");
  setOpen = updateOpen;
  return createElement(VaultSearchPalette, {
    isOpen: open, onClose() { updateOpen(false); }, query, onQueryChange: setQuery, provider, conversations,
    currentConversationId: "heat", currentFamilyTitle: "Urban heat draft",
    onOpenDocument(hit, mode) { opened.push(`${mode}:${hit.target.kind === "cloud" ? hit.target.path : hit.target.conversationId}`); updateOpen(false); },
    onOpenPassage(hit, mode) { opened.push(`${mode}:passage:${hit.conversationId}`); updateOpen(false); },
    onExplore() { explored++; },
    onKeepOpen(query, scope) { kept.push(`${scope}:${query}`); updateOpen(false); },
  });
}
const container = browser.document.createElement("div"); browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const dialog = () => browser.document.querySelector<HTMLElement>('[role="dialog"]');
const input = () => dialog()!.querySelector<HTMLInputElement>('input[type="search"]')!;
const rows = () => [...dialog()!.querySelectorAll<HTMLElement>(".vault-search-row")];
const selectedTitle = () => dialog()!.querySelector(".vault-search-row.is-selected .vault-search-row-title")?.textContent;
const type = async (value: string) => { await act(async () => { Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input(), value); input().dispatchEvent(new browser.Event("input", { bubbles: true })); }); };
const key = async (value: string, init: Record<string, boolean> = {}) => { await act(async () => { input().dispatchEvent(new browser.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...init })); }); };
const checks: string[] = [];

await act(async () => { root.render(createElement(Host)); });
await act(async () => { setOpen(true); });
assert.equal(browser.document.activeElement, input());
assert.deepEqual(rows().map((row) => row.querySelector(".vault-search-row-title")?.textContent), ["Trees vs. shade sails", "Urban heat draft"]);
checks.push("opens focused on the box with recent documents");

await type("shade");
const titles = rows().map((row) => row.querySelector(".vault-search-row-title")?.textContent);
assert.deepEqual(titles.slice(0, 2), ["Trees vs. shade sails", "Shade structures for the school yardIn cloud"]);
assert.equal(dialog()!.querySelectorAll(".vault-search-snippet").length, 2, "Passages from both documents follow the titles.");
assert(dialog()!.querySelector(".vault-search-preview h3")?.textContent?.includes("Trees vs. shade sails"), "The first result is previewed.");
checks.push("titles from the device and the cloud come first, then passages");

await key("ArrowDown");
assert.equal(selectedTitle(), "Shade structures for the school yardIn cloud");
assert(dialog()!.querySelector(".vault-search-preview")?.textContent?.includes("still in your cloud vault"));
await key("Enter");
assert.deepEqual(opened, ["here:school.md"]);
assert.equal(dialog(), null);
checks.push("arrow keys move the selection and Enter opens here");

await act(async () => { setOpen(true); });
assert.equal(input().value, "shade", "The last search is kept for the next Cmd+K.");
await key("ArrowDown"); await key("ArrowDown");
await key("Enter", { metaKey: true });
assert.match(opened.at(-1)!, /^beside:passage:(heat|trees)$/);
checks.push("Cmd+Enter opens a passage beside");

await act(async () => { setOpen(true); });
const familyChip = [...dialog()!.querySelectorAll<HTMLButtonElement>(".vault-search-scopes button")].find((button) => button.textContent === "In Urban heat draft")!;
await act(async () => { familyChip.click(); });
assert.equal(familyChip.getAttribute("aria-pressed"), "true");
assert(!rows().some((row) => row.textContent?.includes("school yard")), "Cloud documents have no family yet, so the family scope leaves them out.");
await type("zzzz");
assert(dialog()!.querySelector(".vault-search-empty")?.textContent?.includes("Try Anywhere"));
checks.push("scopes narrow results and an empty result says what to try");

await act(async () => { [...dialog()!.querySelectorAll<HTMLButtonElement>(".vault-search-explore")].find((button) => button.textContent === "Filters and connections")!.click(); });
assert.equal(explored, 1);
await key("Escape");
assert.equal(dialog(), null);
checks.push("filters and connections stay one click away, Escape closes");

await act(async () => { setOpen(true); });
await type("shade");
await key("Enter", { shiftKey: true });
assert.equal(kept.at(-1), "family:shade", "The scope chosen earlier carries over.");
assert.equal(dialog(), null);
checks.push("Shift+Enter keeps the results open");

// The server streams passages from documents that are not on this device.
let finishCloud!: () => void;
provider = createVaultSearchProvider(() => ({ conversations, cloudDocuments }), async (_query, _options, onEvent) => {
  onEvent({ type: "documents", results: [] });
  await new Promise<void>((resolve) => { finishCloud = resolve; });
  onEvent({ type: "passages", source: "documents", results: [{ id: "porch", path: "porch.md", title: "Porch ideas", source: "document",
    snippet: "a deep shade over the steps", match: { start: 7, end: 12 }, position: { blockId: "b1", start: 7, end: 12 }, updated: "2026-10-08T10:00:00Z" }] });
  onEvent({ type: "done", revision: 3 });
});
await act(async () => { root.render(createElement(Host)); setOpen(true); });
await act(async () => { [...dialog()!.querySelectorAll<HTMLButtonElement>(".vault-search-scopes button")].find((button) => button.textContent === "Anywhere")!.click(); });
await type("steps");
assert(dialog()!.querySelector(".vault-search-empty")?.textContent?.includes("Searching your whole vault"), "No premature 'nothing matches' while the server is still searching.");
await act(async () => { await new Promise((resolve) => setTimeout(resolve, 200)); finishCloud(); await new Promise((resolve) => setTimeout(resolve, 0)); });
assert(selectedTitle()?.startsWith("Porch ideasIn cloud"), "The cloud passage is listed and marked as still in the cloud.");
assert(dialog()!.querySelector(".vault-search-preview")?.textContent?.includes("still in your cloud vault"));
await key("Enter");
assert.equal(opened.at(-1), "here:passage:porch");
checks.push("passages the server finds in cloud documents stream in and open");

await act(async () => { root.unmount(); });
console.log(JSON.stringify({ checks }));
