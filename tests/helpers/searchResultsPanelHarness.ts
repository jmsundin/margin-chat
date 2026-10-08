import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { Conversation } from "../../client/src/types";
import type { VaultIndexEntry } from "../../client/src/lib/vaultTypes";

const browser = new Window({ url: "http://search-results.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "Text", "NodeFilter", "Document", "DocumentFragment", "MutationObserver", "Event", "MouseEvent", "PointerEvent", "KeyboardEvent", "FocusEvent", "getComputedStyle"]) {
  const value = name === "window" ? browser : (browser as any)[name];
  if (value !== undefined) Object.defineProperty(globalThis, name, { configurable: true, value: name === "getComputedStyle" ? value.bind(browser) : value });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: SearchResultsPanel } = await import("../../client/src/components/SearchResultsPanel");
const { createLocalVaultSearchProvider } = await import("../../client/src/lib/vaultSearch");

const chat = (id: string, title: string, content: string, updatedAt: string, extra: Partial<Conversation> = {}) => ({
  id, title, branchAnchor: null, childIds: [], parentId: null, serviceId: "backend-services", modelId: "auto", createdAt: updatedAt, updatedAt,
  messages: [{ id: `${id}-m`, role: "assistant", content, createdAt: updatedAt }], ...extra,
}) as Conversation;
const conversations: Record<string, Conversation> = {
  heat: chat("heat", "Urban heat draft", "Shade changes the picture at street level.", "2026-10-06T10:00:00Z"),
  trees: chat("trees", "Trees vs. shade sails", "Fabric shade only blocks light.", "2026-10-07T10:00:00Z", { parentId: "heat" }),
  budget: chat("budget", "City budget", "Planting for shade competes with potholes.", "2024-11-20T10:00:00Z"),
};
const cloudDocuments: VaultIndexEntry[] = [{ path: "school.md", id: "school", type: "conversation", kind: "chat", title: "Shade structures for the school yard", revision: "1", updated: "2025-03-12T10:00:00Z" }];
const provider = createLocalVaultSearchProvider(() => ({ conversations, cloudDocuments }));
const opened: string[] = [];
let closed = 0;

const container = browser.document.createElement("div"); browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const panel = () => container.querySelector<HTMLElement>(".search-results-panel")!;
const families = () => [...panel().querySelectorAll(".search-results-family")].map((element) => element.textContent);
const rowTitles = () => [...panel().querySelectorAll(".search-results-row .vault-search-row-title")].map((element) => element.textContent);
const buttonByText = (text: string) => [...panel().querySelectorAll<HTMLButtonElement>("button")].find((button) => button.textContent?.trim() === text)!;
const checks: string[] = [];

await act(async () => { root.render(createElement(SearchResultsPanel, {
  initialQuery: "shade", initialScope: "all", provider, currentConversationId: "heat",
  onOpenDocument(hit, mode) { opened.push(`${mode}:${hit.target.kind === "cloud" ? hit.target.path : hit.target.conversationId}`); },
  onOpenPassage(hit, mode) { opened.push(`${mode}:passage:${hit.conversationId}`); },
  onClose() { closed++; },
})); });
assert.equal(panel().querySelector("input")!.value, "shade");
assert.deepEqual(families(), ["Urban heat draft", "Shade structures for the school yard", "City budget"]);
assert(panel().querySelector('[role="status"]')!.textContent?.includes("in 4 documents"));
checks.push("results group by family");

await act(async () => { buttonByText("2024").click(); });
assert.deepEqual(families(), ["City budget"]);
assert.equal(buttonByText("2024").getAttribute("aria-pressed"), "true");
await act(async () => { buttonByText("2024").click(); });
assert.equal(families().length, 3);
checks.push("the year bar narrows by year and clears on a second click");

const rows = [...panel().querySelectorAll<HTMLButtonElement>(".search-results-row")];
await act(async () => { rows[0].click(); });
assert.equal(opened.at(-1), "beside:trees");
assert(rows[0].classList.contains("is-open"), "The opened result stays marked.");
await act(async () => { rows[0].dispatchEvent(new browser.MouseEvent("click", { bubbles: true, metaKey: true })); });
assert.equal(opened.at(-1), "here:trees");
assert(panel(), "Results stay open after opening one.");
checks.push("a click opens beside, Cmd-click opens here, and results stay");

await act(async () => { buttonByText("Newest").click(); });
assert.equal(families().length, 0);
assert.equal(rowTitles()[0], "Trees vs. shade sails");
await act(async () => { panel().querySelector<HTMLButtonElement>('[aria-label="Close search results"]')!.click(); });
assert.equal(closed, 1);
checks.push("results can be listed newest first and the panel closes");

await act(async () => { root.unmount(); });
console.log(JSON.stringify({ checks }));
