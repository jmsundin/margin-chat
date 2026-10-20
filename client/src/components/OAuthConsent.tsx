import { useEffect, useState } from "react";
import { apiFetch } from "../lib/apiTransport";
import type { AuthenticatedUser } from "../types";

interface ConsentRequest {
  clientName: string;
  redirectHost: string;
  scope: "read" | "write";
}

const AGENT_SETTINGS_HEADERS = { "Content-Type": "application/json", "X-Margin-Agent-Settings": "1" };

async function readError(response: Response, fallback: string) {
  const payload = await response.json().catch(() => null) as { error?: string; error_description?: string } | null;
  return payload?.error_description ?? payload?.error ?? fallback;
}

/** The page an MCP connector (ChatGPT, claude.ai) sends a member to, to approve its access to their vault. */
export default function OAuthConsent({ user }: { user: AuthenticatedUser }) {
  const [params] = useState(() => Object.fromEntries(new URLSearchParams(window.location.search)));
  const [request, setRequest] = useState<ConsentRequest | null>(null);
  const [write, setWrite] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const canConnect = user.role === "admin" || user.billing.accessKind === "subscription";

  useEffect(() => {
    let current = true;
    void (async () => {
      const response = await apiFetch(`/api/oauth/authorization?${new URLSearchParams(params)}`, { credentials: "same-origin", cache: "no-store" });
      if (!current) return;
      if (!response.ok) {
        setError(await readError(response, "This connection request couldn't be read. Try connecting from the app again."));
        return;
      }
      const described = await response.json() as ConsentRequest;
      if (!current) return;
      setRequest(described);
      setWrite(described.scope === "write");
    })().catch(() => { if (current) setError("Margin Chat couldn't be reached. Check your connection and reload this page."); });
    return () => { current = false; };
  }, [params]);

  async function decide(allow: boolean) {
    setBusy(true);
    setError(null);
    try {
      const response = await apiFetch("/api/oauth/authorization", {
        body: JSON.stringify({ request: params, allow, write: allow && write }),
        credentials: "same-origin", headers: AGENT_SETTINGS_HEADERS, method: "POST",
      });
      if (!response.ok) throw new Error(await readError(response, "That didn't go through. Try again."));
      const { redirectTo } = await response.json() as { redirectTo: string };
      window.location.assign(redirectTo);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : "That didn't go through. Try again.");
      setBusy(false);
    }
  }

  return (
    <div className="auth-loading-card oauth-consent">
      <p className="eyebrow">Margin Chat</p>
      {request ? (
        <>
          <h1>Connect {request.clientName} to your vault?</h1>
          <p className="auth-copy">
            {request.clientName} will be able to search and read your documents, notes, chats and PDFs as {user.displayName}.
            It never sees documents you hide from AI. After you approve, you'll go back to {request.redirectHost}.
          </p>
          {request.scope === "write" ? (
            <label className="agent-token-write">
              <input checked={write} disabled={busy} onChange={(event) => setWrite(event.target.checked)} type="checkbox" />
              Also let it create documents and add to them (it can never change or delete what's there)
            </label>
          ) : null}
          {canConnect ? null : <p className="auth-copy">Connecting agents comes with the Plus and Cloud plans.</p>}
          <p className="auth-copy">You can disconnect it any time in Profile, Agents.</p>
          <div className="oauth-consent-actions">
            <button className="thread-dialog-button" disabled={busy} onClick={() => void decide(false)} type="button">Cancel</button>
            <button className="thread-dialog-button is-primary" disabled={busy || !canConnect} onClick={() => void decide(true)} type="button">
              Connect
            </button>
          </div>
        </>
      ) : error ? null : <h1>Checking the connection request…</h1>}
      {error ? <p className="profile-dialog-error" role="alert">{error}</p> : null}
    </div>
  );
}
