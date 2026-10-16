import assert from "node:assert/strict";
import { Window } from "happy-dom";

const browser = new Window({ url: "http://vault-folder-gate.test" });
for (const name of ["window", "document", "navigator", "HTMLElement", "HTMLInputElement", "Element", "Node", "Event", "MouseEvent", "KeyboardEvent"]) {
  Object.defineProperty(globalThis, name, { configurable: true, value: name === "window" ? browser : (browser as any)[name] });
}
(globalThis as any).IS_REACT_ACT_ENVIRONMENT = true;
const { act, createElement } = await import("react");
const { createRoot } = await import("react-dom/client");
const { default: VaultFolderGate } = await import("../../client/src/components/VaultFolderGate");
const { VaultFolderExistsError } = await import("../../client/src/lib/desktopVault");
const { FolderUnavailableError } = await import("../../client/src/lib/workspaceStorage");
const container = browser.document.createElement("div");
browser.document.body.append(container);
const root = createRoot(container as unknown as Element);

function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}
/** A folder whose files have sizes but are never read. */
function folder(name: string, files: Record<string, number> = {}): any {
  const entries = Object.entries(files).map(([file, size]) => [file, { name: file, kind: "file", getFile: async () => ({ size }) }]);
  return { name, kind: "directory", async *entries() { yield* entries; } };
}
const calls: string[] = [];
const busy: boolean[] = [];
let picked: any = null;
let connecting: ReturnType<typeof deferred> | null = null;
let creating: { error?: unknown; handle?: any } = {};
let allowed = true;
let checkError: unknown = null;
const vault: any = {
  vaultFolderPrompt: "choose", localDirectories: [], fetchStatus: null, downloadProgress: null,
  localDirectoryStatus: { directoryName: null, fileName: "workspace.json", permission: "unselected", supported: true },
  async pickFolder() { calls.push("pick"); return picked; },
  async connectFolder(handle: any) { calls.push(`connect ${handle.name}`); await connecting?.promise; },
  async createVault(name: string, onCreated: (handle: any) => void) {
    calls.push(`create ${name}`);
    if (creating.error) throw creating.error;
    onCreated(creating.handle);
    await connecting?.promise;
    return true;
  },
  async switchDirectory(id: string) { calls.push(`switch ${id}`); },
  async allowDirectoryAccess() { calls.push("allow"); return allowed; },
  snoozeVaultFolderPrompt() { calls.push("not now"); },
  async checkFolder() { calls.push("check"); if (checkError) throw checkError; },
};
const text = () => container.textContent ?? "";
const buttons = () => [...container.querySelectorAll("button")].map((item) => item.textContent);
function button(label: string) {
  const element = [...container.querySelectorAll("button")].find((item) => item.textContent === label);
  assert(element, `Expected button “${label}” among ${JSON.stringify(buttons())}`);
  return element;
}
async function click(label: string) { await act(async () => { button(label).click(); }); }
async function render() { await act(async () => { root.render(createElement(VaultFolderGate, { vault, onBusyChange: (value: boolean) => busy.push(value) })); }); }
async function settle() { await act(async () => { await new Promise((done) => setTimeout(done, 10)); }); }
async function type(value: string) {
  await act(async () => {
    const input = container.querySelector("input")!;
    Object.getOwnPropertyDescriptor(browser.HTMLInputElement.prototype, "value")!.set!.call(input, value);
    input.dispatchEvent(new browser.Event("input", { bubbles: true }));
  });
}
const checks: string[] = [];

try {
  await render();
  assert(text().includes("Where should your vault live?"));
  assert.deepEqual(buttons(), ["Open a folder…", "Create a new vault…", "Not now"]);
  assert.deepEqual(calls, [], "Showing the prompt did something on its own.");
  await click("Not now");
  assert.deepEqual(calls.splice(0), ["not now"]);
  checks.push("first run offers open, create and Not now");

  // A small folder opens straight away and shows its contents while the vault is copied in.
  picked = folder("Notes", { "Inbox.md": 200, "Plan.md": 300, "scan.pdf": 1000 });
  connecting = deferred();
  await click("Open a folder…");
  await settle();
  assert.deepEqual(calls, ["pick", "connect Notes"]);
  assert(text().includes("Copying your vault into “Notes”…"));
  assert(text().includes("Found 2 notes and 1 other file (1.5 KB) in it."));
  vault.fetchStatus = { label: "Syncing documents…" };
  vault.downloadProgress = { done: 3, total: 10 };
  await render();
  assert(text().includes("Syncing documents… 3 of 10"));
  assert.equal(busy.at(-1), true, "The screen did not stay up while copying.");
  vault.fetchStatus = null; vault.downloadProgress = null;
  connecting.resolve(); connecting = null;
  await settle();
  assert.equal(busy.at(-1), false, "The screen stayed up after the folder was connected.");
  calls.splice(0);
  checks.push("a picked folder is counted, then connected with progress shown");

  // A very large folder asks first.
  picked = folder("Home", { "movie.mp4": 3 * 1024 ** 3, "todo.md": 10 });
  await click("Open a folder…");
  await settle();
  assert(text().includes("Open “Home”?"));
  assert(text().includes("1 note and 1 other file (3 GB)"));
  assert.deepEqual(calls, ["pick"], "A large folder was connected without asking.");
  await click("Back");
  assert(text().includes("Where should your vault live?"));
  await click("Open a folder…");
  await settle();
  await click("Open it");
  await settle();
  assert.deepEqual(calls.splice(0), ["pick", "pick", "connect Home"]);
  // Closing the folder picker without choosing is not an error.
  picked = null;
  vault.pickFolder = async () => { calls.push("pick"); throw new DOMException("The user aborted a request.", "AbortError"); };
  await click("Open a folder…");
  await settle();
  assert.equal(container.querySelector('[role="alert"]'), null);
  assert.deepEqual(calls.splice(0), ["pick"]);
  vault.pickFolder = async () => { calls.push("pick"); return picked; };
  checks.push("a very large folder is confirmed before it is opened");

  await click("Create a new vault…");
  assert.equal(container.querySelector("input")!.value, "Margin Chat");
  await type("Research");
  creating = { handle: folder("Research") };
  connecting = deferred();
  await click("Choose a location…");
  await settle();
  assert.deepEqual(calls, ["create Research"]);
  assert(text().includes("Copying your vault into “Research”…"));
  connecting.resolve(); connecting = null;
  await settle();
  assert.equal(busy.at(-1), false);
  calls.splice(0);

  const journal = folder("Journal", { "Today.md": 120 });
  creating = { error: new VaultFolderExistsError(journal) };
  await click("Create a new vault…");
  await type("Journal");
  await click("Choose a location…");
  await settle();
  assert.equal(container.querySelector('[role="alert"]')?.textContent, "There’s already a folder named “Journal” there, and it has files in it. Open it instead, or choose another name.");
  assert.equal(container.querySelector("input")!.value, "Journal", "The name was lost after a clash.");
  await click("Open “Journal” instead");
  await settle();
  assert.deepEqual(calls.splice(0), ["create Journal", "connect Journal"]);
  creating = { error: new DOMException("The user aborted a request.", "AbortError") };
  await click("Create a new vault…");
  await click("Choose a location…");
  await settle();
  assert.equal(container.querySelector('[role="alert"]'), null);
  assert(container.querySelector("input"), "Closing the location picker left the form.");
  await click("Back");
  calls.splice(0);
  checks.push("a new vault is named, placed, and offers to open a folder that is already there");

  vault.vaultFolderPrompt = "allow";
  vault.localDirectoryStatus = { ...vault.localDirectoryStatus, directoryName: "Notes", permission: "prompt" };
  await render();
  assert.deepEqual(buttons(), ["Allow access to “Notes”", "Not now"]);
  assert.deepEqual(calls, []);
  await click("Allow access to “Notes”");
  await settle();
  assert.deepEqual(calls.splice(0), ["allow"]);
  allowed = false;
  await click("Allow access to “Notes”");
  await settle();
  assert(text().includes("Margin Chat still can’t open “Notes”."));
  await click("Choose the folder…");
  await settle();
  assert.deepEqual(calls.splice(0, 2), ["allow", "pick"]);
  calls.splice(0);
  checks.push("a remembered folder needs one click to allow");

  await act(async () => { root.unmount(); });
  const remount = createRoot(container as unknown as Element);
  vault.vaultFolderPrompt = "missing";
  vault.localDirectories = [{ id: "notes", name: "Notes", current: true }, { id: "old", name: "Old notes", current: false }];
  await act(async () => { remount.render(createElement(VaultFolderGate, { vault })); });
  assert(text().includes("Can’t find your vault folder"));
  assert(text().includes("Margin Chat can’t find or open “Notes”."));
  assert(text().includes("nothing in the folder has been changed"));
  assert.deepEqual(buttons(), ["Choose a folder…", "Try again", "Not now", "Open “Old notes”"]);
  assert.deepEqual(calls, [], "Showing a missing folder did something on its own.");
  checkError = new FolderUnavailableError("Notes", "missing");
  await act(async () => { button("Try again").click(); });
  await act(async () => { await new Promise((done) => setTimeout(done, 10)); });
  assert.equal(container.querySelector('[role="alert"]')?.textContent, "Margin Chat still can’t find or open “Notes”.");
  await act(async () => { button("Open “Old notes”").click(); });
  await act(async () => { await new Promise((done) => setTimeout(done, 10)); });
  assert.deepEqual(calls.splice(0), ["check", "switch old"]);
  await act(async () => { remount.unmount(); });
  checks.push("a missing folder offers to choose it again, try again or use another, and writes nothing");

  console.log(JSON.stringify({ checks }));
} finally {
  await browser.happyDOM.close();
}
