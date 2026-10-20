import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync, appendFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  chunkTurns,
  cleanUserText,
  createClient,
  parseTranscript,
  redactSecrets,
  saveSession,
  sessionTitle,
  tokenFromClaudeConfig,
} from "../scripts/claude-code-autosave.mjs";

const line = (entry: object) => `${JSON.stringify(entry)}\n`;
const user = (uuid: string, content: unknown, extra: object = {}) =>
  line({ type: "user", uuid, cwd: "/Users/jon/src/margin-chat", gitBranch: "main", timestamp: "2026-10-20T02:00:00Z", message: { role: "user", content }, ...extra });
const claude = (uuid: string, content: unknown) =>
  line({ type: "assistant", uuid, timestamp: "2026-10-20T02:01:00Z", message: { role: "assistant", content } });

function transcript(...lines: string[]) {
  const dir = mkdtempSync(join(tmpdir(), "autosave-"));
  const path = join(dir, "session-1.jsonl");
  writeFileSync(path, lines.join(""));
  return path;
}

/** A stand-in for the Margin Chat MCP server's write tools. */
function fakeVault() {
  const documents = new Map<string, { title: string; content: string; relations?: unknown }>();
  let next = 1;
  const calls: string[] = [];
  const callTool = async (name: string, args: any) => {
    calls.push(name);
    if (name === "create_document") {
      for (const relation of args.relations ?? []) {
        if (!documents.has(relation.document_id)) return { ok: false, error: `No document has the id ${relation.document_id}.` };
      }
      const id = `mcp-${next++}`;
      documents.set(id, { title: args.title, content: args.content, relations: args.relations });
      return { ok: true, document_id: id, title: args.title };
    }
    const doc = documents.get(args.document_id);
    if (!doc) return { document_id: args.document_id, found: false, ok: false, error: "No document has that id." };
    doc.content += `\n\n${args.content}`;
    return { ok: true, document_id: args.document_id };
  };
  return { documents, callTool, calls };
}

describe("Claude Code autosave transcript reading", () => {
  test("keeps prompts and replies, drops tool traffic, thinking, meta and subagent entries", () => {
    const { meta, turns } = parseTranscript([
      line({ type: "ai-title", aiTitle: "Fix the map lines" }),
      user("u1", "Why are links not drawn?"),
      claude("a1", [{ type: "thinking", thinking: "hmm" }, { type: "text", text: "Let me look." }, { type: "tool_use", name: "Read" }]),
      user("u2", [{ type: "tool_result", content: "file contents" }]),
      claude("a2", [{ type: "text", text: "Found it." }]),
      user("u3", "<system-reminder>ignore</system-reminder>", { isMeta: true }),
      user("u4", "side task", { isSidechain: true }),
      user("u5", "[Request interrupted by user]"),
    ].join(""));
    expect(meta.title).toBe("Fix the map lines");
    expect(meta.cwd).toBe("/Users/jon/src/margin-chat");
    expect(turns.map((turn) => [turn.role, turn.text])).toEqual([
      ["you", "Why are links not drawn?"],
      ["claude", "Let me look.\n\nFound it."],
    ]);
    expect(turns[1].uuids).toEqual(["a1", "a2"]);
  });

  test("shows slash commands briefly and drops their output", () => {
    expect(cleanUserText("<command-name>/review</command-name><command-args>42</command-args>")).toBe("`/review 42`");
    expect(cleanUserText("<local-command-stdout>lots</local-command-stdout>")).toBeNull();
    expect(cleanUserText("<bash-input>ls</bash-input>")).toBe("`! ls`");
  });

  test("redacts tokens and keys", () => {
    const text = redactSecrets("token mc_mcp_SCLz6_nzRl5A6i3do6GtXTLFoDgU and sk-ant-abcdefghijklmnopqrstuvwxyz123");
    expect(text).toBe("token [redacted] and [redacted]");
  });

  test("titles come from Claude Code's title, else the first prompt", () => {
    expect(sessionTitle({ title: "Fix the map lines" }, [])).toBe("Claude Code · Fix the map lines");
    expect(sessionTitle({ title: null }, [{ role: "you", text: "# Plan the **import**\nmore", uuids: [] }])).toBe("Claude Code · Plan the import");
  });

  test("chunks stay under the server's limit without splitting turns", () => {
    const chunks = chunkTurns(["a".repeat(60), "b".repeat(60), "c".repeat(10)], 100);
    expect(chunks.map((chunk) => chunk.count)).toEqual([1, 2]);
    expect(chunks.every((chunk) => chunk.text.length <= 100)).toBe(true);
  });

  test("finds the token from claude mcp add", () => {
    const config = { projects: { "/Users/jon": { mcpServers: { "margin-chat": { type: "http", url: "https://www.marginchat.com/api/mcp",
      headers: { Authorization: "Bearer mc_mcp_abc123" } } } } } };
    expect(tokenFromClaudeConfig(config)).toBe("mc_mcp_abc123");
    expect(tokenFromClaudeConfig({})).toBeNull();
  });
});

describe("Claude Code autosave saving", () => {
  test("creates hubs and a session document, then appends only new turns when resumed", async () => {
    const vault = fakeVault();
    const state: any = {};
    const path = transcript(line({ type: "ai-title", aiTitle: "Map lines" }), user("u1", "First question"), claude("a1", [{ type: "text", text: "First answer" }]));
    await saveSession({ transcriptPath: path, sessionId: "s1", callTool: vault.callTool, state });
    const [root, hub, session] = [...vault.documents.values()];
    expect(root.title).toBe("Claude Code sessions");
    expect(hub.title).toBe("Claude Code · margin-chat");
    expect(session.title).toBe("Claude Code · Map lines");
    expect(session.content).toContain("### You · ");
    expect(session.content).toContain("First answer");
    expect(session.relations).toEqual([{ type: "part-of", document_id: state.hubs.projects["margin-chat"] }]);

    expect(await saveSession({ transcriptPath: path, sessionId: "s1", callTool: vault.callTool, state })).toContain("nothing new");

    appendFileSync(path, user("u2", "Second question") + claude("a2", [{ type: "text", text: "Second answer" }]));
    await saveSession({ transcriptPath: path, sessionId: "s1", callTool: vault.callTool, state });
    expect(vault.documents.size).toBe(3);
    const updated = vault.documents.get(state.sessions.s1.documentId)!;
    expect(updated.content.match(/First question/g)?.length).toBe(1);
    expect(updated.content).toContain("Second answer");
  });

  test("skips sessions with no prompts and respects a deleted document", async () => {
    const vault = fakeVault();
    const state: any = {};
    const empty = transcript(claude("a1", [{ type: "text", text: "hello" }]));
    expect(await saveSession({ transcriptPath: empty, sessionId: "e", callTool: vault.callTool, state })).toContain("no prompts");
    expect(vault.calls).toEqual([]);

    const path = transcript(user("u1", "Question"));
    await saveSession({ transcriptPath: path, sessionId: "s", callTool: vault.callTool, state });
    vault.documents.delete(state.sessions.s.documentId);
    appendFileSync(path, user("u2", "More"));
    expect(await saveSession({ transcriptPath: path, sessionId: "s", callTool: vault.callTool, state })).toContain("deleted");
    appendFileSync(path, user("u3", "Even more"));
    expect(await saveSession({ transcriptPath: path, sessionId: "s", callTool: vault.callTool, state })).toContain("skipped");
    expect(vault.documents.size).toBe(2);
  });

  test("remakes the hubs when they were deleted in the app", async () => {
    const vault = fakeVault();
    const state: any = { hubs: { root: "gone-root", projects: { "margin-chat": "gone-hub" } } };
    await saveSession({ transcriptPath: transcript(user("u1", "Question")), sessionId: "s", callTool: vault.callTool, state });
    expect(state.hubs.projects["margin-chat"]).not.toBe("gone-hub");
    expect(vault.documents.get(state.sessions.s.documentId)?.relations).toEqual([{ type: "part-of", document_id: state.hubs.projects["margin-chat"] }]);
  });

  test("the client sends a Bearer token and reads structured results", async () => {
    let seen: any;
    const callTool = createClient({ url: "https://example.test/api/mcp", token: "mc_mcp_x", fetchImpl: async (_url: string, init: any) => {
      seen = { auth: init.headers.authorization, body: JSON.parse(init.body) };
      return new Response(JSON.stringify({ jsonrpc: "2.0", id: 1, result: { content: [], structuredContent: { ok: true, document_id: "d" } } }));
    } });
    expect(await callTool("create_document", { title: "t", content: "c" })).toEqual({ ok: true, document_id: "d" });
    expect(seen.auth).toBe("Bearer mc_mcp_x");
    expect(seen.body.method).toBe("tools/call");

    const refused = createClient({ url: "u", token: "t", fetchImpl: async () => new Response("revoked", { status: 401 }) });
    await expect(refused("create_document", {})).rejects.toThrow("refused the token");
  });
});
