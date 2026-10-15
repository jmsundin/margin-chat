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
const restoredKeys: string[] = [];
let syncs = 0;
let downloads = 0;
const conflict: VaultConflict = {
  id: "saved", path: "Notes/Plans.md", createdAt: "2026-09-25T12:00:00.000Z",
  base: { content: "Original plan" }, local: { content: "Device plan" }, remote: { content: "Synced plan" },
  result: { content: "Automatic combined plan" }, automatic: true,
};
const vault = {
  ready: true, storageMode: "server", matchesCloud: true, message: null, saving: false, localSaveError: null,
  conflicts: [conflict], recentlyDeleted: [] as any[], lastDownloadedAt: null as number | null,
  async restoreDeleted(key: string) { restoredKeys.push(key); return []; },
  localDirectoryStatus: { directoryName: null, fileName: "workspace.md", permission: "unselected", supported: false },
  async syncNow() { syncs += 1; }, async download() { downloads += 1; }, async importArchive() {}, async chooseDirectory() {}, async clearDirectory() {},
  async resolveConflict(id: string, choice: "local" | "remote" | "current") { choices.push([id, choice]); },
} as Parameters<typeof VaultPanel>[0]["vault"];
function button(label: string) {
  const element = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  assert(element, `Expected button: ${label}`);
  return element;
}
async function click(label: string) { await act(async () => button(label).click()); }
async function render(cloudSyncEnabled = true) { await act(async () => root.render(createElement(VaultPanel, { vault, cloudSyncEnabled }))); }
const checks: string[] = [];

try {
  await render();
  assert(container.textContent?.includes("Saved in this browser"));
  assert(container.textContent?.includes("Up to date"));
  assert.equal(container.querySelector('[role="alert"]'), null);
  const legacy: VaultConflict = { id: "legacy", path: "Notes/Deleted.md", createdAt: conflict.createdAt, local: { content: "Offline writing" }, remote: null };
  for (const history of [[conflict], [legacy], [{ ...legacy, local: null, remote: { content: "Cloud writing" }, result: null, automatic: true }]]) {
    vault.conflicts = history;
    await render();
    assert(container.textContent?.includes("Up to date"));
    assert.equal(container.querySelectorAll("details, textarea").length, 0);
    assert(!/alternative|restore|dismiss|review/i.test(container.textContent ?? ""));
    assert(!container.textContent?.includes(history[0].path));
  }
  assert.deepEqual(choices, [], "Rendering must not dismiss or restore retained history.");
  assert.equal(vault.conflicts.length, 1, "Recovery records are kept intact.");
  checks.push("background history does not change saved status or request a choice");

  assert.equal(button("Sync now").disabled, false);
  await click("Sync now");
  await click("Download vault");
  assert.equal(syncs, 1);
  assert.equal(downloads, 1);
  assert.equal(button("Import vault").disabled, false);
  checks.push("sync and independent backup actions remain available");

  vault.matchesCloud = false;
  vault.message = "Cloud sync is unavailable. Your edits are saved on this device.";
  vault.localSaveError = "This device is out of storage.";
  await render();
  assert(container.textContent?.includes("Changes waiting to sync"));
  assert(container.textContent?.includes("Save needs attention"));
  assert.equal(container.querySelector('[role="alert"]')?.textContent, vault.message);
  checks.push("real storage and sync errors remain visible");

  vault.message = null; vault.localSaveError = null;
  vault.recentlyDeleted = [
    { key: "k2", deletedAt: new Date(Date.now() - 2 * 3_600_000).toISOString(), files: [
      { path: "Trips/Japan.md", copy: ".margin-chat/trash/k2/1-Japan.md", title: "Trip to Japan" },
      { path: "Trips/Japan note.md", copy: ".margin-chat/trash/k2/2-Japan note.md", title: "Packing list" },
    ] },
    { key: "k1", deletedAt: new Date(Date.now() - 3 * 86_400_000).toISOString(), files: [
      { path: "Budget.md", copy: ".margin-chat/trash/k1/1-Budget.md", title: "Budget" },
    ] },
  ];
  await render();
  assert(container.textContent?.includes("2 deleted in the last 30 days"));
  assert(container.textContent?.includes("Trip to Japan and 1 more"));
  assert(container.textContent?.includes("Deleted 2h ago"));
  const restoreButtons = [...container.querySelectorAll(".recently-deleted-list button")];
  assert.equal(restoreButtons.length, 2);
  await act(async () => { restoreButtons[0].click(); });
  assert.deepEqual(restoredKeys, ["k2"]);
  assert(container.querySelector('[role="status"]')?.textContent?.includes("Restored “Trip to Japan and 1 more”"));
  checks.push("recently deleted documents can be restored");

  // Without cloud sync, the panel says whether a copy exists outside this browser.
  assert(!container.textContent?.includes("Copy outside this browser"), "Cloud sync users were told about copies outside the browser.");
  vault.recentlyDeleted = [];
  await render(false);
  assert(container.textContent?.includes("Local only"));
  assert(container.textContent?.includes("Copy outside this browserNone yet"));
  vault.lastDownloadedAt = Date.now() - 3 * 86_400_000;
  await render(false);
  assert(container.textContent?.includes("Downloaded 3d ago"));
  vault.localDirectoryStatus = { ...vault.localDirectoryStatus, directoryName: "Notes" };
  await render(false);
  assert(container.textContent?.includes("Folder “Notes”"));
  checks.push("free accounts see whether a copy exists outside the browser");

  // In the desktop app the folder is the vault itself.
  assert(container.textContent?.includes("Optional folder connection"));
  Object.defineProperty(browser.navigator, "userAgent", { configurable: true, value: "Mozilla/5.0 (Macintosh) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/146.0.0.0 Electron/44.7.0 Safari/537.36" });
  await render(false);
  assert(container.textContent?.includes("Vault folderNotes"));
  assert(!container.textContent?.includes("Optional folder connection"));
  (vault as any).folderUnavailable = true;
  await render(false);
  assert(container.textContent?.includes("Margin Chat can’t find or open this folder right now."));
  checks.push("desktop shows the vault folder and says when it can't be found");

  console.log(JSON.stringify({ checks }));
} finally {
  await act(async () => root.unmount());
  await browser.happyDOM.close();
}
