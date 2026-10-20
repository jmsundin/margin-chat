import { useEffect, useState } from "react";
import {
  requestAgentTokens,
  requestCreateAgentToken,
  requestRevokeAgentToken,
  type AgentToken,
} from "../lib/api";
import { apiServerUrl } from "../lib/apiTransport";

const dateFormat = new Intl.DateTimeFormat(undefined, { day: "numeric", month: "short", year: "numeric" });
const formatDate = (value: string) => dateFormat.format(new Date(value));

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false);
  return (
    <button
      className="thread-dialog-button"
      onClick={() => {
        void navigator.clipboard?.writeText(text).then(() => setCopied(true), () => undefined);
      }}
      type="button"
    >
      {copied ? "Copied" : "Copy"}
    </button>
  );
}

/** Settings for outside AI agents (Claude Code, Cursor, ...) that reach the vault over MCP. */
export default function AgentConnectionsPanel() {
  const [tokens, setTokens] = useState<AgentToken[] | null>(null);
  const [canConnect, setCanConnect] = useState(true);
  const [name, setName] = useState("");
  const [canWrite, setCanWrite] = useState(false);
  const [created, setCreated] = useState<{ token: string; name: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const endpoint = `${apiServerUrl()}/api/mcp`;

  useEffect(() => {
    let current = true;
    requestAgentTokens().then((result) => {
      if (!current) return;
      setTokens(result.tokens);
      setCanConnect(result.canConnect);
    }, (failure: unknown) => {
      if (current) setError(failure instanceof Error ? failure.message : "Couldn't load your agent tokens.");
    });
    return () => { current = false; };
  }, []);

  async function create() {
    setBusy(true);
    setError(null);
    try {
      const result = await requestCreateAgentToken(name.trim(), canWrite ? "write" : "read");
      setCreated({ token: result.token, name: result.summary.name });
      setTokens((current) => [result.summary, ...(current ?? [])]);
      setName("");
      setCanWrite(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't make an agent token.");
    } finally {
      setBusy(false);
    }
  }

  async function revoke(token: AgentToken) {
    setBusy(true);
    setError(null);
    try {
      await requestRevokeAgentToken(token.id);
      setTokens((current) => (current ?? []).filter((item) => item.id !== token.id));
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "Couldn't revoke that agent token.");
    } finally {
      setBusy(false);
    }
  }

  const claudeCommand = created
    ? `claude mcp add --scope user --transport http margin-chat ${endpoint} --header "Authorization: Bearer ${created.token}"`
    : "";
  const clientConfig = created
    ? JSON.stringify({ mcpServers: { "margin-chat": { type: "http", url: endpoint, headers: { Authorization: `Bearer ${created.token}` } } } }, null, 2)
    : "";

  return (
    <>
      <div className="profile-api-key-heading">
        <div>
          <p className="eyebrow">MCP</p>
          <strong>Connect AI agents to your vault</strong>
        </div>
        <span>You choose access</span>
      </div>

      <p className="thread-dialog-copy">
        Claude Code, Cursor and other agents that support MCP can search and read your documents, notes, chats
        and PDFs in your cloud vault. If you allow it, they can also create documents and add to the end of
        existing ones, but never change or delete what's there. Agents never see documents you hide from AI. Each
        token works until you revoke it, for up to a year.
      </p>

      {!canConnect ? (
        <p className="thread-dialog-copy">Connecting agents comes with the Plus and Cloud plans.</p>
      ) : (
        <form
          className="agent-token-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (name.trim()) void create();
          }}
        >
          <label className="thread-dialog-field">
            <span className="thread-dialog-label">Token name</span>
            <input
              autoComplete="off"
              className="thread-dialog-input"
              disabled={busy}
              maxLength={80}
              onChange={(event) => setName(event.target.value)}
              placeholder="Claude Code on my laptop"
              value={name}
            />
          </label>
          <button className="thread-dialog-button is-primary" disabled={busy || !name.trim()} type="submit">
            Make token
          </button>
          <label className="agent-token-write">
            <input checked={canWrite} disabled={busy} onChange={(event) => setCanWrite(event.target.checked)} type="checkbox" />
            Can create documents and add to them
          </label>
        </form>
      )}

      {created ? (
        <section aria-label="New agent token" className="agent-token-reveal">
          <strong>Copy “{created.name}” now. It won't be shown again.</strong>
          <div className="agent-token-code">
            <code>{created.token}</code>
            <CopyButton text={created.token} />
          </div>
          <span className="thread-dialog-label">Claude Code</span>
          <div className="agent-token-code">
            <code>{claudeCommand}</code>
            <CopyButton text={claudeCommand} />
          </div>
          <span className="thread-dialog-label">Cursor and other MCP clients</span>
          <div className="agent-token-code">
            <pre>{clientConfig}</pre>
            <CopyButton text={clientConfig} />
          </div>
          <button className="thread-dialog-button" onClick={() => setCreated(null)} type="button">Done</button>
        </section>
      ) : null}

      {error ? <p className="profile-dialog-error" role="alert">{error}</p> : null}

      {tokens?.length ? (
        <ul aria-label="Agent tokens" className="agent-token-list">
          {tokens.map((token) => (
            <li className="agent-token-row" key={token.id}>
              <div>
                <strong>{token.name}</strong>
                <span>
                  {token.connector ? "Signed-in app · " : ""}
                  {token.scope === "write" ? "Reads and adds" : "Read-only"}
                  {" · "}
                  Made {formatDate(token.createdAt)}
                  {" · "}
                  {token.lastUsedAt ? `Last used ${formatDate(token.lastUsedAt)}` : "Not used yet"}
                  {" · "}
                  Expires {formatDate(token.expiresAt)}
                </span>
              </div>
              <button className="thread-dialog-button is-danger" disabled={busy} onClick={() => void revoke(token)} type="button">
                Revoke
              </button>
            </li>
          ))}
        </ul>
      ) : tokens ? (
        <p className="thread-dialog-copy">No agents connected yet.</p>
      ) : null}

      <p className="thread-dialog-copy">
        Server address: <code>{endpoint}</code>. To connect ChatGPT or Claude.ai, add a custom connector with this
        address. You'll be asked to sign in and approve it here, with no token to copy.{" "}
        <a href="https://www.marginchat.com/connect" rel="noreferrer" target="_blank">Step-by-step guides for each app</a>
      </p>
    </>
  );
}
