import { unzip } from "fflate";
import { createEmptyState, createMainConversation } from "../initialState";
import type { AppState, Conversation, Message } from "../types";
import { createMarkdownWorkspace } from "./workspaceMarkdown";
import type { VaultFile } from "./vaultTypes";

export interface HistoryChat {
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  messages: Message[];
  warnings: string[];
  alternate: boolean;
}
export interface HistoryPreview { chats: HistoryChat[]; warnings: string[] }
export interface HistoryImportReceipt { files: Record<string, VaultFile>; conversationIds: string[]; skipped: number }

const JSON_LIMIT = 20_000_000;
const ARCHIVE_LIMIT = 100_000_000;
const MAX_CHATS = 5000;
const MAX_NODES = 100_000;
const record = (value: unknown): Record<string, unknown> | null =>
  value !== null && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null;
const string = (value: unknown) => typeof value === "string" ? value : "";

function timestamp(value: unknown, fallback: string): string {
  const ms = typeof value === "number" ? value * 1000 : typeof value === "string" ? Date.parse(value) : NaN;
  return Number.isFinite(ms) && Math.abs(ms) <= 8.64e15 ? new Date(ms).toISOString() : fallback;
}

async function identity(value: string) {
  const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

function messageText(message: Record<string, unknown>, warnings: Set<string>): string {
  const content = record(message.content);
  const metadata = record(message.metadata);
  if (Array.isArray(metadata?.attachments) && metadata.attachments.length) {
    warnings.add("Attachments are not imported. Reattach any files needed to continue this chat.");
  }
  if (!content) return "";
  if (Array.isArray(content.parts)) {
    return content.parts.map((part) => {
      if (typeof part === "string") return part;
      const item = record(part);
      if (item && ["text", "audio_transcription"].includes(string(item.content_type)) && typeof item.text === "string") return item.text;
      warnings.add("Images, audio, and other non-text content are represented by placeholders.");
      return "[Non-text content from ChatGPT was not imported.]";
    }).join("\n\n");
  }
  if (typeof content.text === "string") {
    if (content.content_type === "code") {
      let fenceLength = 3;
      for (const match of content.text.matchAll(/`+/g)) fenceLength = Math.max(fenceLength, match[0].length + 1);
      const fence = "`".repeat(fenceLength);
      const language = string(content.language).replace(/[^a-zA-Z0-9_+#.-]/g, "").slice(0, 40);
      return `${fence}${language}\n${content.text}\n${fence}`;
    }
    return content.text;
  }
  warnings.add("Images, audio, and other non-text content are represented by placeholders.");
  return "[Non-text content from ChatGPT was not imported.]";
}

/** Export data is untrusted. Follow parent links, never object order or HTML. */
export async function parseChatGPTHistory(value: unknown): Promise<HistoryPreview> {
  if (!Array.isArray(value)) throw new Error("This is not a ChatGPT conversation export. Choose its ZIP or conversations.json file.");
  if (value.length > MAX_CHATS) throw new Error("Import up to 5,000 conversations at a time using smaller conversation JSON files.");
  const chats: HistoryChat[] = [];
  const warnings = new Set<string>();
  const seen = new Set<string>();
  let work = 0;
  let recognized = value.length === 0;
  for (const item of value) {
    const source = record(item);
    const mapping = record(source?.mapping);
    const sourceId = string(source?.id) || string(source?.conversation_id);
    if (!mapping || !sourceId || sourceId.length > 512) {
      warnings.add("Some entries were skipped because their conversation structure or identity was missing.");
      continue;
    }
    recognized = true;
    const keys = Object.keys(mapping);
    work += keys.length;
    if (work > MAX_NODES) throw new Error("This export has too many messages or branches. Import a smaller conversation JSON file.");
    const prefix = `chatgpt-${await identity(sourceId)}`;
    const createdAt = timestamp(source!.create_time, "1970-01-01T00:00:00.000Z");
    const updatedAt = timestamp(source!.update_time, createdAt);
    const title = string(source!.title).trim().slice(0, 500) || "Imported ChatGPT chat";
    const parents = new Set(keys.map((key) => string(record(mapping[key])?.parent)).filter(Boolean));
    const leaves = keys.filter((key) => !parents.has(key));
    const requested = string(source!.current_node);
    const primary = Object.hasOwn(mapping, requested) ? requested : leaves.at(-1);
    if (!primary) { warnings.add("A conversation with broken or cyclic message links was skipped."); continue; }
    const ends = [...new Set([primary, ...leaves])];
    const signatures = new Set<string>();
    let alternate = 0;
    for (const end of ends) {
      const chain: Array<{ key: string; node: Record<string, unknown> }> = [];
      const visited = new Set<string>();
      let key: string | null = end;
      let broken = false;
      while (key) {
        if (++work > MAX_NODES * 3) throw new Error("This export has too many messages or branches. Import a smaller conversation JSON file.");
        const node: Record<string, unknown> | null = Object.hasOwn(mapping, key) ? record(mapping[key]) : null;
        if (!node || visited.has(key)) { broken = true; break; }
        visited.add(key); chain.push({ key, node });
        if (node.parent !== null && node.parent !== undefined && typeof node.parent !== "string") { broken = true; break; }
        key = string(node.parent) || null;
      }
      if (broken) { warnings.add("A reply path with broken or cyclic message links was skipped."); continue; }
      const issues = new Set<string>();
      const messages: Message[] = [];
      const visibleKeys: string[] = [];
      for (const { key: nodeKey, node } of chain.reverse()) {
        const message = record(node.message);
        const role = record(message?.author)?.role;
        if (!message || !["user", "assistant"].includes(string(role))) continue;
        if (record(message.metadata)?.is_visually_hidden_from_conversation === true) continue;
        if (role === "assistant" && ((message.recipient && message.recipient !== "all") || message.channel === "analysis")) {
          issues.add("Tool calls and internal messages are not imported."); continue;
        }
        const text = messageText(message, issues);
        if (!text.trim()) continue;
        visibleKeys.push(nodeKey);
        // IDs are local to this conversation, so branch copies remain independent.
        messages.push({ id: `message-${messages.length + 1}`, role: role as "user" | "assistant", content: text,
          createdAt: timestamp(message.create_time, createdAt) });
      }
      if (!messages.length) continue;
      const signature = JSON.stringify(visibleKeys);
      if (signatures.has(signature)) continue;
      signatures.add(signature);
      const isAlternate = end !== primary;
      const id = isAlternate ? `${prefix}-${await identity(signature)}` : prefix;
      if (seen.has(id)) { warnings.add("Repeated conversations in the selected files were skipped."); continue; }
      seen.add(id);
      if (isAlternate) alternate++;
      chats.push({ id, title: isAlternate ? `${title} (alternate ${alternate})` : title, createdAt, updatedAt,
        messages: messages.map((message, index) => ({ ...message, id: `${id}-message-${index + 1}` })),
        warnings: [...issues], alternate: isAlternate });
      if (chats.length > MAX_CHATS) throw new Error("This export contains more than 5,000 chat paths. Import smaller conversation JSON files.");
    }
  }
  if (!recognized) throw new Error("No ChatGPT conversations were found. Choose the original export ZIP or conversation JSON file.");
  if (!chats.length) warnings.add("No readable user or assistant messages were found in this export.");
  if (chats.some((chat) => chat.alternate)) warnings.add("Alternate reply paths are shown as separate chats with their preceding messages.");
  return { chats, warnings: [...warnings] };
}

/** Only inflate conversation JSON; archive attachments and account data stay out. */
export async function readChatGPTHistory(files: File[]): Promise<HistoryPreview> {
  if (!files.length) throw new Error("Choose a ChatGPT export first.");
  if (files.reduce((sum, file) => sum + file.size, 0) > ARCHIVE_LIMIT) throw new Error("Choose files totaling less than 100 MB, or extract the conversation JSON files first.");
  let expanded = 0;
  const values: unknown[] = [];
  function readJSON(bytes: Uint8Array) {
    expanded += bytes.length;
    if (expanded > JSON_LIMIT) throw new Error("The conversation data exceeds 20 MB. Import fewer numbered JSON files at a time.");
    let parsed: unknown;
    try { parsed = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "")); }
    catch { throw new Error("The conversation JSON could not be read. Download a fresh ChatGPT export and try again."); }
    if (!Array.isArray(parsed)) throw new Error("Expected a ChatGPT conversation list. Choose conversations.json from your export.");
    if (values.length + parsed.length > MAX_CHATS) throw new Error("Import up to 5,000 conversations at a time using smaller conversation JSON files.");
    values.push(...parsed);
  }
  for (const file of files) {
    const bytes = new Uint8Array(await file.arrayBuffer());
    if (bytes[0] === 0x50 && bytes[1] === 0x4b) {
      let declared = expanded;
      const archive = await new Promise<Record<string, Uint8Array>>((resolve, reject) => {
        unzip(bytes, { filter(entry) {
          if (!/(^|\/)conversations(?:[-_]?\d+)?\.json$/i.test(entry.name)) return false;
          declared += entry.originalSize;
          if (!Number.isSafeInteger(entry.originalSize) || declared > JSON_LIMIT) throw new Error("The conversation data exceeds 20 MB. Extract and import fewer numbered JSON files.");
          return true;
        } }, (error, output) => error ? reject(new Error("The ZIP could not be read. Try extracting its conversation JSON files.")) : resolve(output));
      });
      const names = Object.keys(archive).sort((a, b) => a.localeCompare(b, undefined, { numeric: true }));
      if (!names.length) throw new Error("This ZIP has no ChatGPT conversation JSON files. Choose the original ChatGPT export.");
      for (const name of names) readJSON(archive[name]);
    } else readJSON(bytes);
  }
  return parseChatGPTHistory(values);
}

export function historyVaultFiles(chats: HistoryChat[], state: AppState): Record<string, VaultFile> {
  const conversations: Record<string, Conversation> = {};
  for (const chat of chats) {
    conversations[chat.id] = { ...createMainConversation({ id: chat.id, createdAt: chat.createdAt,
      serviceId: state.defaultServiceId, modelId: state.defaultModelId }), title: chat.title, updatedAt: chat.updatedAt,
      messages: chat.messages.map((message) => ({ ...message })) };
  }
  const workspace = createMarkdownWorkspace({ ...createEmptyState(), conversations }, "1970-01-01T00:00:00.000Z");
  return Object.fromEntries(Object.entries(workspace.files).map(([path, content]) => {
    if (new TextEncoder().encode(content).length > 2_000_000) throw new Error("One selected chat is too large to sync. Deselect it and import the other chats.");
    return [path, { content, contentType: "text/markdown; charset=utf-8" }];
  }));
}
