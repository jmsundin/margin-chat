#!/usr/bin/env node
/**
 * Saves each Claude Code session into the member's Margin Chat vault through the MCP server.
 *
 *   node scripts/claude-code-autosave.mjs install [--token mc_mcp_…]   set it up (Claude Code SessionEnd hook)
 *   node ~/.claude/margin-chat-autosave/autosave.mjs sync [--days 30]  save past sessions not saved yet
 *   node ~/.claude/margin-chat-autosave/autosave.mjs uninstall         remove the hook
 *
 * The hook only starts a background save and returns, so quitting Claude Code is never slowed down.
 * Each session becomes one document, "Claude Code · <title>", part of a hub per project, and a
 * resumed session is appended to the same document. Only your prompts and Claude's replies are
 * kept: tool calls, tool output and thinking are left out, and common secret formats are redacted.
 * Setting MARGIN_CHAT_AUTOSAVE=0 skips saving for a session.
 */
import { spawn } from "node:child_process";
import { chmodSync, copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, renameSync, statSync, unlinkSync, writeFileSync, appendFileSync } from "node:fs";
import { homedir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

export const DEFAULT_MCP_URL = "https://www.marginchat.com/api/mcp";
const CHUNK_CHARACTERS = 90_000; // the server takes at most 100,000 per call
const DOCUMENT_CHARACTERS = 1_500_000; // vault files are capped at 2 MB
const MESSAGE_CHARACTERS = 20_000;
const ROOT_HUB_TITLE = "Claude Code sessions";

const claudeHome = () => process.env.CLAUDE_CONFIG_DIR || join(homedir(), ".claude");
const homeDir = () => join(claudeHome(), "margin-chat-autosave");
const paths = () => ({
  script: join(homeDir(), "autosave.mjs"),
  config: join(homeDir(), "config.json"),
  state: join(homeDir(), "state.json"),
  log: join(homeDir(), "log.txt"),
});

// ---------- transcript → Markdown ----------

const SECRET_PATTERNS = [
  /\bmc_mcpr?_[A-Za-z0-9_-]{16,}/gu,
  /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{20,}/gu,
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}/gu,
  /\bgithub_pat_[A-Za-z0-9_]{30,}/gu,
  /\bAKIA[0-9A-Z]{16}\b/gu,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/gu,
  /\bAIza[0-9A-Za-z_-]{35}\b/gu,
];

export function redactSecrets(text) {
  return SECRET_PATTERNS.reduce((out, pattern) => out.replace(pattern, "[redacted]"), text);
}

/** What the person typed, without the wrappers Claude Code adds; null when nothing readable is left. */
export function cleanUserText(raw) {
  let text = raw.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/gu, "");
  if (/<local-command-(?:stdout|stderr|caveat)>|<bash-(?:stdout|stderr)>/u.test(text)) return null;
  const command = /<command-name>([\s\S]*?)<\/command-name>/u.exec(text);
  if (command) {
    const args = /<command-args>([\s\S]*?)<\/command-args>/u.exec(text)?.[1]?.trim();
    const name = command[1].trim();
    return `\`${name.startsWith("/") ? name : `/${name}`}${args ? ` ${args}` : ""}\``;
  }
  const bash = /<bash-input>([\s\S]*?)<\/bash-input>/u.exec(text);
  if (bash) return `\`! ${bash[1].trim()}\``;
  text = text.trim();
  if (!text || /^\[Request interrupted/u.test(text)) return null;
  return text;
}

function userText(content) {
  if (typeof content === "string") return cleanUserText(content);
  if (!Array.isArray(content) || content.some((block) => block?.type === "tool_result")) return null;
  const parts = content.map((block) => block?.type === "text" ? cleanUserText(block.text ?? "") : block?.type === "image" ? "[image]" : null)
    .filter(Boolean);
  return parts.length ? parts.join("\n\n") : null;
}

function assistantText(content) {
  if (typeof content === "string") return content.trim() || null;
  if (!Array.isArray(content)) return null;
  const text = content.filter((block) => block?.type === "text").map((block) => block.text ?? "").join("\n\n").trim();
  return text || null;
}

/** The readable turns of a session transcript (Claude Code's JSONL), oldest first. */
export function parseTranscript(source) {
  const turns = [];
  const meta = { title: null, cwd: null, gitBranch: null, startedAt: null };
  for (const line of source.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try { entry = JSON.parse(line); } catch { continue; }
    if (entry.type === "ai-title" && typeof entry.aiTitle === "string") meta.title = entry.aiTitle;
    if (entry.type === "summary" && typeof entry.summary === "string" && !meta.title) meta.title = entry.summary;
    if (entry.type !== "user" && entry.type !== "assistant") continue;
    if (entry.isSidechain || entry.isMeta || typeof entry.uuid !== "string") continue;
    meta.cwd ??= entry.cwd ?? null;
    meta.gitBranch ??= entry.gitBranch ?? null;
    meta.startedAt ??= entry.timestamp ?? null;
    const role = entry.type === "user" ? "you" : "claude";
    let text = role === "you" ? userText(entry.message?.content) : assistantText(entry.message?.content);
    if (!text) continue;
    text = redactSecrets(text);
    if (text.length > MESSAGE_CHARACTERS) text = `${text.slice(0, MESSAGE_CHARACTERS)}\n\n*[cut: ${text.length - MESSAGE_CHARACTERS} more characters]*`;
    const last = turns.at(-1);
    // Claude writes one reply as several transcript entries; read them as one.
    if (last && last.role === role && role === "claude") {
      last.text += `\n\n${text}`;
      last.uuids.push(entry.uuid);
    } else {
      turns.push({ role, text, uuids: [entry.uuid], timestamp: entry.timestamp ?? null });
    }
  }
  return { meta, turns };
}

function localTime(iso) {
  const date = iso ? new Date(iso) : null;
  if (!date || Number.isNaN(date.getTime())) return null;
  const pad = (n) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

export function renderTurn(turn) {
  const when = localTime(turn.timestamp);
  return `### ${turn.role === "you" ? "You" : "Claude"}${when ? ` · ${when}` : ""}\n\n${turn.text}`;
}

/** Splits rendered turns into pieces the server accepts, never cutting a turn unless it alone is too long. */
export function chunkTurns(rendered, limit = CHUNK_CHARACTERS) {
  const chunks = [];
  let current = { text: "", count: 0 };
  for (const piece of rendered) {
    const text = piece.length > limit ? piece.slice(0, limit) : piece;
    if (current.count && current.text.length + text.length + 2 > limit) {
      chunks.push(current);
      current = { text: "", count: 0 };
    }
    current.text = current.text ? `${current.text}\n\n${text}` : text;
    current.count += 1;
  }
  if (current.count) chunks.push(current);
  return chunks;
}

export function sessionTitle(meta, turns) {
  const first = turns.find((turn) => turn.role === "you")?.text.split("\n").find((line) => line.trim()) ?? "Session";
  const title = (meta.title || first).replace(/[`*_#>[\]]/gu, "").replace(/\s+/gu, " ").trim();
  return `Claude Code · ${title.length > 80 ? `${title.slice(0, 79).trim()}…` : title || "Session"}`;
}

// ---------- Margin Chat MCP ----------

export function createClient({ url, token, fetchImpl = fetch }) {
  let nextId = 1;
  return async function callTool(name, args) {
    const response = await fetchImpl(url, {
      method: "POST",
      headers: {
        authorization: `Bearer ${token}`,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
        "mcp-protocol-version": "2025-06-18",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: nextId++, method: "tools/call", params: { name, arguments: args } }),
    });
    if (response.status === 401 || response.status === 403) {
      const detail = await response.text().catch(() => "");
      throw Object.assign(new Error(`Margin Chat refused the token (${response.status}). ${detail}`.trim()), { fatal: true });
    }
    if (!response.ok) throw new Error(`Margin Chat answered ${response.status}.`);
    const message = await response.json();
    if (message.error) throw Object.assign(new Error(message.error.message ?? "MCP error"), { fatal: true });
    const result = message.result ?? {};
    if (result.isError) return { ok: false, error: result.content?.[0]?.text ?? "Margin Chat refused that." };
    return result.structuredContent ?? JSON.parse(result.content?.[0]?.text ?? "{}");
  };
}

async function withRetry(call) {
  const first = await call();
  if (first?.ok !== false || !/changed on another device|couldn't be saved just now/u.test(first.error ?? "")) return first;
  await new Promise((resolve) => setTimeout(resolve, 1500));
  return call();
}

async function ensureHub(callTool, state, project) {
  state.hubs ??= { root: null, projects: {} };
  const create = async (title, content, parent) => {
    const made = await callTool("create_document", { title, content, ...(parent ? { relations: [{ type: "part-of", document_id: parent }] } : {}) });
    return made?.ok === false ? null : made.document_id;
  };
  if (!state.hubs.root) {
    state.hubs.root = await create(ROOT_HUB_TITLE, "Every Claude Code session is saved here automatically, grouped by project. Delete a session's document and it won't be saved again.");
  }
  if (!state.hubs.projects[project]) {
    state.hubs.projects[project] = await create(`Claude Code · ${project}`, `Claude Code sessions in the \`${project}\` folder.`, state.hubs.root);
  }
  return state.hubs.projects[project];
}

/** Saves what's new in one session. Returns a short line for the log. */
export async function saveSession({ transcriptPath, sessionId, callTool, state, now = () => new Date() }) {
  const { meta, turns } = parseTranscript(readFileSync(transcriptPath, "utf8"));
  const id = sessionId || basename(transcriptPath, ".jsonl");
  state.sessions ??= {};
  const record = state.sessions[id] ?? { documentId: null, saved: [], characters: 0 };
  if (record.deleted) return `${id}: skipped, its document was deleted`;
  const saved = new Set(record.saved);
  const fresh = turns.filter((turn) => !turn.uuids.every((uuid) => saved.has(uuid)));
  if (!fresh.length) return `${id}: nothing new`;
  if (!record.documentId && !turns.some((turn) => turn.role === "you")) return `${id}: skipped, no prompts`;

  let rendered = fresh.map(renderTurn);
  const room = DOCUMENT_CHARACTERS - record.characters;
  if (room <= 0) return `${id}: skipped, document is full`;
  const total = rendered.reduce((sum, text) => sum + text.length + 2, 0);
  let cut = false;
  if (total > room) {
    let used = 0;
    rendered = rendered.filter((text) => (used += text.length + 2) <= room);
    cut = true;
  }
  const chunks = chunkTurns(rendered);
  if (cut && chunks.length) chunks.at(-1).text += "\n\n*[The rest of this session was too long to save.]*";

  let done = 0;
  for (const chunk of chunks) {
    const covered = fresh.slice(done, done + chunk.count);
    let result;
    if (!record.documentId) {
      const project = basename(meta.cwd || "") || "Unknown folder";
      let hub = await ensureHub(callTool, state, project);
      const header = [`Claude Code session in \`${meta.cwd || project}\``, meta.gitBranch ? `on branch \`${meta.gitBranch}\`` : null,
        localTime(meta.startedAt) ? `started ${localTime(meta.startedAt)}` : null].filter(Boolean).join(", ");
      const args = (parent) => ({ title: sessionTitle(meta, turns), content: `${header}.\n\n${chunk.text}`,
        ...(parent ? { relations: [{ type: "part-of", document_id: parent }] } : {}) });
      result = await callTool("create_document", args(hub));
      if (result?.ok === false && /No document has the id/u.test(result.error ?? "")) {
        // The hub was deleted in the app: make it again.
        state.hubs = { root: null, projects: {} };
        hub = await ensureHub(callTool, state, project);
        result = await callTool("create_document", args(hub));
      }
      if (result?.ok !== false) record.documentId = result.document_id;
    } else {
      result = await withRetry(() => callTool("append_to_document", { document_id: record.documentId, content: chunk.text }));
      if (result?.ok === false && result.found === false) {
        record.deleted = true;
        state.sessions[id] = record;
        return `${id}: its document was deleted, so it won't be saved again`;
      }
    }
    if (result?.ok === false) {
      state.sessions[id] = record;
      throw new Error(`${id}: ${result.error}`);
    }
    for (const turn of covered) record.saved.push(...turn.uuids);
    record.characters += chunk.text.length + 2;
    record.updatedAt = now().toISOString();
    state.sessions[id] = record;
    done += chunk.count;
  }
  // Turns left out for length still count as handled, so they aren't retried every time.
  if (cut) for (const turn of fresh.slice(done)) record.saved.push(...turn.uuids);
  return `${id}: saved ${done} turn${done === 1 ? "" : "s"} to ${record.documentId}`;
}

// ---------- files, config and commands ----------

function readJson(path, fallback) {
  try { return JSON.parse(readFileSync(path, "utf8")); } catch { return fallback; }
}

function writeJson(path, value, mode) {
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${process.pid}.tmp`;
  writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, mode ? { mode } : undefined);
  renameSync(temporary, path);
  if (mode) chmodSync(path, mode);
}

function log(line) {
  try {
    mkdirSync(homeDir(), { recursive: true });
    const { log: file } = paths();
    if (existsSync(file) && statSync(file).size > 1_000_000) writeFileSync(file, "");
    appendFileSync(file, `${new Date().toISOString()} ${line}\n`);
  } catch {}
}

function loadConfig() {
  const config = readJson(paths().config, {});
  return { url: process.env.MARGIN_CHAT_MCP_URL || config.url || DEFAULT_MCP_URL, token: process.env.MARGIN_CHAT_TOKEN || config.token || null };
}

/** The token from a `claude mcp add … margin-chat` entry, if there is one. */
export function tokenFromClaudeConfig(config) {
  const servers = [config?.mcpServers, ...Object.values(config?.projects ?? {}).map((project) => project?.mcpServers)];
  for (const group of servers) {
    for (const server of Object.values(group ?? {})) {
      if (!String(server?.url ?? "").includes("marginchat.com/api/mcp")) continue;
      const header = Object.entries(server.headers ?? {}).find(([key]) => key.toLowerCase() === "authorization")?.[1];
      const token = /Bearer\s+(mc_mcp_\S+)/u.exec(String(header ?? ""))?.[1];
      if (token) return token;
    }
  }
  return null;
}

const argValue = (args, flag) => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};

async function withState(work) {
  const lock = join(homeDir(), "state.lock");
  mkdirSync(homeDir(), { recursive: true });
  for (let tries = 0; ; tries += 1) {
    try { writeFileSync(lock, String(process.pid), { flag: "wx" }); break; } catch {
      // A lock older than two minutes belongs to a save that died.
      try { if (Date.now() - statSync(lock).mtimeMs > 120_000) { writeFileSync(lock, String(process.pid)); break; } } catch {}
      if (tries > 60) throw new Error("Another save is still running.");
      await new Promise((resolve) => setTimeout(resolve, 1000));
    }
  }
  const state = readJson(paths().state, { hubs: { root: null, projects: {} }, sessions: {} });
  try {
    return await work(state);
  } finally {
    writeJson(paths().state, state, 0o600);
    try { unlinkSync(lock); } catch {}
  }
}

async function commandSave(transcriptPath, sessionId) {
  const { url, token } = loadConfig();
  if (!token) return log("no token: run install again");
  const callTool = createClient({ url, token });
  await withState(async (state) => {
    try { log(await saveSession({ transcriptPath, sessionId, callTool, state })); } catch (error) { log(`failed: ${error.message}`); }
  });
}

async function commandHook() {
  if (process.env.MARGIN_CHAT_AUTOSAVE === "0") return;
  let input = "";
  for await (const chunk of process.stdin) input += chunk;
  let hook = null;
  try { hook = JSON.parse(input); } catch { return; }
  const transcriptPath = hook?.transcript_path;
  if (!transcriptPath || !existsSync(transcriptPath)) return;
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "save", transcriptPath, hook.session_id ?? ""], {
    detached: true, stdio: "ignore", env: process.env,
  });
  child.unref();
}

async function commandSync(args) {
  const days = Number(argValue(args, "--days") ?? 30);
  const since = Date.now() - days * 86_400_000;
  const { url, token } = loadConfig();
  if (!token) throw new Error("No token yet. Run install first.");
  const callTool = createClient({ url, token });
  const root = join(claudeHome(), "projects");
  const files = existsSync(root) ? readdirSync(root).flatMap((folder) => {
    const dir = join(root, folder);
    try { return readdirSync(dir).filter((name) => name.endsWith(".jsonl")).map((name) => join(dir, name)); } catch { return []; }
  }).filter((file) => statSync(file).mtimeMs >= since).sort((a, b) => statSync(a).mtimeMs - statSync(b).mtimeMs) : [];
  console.log(`Checking ${files.length} session${files.length === 1 ? "" : "s"} from the last ${days} days…`);
  await withState(async (state) => {
    for (const file of files) {
      try {
        const line = await saveSession({ transcriptPath: file, sessionId: basename(file, ".jsonl"), callTool, state });
        console.log(line);
        log(line);
      } catch (error) {
        console.error(error.message);
        log(`failed: ${error.message}`);
        if (error.fatal) break;
      }
    }
  });
}

const HOOK_MARK = "margin-chat-autosave";

function hookCommand() {
  return `"${process.execPath}" "${paths().script}" hook`;
}

function withoutOurHook(settings) {
  const groups = settings.hooks?.SessionEnd ?? [];
  return groups.map((group) => ({ ...group, hooks: (group.hooks ?? []).filter((hook) => !String(hook.command ?? "").includes(HOOK_MARK)) }))
    .filter((group) => group.hooks.length);
}

async function commandInstall(args) {
  let token = argValue(args, "--token") || process.env.MARGIN_CHAT_TOKEN || loadConfig().token
    || tokenFromClaudeConfig(readJson(join(homedir(), ".claude.json"), {}));
  if (!token) {
    process.stdout.write("Paste a Margin Chat agent token that can create documents (Settings → Agents): ");
    for await (const chunk of process.stdin) { token = String(chunk).trim(); break; }
  }
  if (!/^mc_mcp_\S+$/u.test(token ?? "")) throw new Error("That doesn't look like a Margin Chat agent token (they start with mc_mcp_).");
  const url = argValue(args, "--url") || loadConfig().url;

  // Check the token can write before changing anything.
  const probe = await fetch(url, { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json", accept: "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "tools/list" }) });
  if (!probe.ok) throw new Error(`Margin Chat refused the token (${probe.status}). Make a new one in Settings → Agents.`);
  const tools = (await probe.json()).result?.tools ?? [];
  if (!tools.some((tool) => tool.name === "create_document")) {
    throw new Error("That token can only read. Make one with \"Can create documents and add to them\" ticked.");
  }

  mkdirSync(homeDir(), { recursive: true });
  copyFileSync(fileURLToPath(import.meta.url), paths().script);
  writeJson(paths().config, { url, token }, 0o600);
  const settingsPath = join(claudeHome(), "settings.json");
  const settings = readJson(settingsPath, {});
  settings.hooks ??= {};
  settings.hooks.SessionEnd = [...withoutOurHook(settings), { hooks: [{ type: "command", command: hookCommand(), timeout: 10 }] }];
  writeJson(settingsPath, settings);
  console.log(`Installed. Every Claude Code session will be saved to Margin Chat when it ends.
To save sessions from the last 30 days now, run:
  "${process.execPath}" "${paths().script}" sync
What happened is logged in ${paths().log}`);
}

function commandUninstall() {
  const settingsPath = join(claudeHome(), "settings.json");
  const settings = readJson(settingsPath, null);
  if (settings?.hooks?.SessionEnd) {
    const kept = withoutOurHook(settings);
    if (kept.length) settings.hooks.SessionEnd = kept; else delete settings.hooks.SessionEnd;
    writeJson(settingsPath, settings);
  }
  console.log(`Removed the hook. Your token is still in ${paths().config}; delete that folder and revoke the token in Settings → Agents if you're done with it.`);
}

const isMain = process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1];
if (isMain) {
  const [command, ...args] = process.argv.slice(2);
  const run = {
    hook: () => commandHook(),
    save: () => commandSave(args[0], args[1]),
    sync: () => commandSync(args),
    install: () => commandInstall(args),
    uninstall: () => commandUninstall(),
  }[command];
  if (!run) {
    console.log("Usage: claude-code-autosave.mjs install [--token mc_mcp_…] | sync [--days 30] | uninstall");
    process.exit(command ? 1 : 0);
  }
  Promise.resolve().then(run).catch((error) => {
    console.error(error.message);
    log(`failed: ${error.message}`);
    process.exit(command === "hook" ? 0 : 1);
  });
}
