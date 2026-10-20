# Save Claude Code sessions automatically

`scripts/claude-code-autosave.mjs` saves every Claude Code session into your Margin Chat vault when the session ends. It uses the [MCP server](mcp-server.md) with your own agent token, so the sessions run on your Claude subscription as usual and Margin Chat only receives the text.

## Set it up

1. In Margin Chat, open **Profile → Agents** and make a token named "Claude Code" with **Can create documents and add to them** ticked. If you already added Margin Chat with `claude mcp add … --header "Authorization: Bearer mc_mcp_…"`, the installer reuses that token, so you can skip this step.
2. From your Margin Chat checkout, run:

   ```sh
   node scripts/claude-code-autosave.mjs install
   ```

   It checks that the token can create documents and asks for one if it can't find one. Then it copies itself to `~/.claude/margin-chat-autosave/autosave.mjs`, keeps the token in `config.json` there (readable only by you), and adds a `SessionEnd` hook to `~/.claude/settings.json`. Your other hooks are left as they are.
3. Optional: save sessions from before you installed it:

   ```sh
   node ~/.claude/margin-chat-autosave/autosave.mjs sync --days 30
   ```

## What gets saved

- One document per session, titled "Claude Code · <the session's title>". It's part of a "Claude Code · <folder>" document, which is part of "Claude Code sessions", so on the map your sessions are grouped by project.
- Your prompts and Claude's written replies, with times. Tool calls, tool output, file contents, thinking, subagent work and slash-command output are left out. Common secret formats (Margin Chat, Anthropic, OpenAI, GitHub, AWS, Slack and Google keys) are replaced with `[redacted]`.
- When you resume a session, only the new turns are added to the end of the same document.
- If you delete a session's document in Margin Chat, it isn't saved again. If you delete a hub, it's made again on the next save.
- Very long sessions stop at about 1.5 million characters, and each message is cut at 20,000 characters.

## How it works

Claude Code runs the hook as each session ends: on `/clear`, on exit, and on logout. The hook only starts a background save and returns right away, so quitting is never slowed down. The save reads the session's transcript (`~/.claude/projects/<folder>/<session>.jsonl`), keeps track of which turns it has already saved in `state.json`, and calls `create_document` or `append_to_document` in pieces of up to 90,000 characters. If you close the terminal window instead of quitting, the hook may not run, and the next `sync` catches that session up. Every save writes a line to `~/.claude/margin-chat-autosave/log.txt`.

Set `MARGIN_CHAT_AUTOSAVE=0` to skip saving for a session. `MARGIN_CHAT_TOKEN` and `MARGIN_CHAT_MCP_URL` override the saved token and address, for example to point at a local server.

## Remove it

```sh
node ~/.claude/margin-chat-autosave/autosave.mjs uninstall
```

This removes the hook. Delete `~/.claude/margin-chat-autosave/` and revoke the token in **Profile → Agents** to remove everything.

Tests: `bun --no-env-file test tests/claude-code-autosave.test.ts`.
