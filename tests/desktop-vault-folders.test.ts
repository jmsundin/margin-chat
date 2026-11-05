import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { createVaultFolders } from "../desktop/vaultFolders.mjs";
import { answerVaultRequest, registerVaultBridge, VAULT_CHANNEL, VAULT_OPERATIONS } from "../desktop/vaultBridge.mjs";

async function setUp() {
  const home = await mkdtemp(path.join(tmpdir(), "margin-desktop-"));
  const answers: Array<string | null> = [];
  const asked: Array<{ title: string; defaultPath?: string }> = [];
  const folders = createVaultFolders({
    statePath: path.join(home, "userData", "vault-folders.json"),
    async chooseFolder(options) { asked.push(options); return answers.shift() ?? null; },
    defaultLocation: () => path.join(home, "Documents"),
  });
  return { home, folders, answers, asked, statePath: path.join(home, "userData", "vault-folders.json") };
}

describe("desktop vault folders", () => {
  test("a chosen folder is remembered per account and reopens with no dialog", async () => {
    const { home, folders, answers, asked, statePath } = await setUp();
    const vault = path.join(home, "Notes");
    await mkdir(vault);
    answers.push(vault);
    const chosen = await folders.choose();
    expect(chosen).toMatchObject({ name: "Notes" });
    // Chosen isn't connected until the page says so.
    expect(await folders.selection("user-1")).toEqual({ current: null, folders: [] });
    await folders.connect("user-1", chosen!.id);
    expect((await folders.selection("user-1")).current).toEqual(chosen);
    expect((await folders.selection("user-2")).current).toBeNull();

    // A new launch reads the remembered folder from disk, with no dialog.
    const again = createVaultFolders({ statePath, chooseFolder: async () => { throw new Error("no dialog expected"); } });
    expect((await again.selection("user-1")).current).toEqual(chosen);
    const fs = await again.fs(chosen!.id);
    await fs!.writeAtomic("Hello.md", "Hi");
    expect(await readFile(path.join(vault, "Hello.md"), "utf8")).toBe("Hi");
    expect(asked).toHaveLength(1);
  });

  test("the page can reach only folders handed out here", async () => {
    const { folders } = await setUp();
    expect(await folders.fs("not-an-id")).toBeNull();
    const answer = await answerVaultRequest(folders, "read", ["not-an-id", "Note.md"]);
    expect(answer).toMatchObject({ ok: false, error: { name: "NotFoundError" } });
    expect(await answerVaultRequest(folders, "eval", [])).toMatchObject({ ok: false });
  });

  test("a folder moved or renamed since keeps its identity when chosen again", async () => {
    const { home, folders, answers } = await setUp();
    await mkdir(path.join(home, "Vault"));
    answers.push(path.join(home, "Vault"));
    const first = (await folders.choose())!;
    await folders.connect("user-1", first.id);
    await rename(path.join(home, "Vault"), path.join(home, "Vault renamed"));
    const fs = await folders.fs(first.id);
    expect(await fs!.availability()).toBe("missing");
    answers.push(path.join(home, "Vault renamed"));
    const again = (await folders.choose())!;
    expect(again.id).toBe(first.id);
    expect(again.name).toBe("Vault renamed");
  });

  test("a new vault is offered Documents first and never takes over a folder with files", async () => {
    const { home, folders, answers, asked } = await setUp();
    await mkdir(path.join(home, "Documents"));
    answers.push(path.join(home, "Documents"));
    const created = await folders.createVault("Margin Chat");
    expect(created?.name).toBe("Margin Chat");
    expect(asked[0].defaultPath).toBe(path.join(home, "Documents"));
    await writeFile(path.join(home, "Documents", "Margin Chat", "Old.md"), "x");
    answers.push(path.join(home, "Documents"));
    const refused = await answerVaultRequest(folders, "createVault", ["Margin Chat"]);
    expect(refused).toMatchObject({ ok: false, error: { name: "VaultFolderExistsError", folder: { name: "Margin Chat" } } });
    expect(await answerVaultRequest(folders, "createVault", ["a/b"])).toMatchObject({ ok: false });
  });

  test("forgetting the folder changes nothing in it", async () => {
    const { home, folders, answers } = await setUp();
    await mkdir(path.join(home, "Vault"));
    await writeFile(path.join(home, "Vault", "Keep.md"), "kept");
    answers.push(path.join(home, "Vault"));
    const folder = (await folders.choose())!;
    await folders.connect("user-1", folder.id);
    await folders.forget("user-1");
    expect((await folders.selection("user-1")).current).toBeNull();
    expect(await readFile(path.join(home, "Vault", "Keep.md"), "utf8")).toBe("kept");
  });

  test("lists bring each file's size and time; errors keep their names across the bridge", async () => {
    const { home, folders, answers } = await setUp();
    await mkdir(path.join(home, "Vault", "Sub"), { recursive: true });
    await writeFile(path.join(home, "Vault", "A.md"), "abc");
    answers.push(path.join(home, "Vault"));
    const folder = (await folders.choose())!;
    const listed = await answerVaultRequest(folders, "list", [folder.id, ""]);
    expect(listed.ok).toBe(true);
    const entries = (listed as { value: Array<{ name: string; kind: string; size?: number }> }).value.sort((a, b) => a.name.localeCompare(b.name));
    expect(entries).toEqual([{ name: "A.md", kind: "file", size: 3, modifiedMs: expect.any(Number) }, { name: "Sub", kind: "directory" }]);
    expect(await answerVaultRequest(folders, "delete", [folder.id, "Missing.md"])).toMatchObject({ ok: false, error: { name: "NotFoundError" } });
    expect(await answerVaultRequest(folders, "read", [folder.id, "../escape.md"])).toMatchObject({ ok: false, error: { name: "TypeError" } });
    expect(await answerVaultRequest(folders, "writeAtomic", [folder.id, "B.md", { not: "bytes" }])).toMatchObject({ ok: false });
  });

  test("only the app's own pages are answered", async () => {
    const { folders } = await setUp();
    let handler: ((event: unknown, operation: string, args: unknown[]) => unknown) | null = null;
    registerVaultBridge({ ipcMain: { handle: (channel: string, fn: typeof handler) => { expect(channel).toBe(VAULT_CHANNEL); handler = fn; } }, folders, isAppUrl: (url: string) => url.startsWith("margin://app/") });
    expect(await handler!({ senderFrame: { url: "https://evil.example/" } }, "selection", ["user-1"])).toMatchObject({ ok: false, error: { name: "NotAllowedError" } });
    expect(await handler!({ senderFrame: { url: "margin://app/" } }, "selection", ["user-1"])).toEqual({ ok: true, value: { current: null, folders: [] } });
  });

  test("the preload exposes exactly the bridge's operations", async () => {
    const preload = await readFile(new URL("../desktop/preload.cjs", import.meta.url), "utf8");
    const exposed = [...preload.matchAll(/call\("([a-zA-Z]+)"\)/g)].map((match) => match[1]).sort();
    expect(exposed).toEqual([...VAULT_OPERATIONS].sort());
    expect(preload).not.toMatch(/require\("(?:fs|node:|child_process)/);
  });
});
