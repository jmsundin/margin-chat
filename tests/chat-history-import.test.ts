import { describe, expect, test } from "bun:test";
import { strToU8, zipSync } from "fflate";
import { chatGPTFixture } from "./helpers/chatHistoryFixture";
import { historyVaultFiles, parseChatGPTHistory, readChatGPTHistory } from "../client/src/lib/chatHistoryImport";
import { createEmptyState, createMainConversation } from "../client/src/initialState";
import { stateToVaultFiles, vaultToState, workspaceFromVault } from "../client/src/lib/vaultWorkspace";
import { VaultSync } from "../client/src/lib/vaultSync";
import { emptyVault, type VaultSnapshot, type VaultStore } from "../client/src/lib/vaultTypes";

function device() {
  let saved = emptyVault();
  let tail = Promise.resolve();
  const store: VaultStore = {
    async read() { return structuredClone(saved); },
    async write(snapshot: VaultSnapshot) { saved = structuredClone(snapshot); },
    lock<T>(work: () => Promise<T>): Promise<T> { const next = tail.then(work); tail = next.then(() => {}, () => {}); return next; },
  };
  const offline = async (): Promise<never> => { throw new Error("No network expected for import"); };
  return new VaultSync(store, { manifest: offline, read: offline, commit: offline });
}

describe("ChatGPT history import", () => {
  test("preserves ancestry, dates, Markdown, Unicode and roles as continuable vault conversations", async () => {
    const preview = await parseChatGPTHistory([chatGPTFixture()]);
    const chat = preview.chats[0];
    expect(chat.messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(chat.messages[0].createdAt).toBe("2023-11-14T22:13:21.000Z");
    expect(chat.messages[1].content).toContain("日本語 🌿");
    expect(JSON.stringify(preview)).not.toContain("Hidden system instructions");
    const current = createEmptyState();
    const files = historyVaultFiles(preview.chats, current);
    expect(files["workspace.json"]).toBeUndefined();
    const restored = vaultToState(files, current).conversations[chat.id];
    expect(restored.messages).toEqual(chat.messages);
    expect(restored.title).toBe(chat.title);
    expect(restored.serviceId).toBe(current.defaultServiceId);
    expect(restored.modelId).toBe(current.defaultModelId);
    expect(restored.kind).toBe("chat");
  });

  test("preserves alternate replies with independent IDs and flags unsupported content", async () => {
    const source: any = chatGPTFixture();
    source.mapping.other = { parent: "question", message: { author: { role: "assistant" }, content: { parts: ["Another answer", { content_type: "image_asset_pointer", asset_pointer: "secret-pointer" }] } } };
    source.mapping.question.message.metadata = { attachments: [{ name: "private.pdf" }] };
    const preview = await parseChatGPTHistory([source]);
    expect(preview.chats).toHaveLength(2);
    expect(preview.chats[1].alternate).toBe(true);
    expect(preview.chats[1].messages[0].content).toBe(preview.chats[0].messages[0].content);
    expect(preview.chats[1].warnings.join(" ")).toContain("Attachments are not imported");
    expect(preview.chats[1].messages[1].content).toContain("Non-text content");
    expect(JSON.stringify(preview)).not.toContain("secret-pointer");
    const ids = preview.chats.flatMap((chat) => chat.messages.map((message) => message.id));
    expect(new Set(ids).size).toBe(ids.length);
    expect(Object.keys(vaultToState(historyVaultFiles(preview.chats, createEmptyState()), createEmptyState()).conversations)).toHaveLength(2);
    expect((await parseChatGPTHistory([source])).chats.map((chat) => chat.id)).toEqual(preview.chats.map((chat) => chat.id));
  });

  test("supports ZIP and numbered JSON files, excluding unrelated account records and files", async () => {
    const zip = zipSync({
      "export/conversations-1.json": strToU8(JSON.stringify([chatGPTFixture()])),
      "export/conversations_2.json": strToU8(JSON.stringify([chatGPTFixture("two", "Second chat")])),
      "user.json": strToU8('{"secret":"account-data"}'),
      "image.png": new Uint8Array([0, 255, 1]),
    });
    const result = await readChatGPTHistory([new File([zip], "chatgpt.zip")]);
    expect(result.chats).toHaveLength(2);
    expect(JSON.stringify(result)).not.toContain("account-data");
    const json = new File([JSON.stringify([chatGPTFixture()])], "conversations.json");
    expect((await readChatGPTHistory([json, json])).chats).toHaveLength(1);
    expect((await readChatGPTHistory([json, json])).warnings.join(" ")).toContain("Repeated");
  });

  test("omits internal and tool messages while retaining the selected final answer", async () => {
    const source: any = chatGPTFixture();
    source.mapping.analysis = { parent: "question", message: { author: { role: "assistant" }, channel: "analysis", content: { parts: ["Private analysis"] } } };
    source.mapping.call = { parent: "analysis", message: { author: { role: "assistant" }, recipient: "python", content: { text: "Internal tool command" } } };
    source.mapping.tool = { parent: "call", message: { author: { role: "tool" }, content: { parts: ["Internal tool result"] } } };
    source.mapping.answer.parent = "tool";
    const result = await parseChatGPTHistory([source]);
    expect(result.chats).toHaveLength(1);
    expect(result.chats[0].messages.map((m) => m.role)).toEqual(["user", "assistant"]);
    expect(JSON.stringify(result.chats[0].messages)).not.toMatch(/Private analysis|Internal tool/);
    expect(result.chats[0].warnings.join(" ")).toContain("Tool calls and internal messages");
  });

  test("rejects malformed and unrelated input and safely handles corrupt trees", async () => {
    await expect(parseChatGPTHistory({ conversations: [] })).rejects.toThrow("not a ChatGPT");
    await expect(parseChatGPTHistory([{ uuid: "claude-chat", chat_messages: [] }])).rejects.toThrow("No ChatGPT");
    await expect(readChatGPTHistory([new File(["not JSON"], "conversations.json")])).rejects.toThrow("could not be read");
    await expect(readChatGPTHistory([new File([zipSync({ "chat.html": strToU8("<script>bad()</script>") })], "wrong.zip")])).rejects.toThrow("no ChatGPT");
    const cyclic: any = chatGPTFixture(); cyclic.mapping.question.parent = "answer";
    const result = await parseChatGPTHistory([cyclic, chatGPTFixture("valid")]);
    expect(result.chats).toHaveLength(1);
    expect(result.warnings.join(" ")).toContain("cyclic");
    await expect(readChatGPTHistory([{ size: 100_000_001 } as File])).rejects.toThrow("100 MB");
    await expect(readChatGPTHistory([new File([zipSync({ "conversations.json": new Uint8Array(20_000_001) })], "large.zip")])).rejects.toThrow("20 MB");
  });

  test("skips imported identities after editing or renaming, including concurrent imports", async () => {
    const engine = device();
    const preview = await parseChatGPTHistory([chatGPTFixture()]);
    const files = historyVaultFiles(preview.chats, createEmptyState());
    const receipts = await Promise.all([engine.importChatHistory(files), engine.importChatHistory(files)]);
    expect(receipts.map((r) => r.conversationIds.length)).toEqual([1, 0]);
    expect(receipts[1].skipped).toBe(1);
    const [path, original] = Object.entries(files)[0];
    const edited = { ...original, content: original.content.replace("Hello **world**!", "My newer edit") };
    await engine.edit({ "Renamed.md": edited }, files);
    expect((await engine.importChatHistory(files)).skipped).toBe(1);
    const snapshot = await engine.read();
    expect(snapshot.conflicts).toEqual([]);
    expect(snapshot.files["Renamed.md"].content).toContain("My newer edit");
    expect(snapshot.files[path]).toBeUndefined();
  });

  test("undo removes only this batch's unchanged chats, keeping edits and unrelated content", async () => {
    const engine = device();
    await engine.import({ "Existing.md": { content: "# Existing note\nKeep this." } });
    const preview = await parseChatGPTHistory([chatGPTFixture(), chatGPTFixture("two")]);
    const files = historyVaultFiles(preview.chats, createEmptyState());
    const receipt = await engine.importChatHistory(files);
    const [path, original] = Object.entries(files)[0];
    await engine.edit({ [path]: { ...original, content: original.content.replace("Hello **world**!", "Edited after import") } }, { [path]: original });
    expect(await engine.undoChatHistory(receipt)).toEqual({ removed: 1, kept: 1 });
    const snapshot = await engine.read();
    expect(snapshot.files["Existing.md"].content).toContain("Keep this");
    expect(snapshot.files[path].content).toContain("Edited after import");
    expect(workspaceFromVault(snapshot.files).manifest.files).toHaveLength(2);
  });
  test("undo preserves unchanged chats referenced from other files and renamed imports", async () => {
    const engine = device();
    const preview = await parseChatGPTHistory([chatGPTFixture(), chatGPTFixture("renamed")]);
    const files = historyVaultFiles(preview.chats, createEmptyState());
    const receipt = await engine.importChatHistory(files);
    const state = vaultToState(files, createEmptyState());
    state.conversations.linker = { ...createMainConversation({ id: "linker" }),
      messages: [{ id: "link-message", role: "user", content: "A connected chat", createdAt: new Date().toISOString() }],
      linkedConversationIds: [preview.chats[0].id] };
    const linkedFiles = stateToVaultFiles(state, files);
    await engine.edit(linkedFiles, files);
    const renamedPath = workspaceFromVault(files).manifest.files.find((record) => record.id === preview.chats[1].id)!.path;
    await engine.edit({ "Renamed.md": files[renamedPath] }, { [renamedPath]: files[renamedPath] });
    expect(await engine.undoChatHistory(receipt)).toEqual({ removed: 0, kept: 2 });
    const restored = vaultToState((await engine.read()).files, createEmptyState());
    expect(restored.conversations.linker.linkedConversationIds).toEqual([preview.chats[0].id]);
    expect(restored.conversations[preview.chats[1].id]).toBeDefined();
  });

  test("undo preserves an imported document pinned in the dock without content edits", async () => {
    const engine = device();
    const preview = await parseChatGPTHistory([chatGPTFixture(), chatGPTFixture("unused")]);
    const files = historyVaultFiles(preview.chats, createEmptyState());
    const receipt = await engine.importChatHistory(files);
    const state = vaultToState(files, createEmptyState());
    state.documentDock = { width: .4, tree: { type: "pane", documentId: preview.chats[0].id, scope: "family" } };
    await engine.edit(stateToVaultFiles(state, files), files);
    expect(await engine.undoChatHistory(receipt)).toEqual({ removed: 1, kept: 1 });
    const restored = vaultToState((await engine.read()).files, createEmptyState());
    expect(restored.conversations[preview.chats[0].id]).toBeDefined();
    expect(restored.documentDock).toEqual(state.documentDock);
  });

});
