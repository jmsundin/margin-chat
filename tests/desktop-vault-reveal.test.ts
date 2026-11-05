import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, rename, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createVaultFolders } from "../desktop/vaultFolders.mjs";
import { registerVaultBridge, revealInFolder, VAULT_OPERATIONS } from "../desktop/vaultBridge.mjs";
import { fileManagerName } from "../client/src/lib/vaultFsDesktop";

async function setUp() {
  const home = await mkdtemp(path.join(tmpdir(), "margin-reveal-"));
  const vault = path.join(home, "Vault");
  await mkdir(path.join(vault, "Projects"), { recursive: true });
  await writeFile(path.join(vault, "Projects", "Plan.md"), "# Plan\n");
  const answers = [vault];
  const folders = createVaultFolders({ statePath: path.join(home, "vault-folders.json"), async chooseFolder() { return answers.shift() ?? null; } });
  const folder = (await folders.choose())!;
  await folders.connect("user", folder.id);
  const shown: string[] = [];
  const opened: string[] = [];
  const shell = { showItemInFolder: (fullPath: string) => { shown.push(fullPath); }, openPath: async (fullPath: string) => { opened.push(fullPath); return ""; } };
  return { home, vault, folders, folder, shell, shown, opened };
}

describe("showing vault files in Finder or Explorer", () => {
  test("a document's file is shown selected in its folder; no file, or one not written yet, opens the vault folder", async () => {
    const { vault, folders, folder, shell, shown, opened } = await setUp();
    expect(await revealInFolder(folders, shell, folder.id, "Projects/Plan.md")).toBe("file");
    expect(shown).toEqual([path.join(vault, "Projects", "Plan.md")]);
    expect(await revealInFolder(folders, shell, folder.id, "")).toBe("folder");
    expect(await revealInFolder(folders, shell, folder.id, "Not saved yet.md")).toBe("folder");
    expect(opened).toEqual([vault, vault]);
  });

  test("paths outside the vault, links and unknown folders are refused", async () => {
    const { home, vault, folders, folder, shell, shown, opened } = await setUp();
    await writeFile(path.join(home, "Secret.md"), "# Secret\n");
    await symlink(path.join(home, "Secret.md"), path.join(vault, "Link.md"));
    for (const bad of ["../Secret.md", "/etc/passwd", "Projects/../../Secret.md"]) {
      await expect(revealInFolder(folders, shell, folder.id, bad)).rejects.toThrow();
    }
    // A link isn't followed out of the vault.
    await expect(revealInFolder(folders, shell, folder.id, "Link.md")).rejects.toMatchObject({ name: "NotAllowedError" });
    await expect(revealInFolder(folders, shell, "not-a-folder", "")).rejects.toMatchObject({ name: "NotFoundError" });
    expect(shown).toEqual([]);
    expect(opened).toEqual([]);
  });

  test("a vault folder that can't be found is said so, not opened", async () => {
    const { vault, folders, folder, shell, opened } = await setUp();
    await rename(vault, `${vault}-moved`);
    await expect(revealInFolder(folders, shell, folder.id, "")).rejects.toMatchObject({ name: "NotFoundError" });
    expect(opened).toEqual([]);
  });

  test("the bridge answers reveal for the app's own pages, and an app without a shell says it can't", async () => {
    const { vault, folders, folder, shell, shown } = await setUp();
    type Handler = (event: unknown, operation: string, args: unknown[]) => Promise<any>;
    let handler: Handler | null = null;
    registerVaultBridge({ ipcMain: { handle: (_channel: string, fn: Handler) => { handler = fn; } }, folders, isAppUrl: (url: string) => url.startsWith("margin://app/"), shell });
    const event = { senderFrame: { url: "margin://app/" }, sender: { id: 1 } };
    expect(await handler!(event, "reveal", [folder.id, "Projects/Plan.md"])).toEqual({ ok: true, value: "file" });
    expect(shown).toEqual([path.join(vault, "Projects", "Plan.md")]);
    expect(await handler!({ senderFrame: { url: "https://example.com/" }, sender: { id: 2 } }, "reveal", [folder.id, ""]))
      .toMatchObject({ ok: false, error: { name: "NotAllowedError" } });

    let older: Handler | null = null;
    registerVaultBridge({ ipcMain: { handle: (_channel: string, fn: Handler) => { older = fn; } }, folders, isAppUrl: () => true });
    expect(await older!(event, "reveal", [folder.id, ""])).toMatchObject({ ok: false, error: { name: "NotSupportedError" } });
  });

  test("the preload and the app menu offer it", async () => {
    expect(VAULT_OPERATIONS).toContain("reveal");
    const preload = await readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8");
    expect(preload).toContain('reveal: call("reveal")');
    const main = await readFile(new URL("../desktop/main.mjs", import.meta.url), "utf8");
    expect(main).toContain("Open Vault Folder");
    expect(main).toContain('"margin:vault-folder"');
    expect(main).toContain("shell });");
  });

  test("the file manager is named for the computer", () => {
    expect(fileManagerName("MacIntel")).toBe("Finder");
    expect(fileManagerName("Win32")).toBe("Explorer");
    expect(fileManagerName("Linux x86_64")).toBe("Files");
  });
});
