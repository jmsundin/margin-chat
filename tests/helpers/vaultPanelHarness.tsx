import assert from "node:assert/strict";
import { Window } from "happy-dom";
import type { VaultConflict } from "../../client/src/lib/vaultTypes";

const browser = new Window({ url: "http://vault-panel.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "Element", "Node", "Event", "MouseEvent"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: VaultPanel } = await import("../../client/src/components/VaultPanel");
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);
const choices: Array<[string, string]> = [];
let syncs = 0;
const conflict: VaultConflict = {
  id: "saved", path: "Notes/Plans.md", createdAt: "2026-09-25T12:00:00.000Z",
  base: { content: "Original plan" }, local: { content: "Device plan" }, remote: { content: "Synced plan" },
  result: { content: "Automatic combined plan" }, automatic: true,
};
const vault = {
  ready: true, storageMode: "server", matchesCloud: true, message: null, saving: false, localSaveError: null,
  conflicts: [conflict],
  localDirectoryStatus: { directoryName: null, fileName: "workspace.md", permission: "unselected", supported: false },
  async syncNow() { syncs += 1; }, async download() {}, async importArchive() {}, async chooseDirectory() {}, async clearDirectory() {},
  async resolveConflict(id: string, choice: "local" | "remote" | "current") { choices.push([id, choice]); },
} as Parameters<typeof VaultPanel>[0]["vault"];
function button(label: string) {
  const element = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  assert(element, `Expected button: ${label}`);
  return element;
}
function preview(label: string) {
  const element = [...container.querySelectorAll("label")].find((item) => item.firstChild?.textContent === label)?.querySelector("textarea");
  assert(element, `Expected saved preview: ${label}`);
  return element;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function render() { await act(async () => root.render(createElement(VaultPanel, { vault, cloudSyncEnabled: true }))); }
const checks: string[] = [];

try {
  await render();
  assert(container.textContent?.includes("Up to date"));
  assert(container.textContent?.includes("Alternative versions saved"));
  assert(container.textContent?.includes("Reviewing these saved versions is optional"));
  assert.equal(container.querySelector('[role="alert"]'), null);
  assert.equal(container.querySelector("details")?.open, false, "Saved alternatives start collapsed.");
  assert.equal(button("Sync now").disabled, false);
  await click("Sync now");
  assert.equal(syncs, 1, "Saved alternatives must not prevent syncing.");
  checks.push("alternatives do not block cloud status or sync");

  assert.equal(preview("Saved device version").value, "Device plan");
  assert.equal(preview("Saved synced version").value, "Synced plan");
  assert.equal(preview("Saved automatic result").value, "Automatic combined plan");
  assert(container.textContent?.includes("Restoring replaces the entire current file"));
  await click("Restore entire device version");
  await click("Restore entire synced version");
  await click("Dismiss · keep current file");
  assert.deepEqual(choices, [["saved", "local"], ["saved", "remote"], ["saved", "current"]]);
  checks.push("whole-version restore and keep-current actions remain distinct");

  const legacy: VaultConflict = { id: "legacy", path: "Notes/Deleted.md", createdAt: conflict.createdAt, local: { content: "Offline writing" }, remote: null };
  vault.conflicts = [legacy];
  await render();
  assert.equal(container.querySelectorAll("textarea").length, 2, "Legacy records have no invented automatic result.");
  assert.equal(preview("Saved synced version").value, "File deleted in the synced copy");
  assert(container.textContent?.includes("Restoring a deletion removes the current file"));
  assert.equal(button("Sync now").disabled, false);
  await click("Restore synced deletion");
  await click("Dismiss · keep current file");
  assert.deepEqual(choices.slice(-2), [["legacy", "remote"], ["legacy", "current"]]);
  vault.conflicts = [{ ...legacy, local: null, remote: { content: "Cloud writing" }, result: null, automatic: true }];
  await render();
  assert.equal(preview("Saved automatic result").value, "File remains deleted");
  await click("Restore device deletion");
  assert.deepEqual(choices.at(-1), ["legacy", "local"]);
  checks.push("legacy records and deletions remain optional and explicit");

  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
