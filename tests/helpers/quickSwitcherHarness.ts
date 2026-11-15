import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { Conversation } from "../../client/src/types";
import type { VaultIndexEntry } from "../../client/src/lib/vaultTypes";

const browser = new Window({ url: "http://quick-switcher.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "Text", "NodeFilter", "Document", "DocumentFragment", "MutationObserver", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "FocusEvent", "getComputedStyle"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value: name === "getComputedStyle" ? value.bind(browser) : value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement, useState } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: VaultSearchPalette, rankTitles, newDocumentTitle } = await import("../../client/src/components/VaultSearchPalette");
const { createLocalVaultSearchProvider, createVaultSearchProvider } = await import("../../client/src/lib/vaultSearch");

const at = "2026-10-06T10:00:00Z";
const chat = (id: string, title: string, content: string, updatedAt = at) => ({
  id, title, branchAnchor: null, childIds: [], parentId: null, serviceId: "backend-services", modelId: "auto", createdAt: updatedAt, updatedAt,
  messages: [{ id: `${id}-m`, role: "assistant", content, createdAt: updatedAt }],
}) as Conversation;
const conversations: Record<string, Conversation> = {
  heat: chat("heat", "Urban heat draft", "Shade changes the picture at street level."),
  trees: chat("trees", "Trees vs. shade sails", "Fabric shade only blocks light.", "2026-10-07T10:00:00Z"),
  shade: chat("shade", "Shade", "Short title.", "2026-10-01T10:00:00Z"),
};
let provider = createLocalVaultSearchProvider(() => ({ conversations, cloudDocuments: [] }));
let variant: "search" | "switcher" = "switcher";
const opened: string[] = [];
const created: string[] = [];
let setOpen!: (value: boolean) => void;

function Host() {
  const [open, updateOpen] = useState(false), [query, setQuery] = useState("");
  setOpen = updateOpen;
  return createElement(VaultSearchPalette, {
    isOpen: open, variant, onClose() { updateOpen(false); }, query, onQueryChange: setQuery, provider, conversations,
    currentConversationId: "heat", currentFamilyTitle: "Urban heat draft",
    onOpenDocument(hit, mode) { opened.push(`${mode}:${hit.target.kind === "cloud" ? hit.target.path : hit.target.conversationId}`); updateOpen(false); },
    onOpenPassage(hit, mode) { opened.push(`${mode}:passage:${hit.conversationId}`); updateOpen(false); },
    onCreateDocument(title) { created.push(title); updateOpen(false); },
    onAnswer() { throw new Error("The switcher never asks AI."); },
    onKeepOpen() { throw new Error("The switcher never keeps results open."); },
  });
}
const container = browser.document.createElement("div"); browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const dialog = () => browser.document.querySelector<HTMLElement>('[role="dialog"]');
const input = () => dialog()!.querySelector<HTMLInputElement>('input[type="search"]')!;
const titles = () => [...dialog()!.querySelectorAll<HTMLElement>(".vault-search-row .vault-search-row-title")].map((row) => row.textContent);
const selectedTitle = () => dialog()!.querySelector(".vault-search-row.is-selected .vault-search-row-title")?.textContent;
const setValue = async (value: string) => { await act(async () => { Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input(), value); input().dispatchEvent(new browser.Event("input", { bubbles: true })); }); };
const wait = async (ms = 200) => { await act(async () => { await new Promise((resolve) => setTimeout(resolve, ms)); }); };
const type = async (value: string) => { await setValue(value); await wait(); };
const key = async (value: string, init: Record<string, boolean> = {}) => { await act(async () => { input().dispatchEvent(new browser.KeyboardEvent("keydown", { key: value, bubbles: true, cancelable: true, ...init })); }); };
const reopen = async () => { await act(async () => { setOpen(false); }); await act(async () => { setOpen(true); }); await type(""); };
const checks: string[] = [];

await act(async () => { root.render(createElement(Host)); });
await act(async () => { setOpen(true); });
assert.equal(browser.document.activeElement, input());
assert.equal(input().placeholder, "Find or create a document…");
assert.equal(dialog()!.querySelector(".vault-search-scopes"), null, "No scope filters in the switcher.");
assert.deepEqual(titles(), ["Trees vs. shade sails", "Urban heat draft", "Shade"]);
checks.push("opens on recent documents with a plain title box");

// "picture" is only in a document's text: the semantic search would find it, the switcher does not.
await type("Sleep  protocol ");
assert.deepEqual(titles(), ["+ Create “Sleep protocol”"]);
assert.equal(dialog()!.querySelectorAll(".vault-search-snippet").length, 0);
await type("picture");
assert.deepEqual(titles(), ["+ Create “picture”"], "Text inside documents doesn't match; only titles do.");
assert.equal(dialog()!.querySelector(".vault-search-preview h3")?.textContent, "picture");
await key("Enter");
assert.deepEqual(created, ["picture"]);
assert.equal(dialog(), null);
checks.push("Enter creates a document when no title matches, even if the words are in a document's text");

await reopen();
await type("shade");
assert.deepEqual(titles(), ["Shade", "Trees vs. shade sails"], "The exact title comes first, and no Create row since it exists.");
await key("Enter");
assert.deepEqual(opened, ["here:shade"]);
checks.push("an exact title opens and is ranked first");

await reopen();
await type("sha");
assert.deepEqual(titles(), ["Shade", "Trees vs. shade sails", "+ Create “sha”"], "Titles that start with the words come first; Create is last.");
assert.equal(selectedTitle(), "Shade");
await key("Enter", { metaKey: true });
assert.deepEqual(opened.at(-1), "beside:shade");
await reopen();
await type("sha");
await key("Enter", { shiftKey: true });
assert.deepEqual(created.at(-1), "sha");
checks.push("partial matches open with Enter; Shift+Enter always creates");

// Enter pressed while titles are still coming from the cloud waits for them, so it opens the cloud document.
const cloudDocuments: VaultIndexEntry[] = [];
provider = createVaultSearchProvider(() => ({ conversations, cloudDocuments }), async (_query, _options, onEvent) => {
  await new Promise((resolve) => setTimeout(resolve, 150));
  onEvent({ type: "documents", results: [{ path: "sleep.md", id: "sleep", type: "conversation", kind: "chat", title: "Sleep log", revision: "1", updated: at }] });
  onEvent({ type: "done", revision: 1 });
});
await act(async () => { setOpen(false); });
await act(async () => { root.render(createElement(Host)); setOpen(true); });
await setValue("sleep log");
await key("Enter");
assert.equal(created.length, 2, "Nothing is created while the search is catching up.");
await wait(600);
assert.equal(opened.at(-1), "here:sleep.md");
assert.equal(created.length, 2);
checks.push("Enter typed ahead of the cloud waits and opens the cloud document instead of making a duplicate");

// Cmd+K keeps its full search, with no Create row.
variant = "search";
provider = createLocalVaultSearchProvider(() => ({ conversations, cloudDocuments: [] }));
await act(async () => { root.render(createElement(Host)); setOpen(true); });
await type("unheard of words");
assert(!titles().some((title) => title?.includes("Create")));
assert(dialog()!.querySelector(".vault-search-scopes"));
checks.push("Cmd+K search is unchanged");

assert.equal(newDocumentTitle("  a\n b  "), "a b");
assert.deepEqual(rankTitles([{ title: "b x" }, { title: "x" }, { title: "x y" }] as never, "X").map((hit: { title: string }) => hit.title), ["x", "x y", "b x"]);
checks.push("titles are tidied and ranked exact, then prefix");

await act(async () => { root.unmount(); });
console.log(JSON.stringify({ checks }));
