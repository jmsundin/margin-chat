import { useEffect, useRef, useState } from "react";
import {
  captureToMarkdown,
  type Capture,
  type CaptureSummary,
  type CaptureTokenSummary,
} from "@margin-chat/capture-contracts";
import {
  createCaptureToken,
  getCaptureToken,
  listCaptures,
  loadCapture,
  revokeCaptureToken,
} from "../lib/captures";
import { renderMarkdownToHtml } from "../lib/markdown";

interface Props {
  onClose: () => void;
  onOpenNote: (capture: Capture) => void;
}
const errorText = (error: unknown) =>
  error instanceof Error ? error.message : "Unable to reach your Cloud Inbox.";

function ExtensionConnection() {
  const [summary, setSummary] = useState<CaptureTokenSummary | null>(null);
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState(true);
  const [message, setMessage] = useState("");
  useEffect(() => {
    let active = true;
    void getCaptureToken()
      .then((result) => {
        if (active) setSummary(result.summary);
      })
      .catch((error) => {
        if (active) setMessage(errorText(error));
      })
      .finally(() => {
        if (active) setBusy(false);
      });
    return () => {
      active = false;
    };
  }, []);
  async function changeKey(revoke = false) {
    setBusy(true);
    setMessage("");
    try {
      if (revoke) {
        await revokeCaptureToken();
        setToken("");
        setSummary(null);
        setMessage("Capture key revoked.");
      } else {
        const result = await createCaptureToken();
        setToken(result.token);
        setSummary(result.summary);
      }
    } catch (error) {
      setMessage(errorText(error));
    } finally {
      setBusy(false);
    }
  }
  return (
    <div className="capture-connection">
      <p className="eyebrow">Save to Margin · Chrome extension</p>
      <h3>Bring the web into your notes.</h3>
      <p>
        In the extension’s Settings, enter this website address and a capture
        key. Your key only allows saving captures and checking the connection.
      </p>
      <label htmlFor="capture-website">Margin Chat website</label>
      <input
        id="capture-website"
        readOnly
        value={window.location.origin}
        onFocus={(event) => event.target.select()}
      />
      {summary ? (
        <p className="capture-muted">
          Current key expires {new Date(summary.expiresAt).toLocaleDateString()}
          .
          {summary.lastUsedAt
            ? ` Last used ${new Date(summary.lastUsedAt).toLocaleString()}.`
            : " Not used yet."}
        </p>
      ) : null}
      {token ? (
        <>
          <label htmlFor="capture-key">
            Capture key · shown only this time
          </label>
          <input
            id="capture-key"
            readOnly
            type="password"
            value={token}
            onFocus={(event) => event.target.select()}
          />
          <button
            className="thread-dialog-button"
            type="button"
            onClick={() =>
              void navigator.clipboard
                .writeText(token)
                .then(() =>
                  setMessage(
                    "Key copied. Paste it into the extension settings.",
                  ),
                )
                .catch(() =>
                  setMessage("Select the key field and copy it manually."),
                )
            }
          >
            Copy key
          </button>
        </>
      ) : null}
      {summary ? (
        <p className="capture-muted">
          Replacing or revoking the key disconnects extensions using it.
        </p>
      ) : null}
      <div className="capture-actions">
        <button
          className="thread-dialog-button is-primary"
          disabled={busy}
          onClick={() => void changeKey()}
          type="button"
        >
          {busy
            ? "Please wait…"
            : summary
              ? "Replace capture key"
              : "Create capture key"}
        </button>
        {summary ? (
          <button
            className="thread-dialog-button is-danger"
            disabled={busy}
            onClick={() => void changeKey(true)}
            type="button"
          >
            Revoke key
          </button>
        ) : null}
      </div>
      <p role="status">{message}</p>
    </div>
  );
}

export default function CaptureInbox({ onClose, onOpenNote }: Props) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const requestId = useRef(0);
  const [captures, setCaptures] = useState<CaptureSummary[]>([]);
  const [cursor, setCursor] = useState<string | null>(null);
  const [selected, setSelected] = useState<Capture | null>(null);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [connecting, setConnecting] = useState(false);
  const [loading, setLoading] = useState(true);
  const [loadingCapture, setLoadingCapture] = useState(false);
  const [error, setError] = useState("");

  useEffect(() => {
    const dialog = dialogRef.current;
    dialog?.showModal();
    let active = true;
    void listCaptures()
      .then((result) => {
        if (active) {
          setCaptures(result.captures);
          setCursor(result.nextCursor);
        }
      })
      .catch((error) => {
        if (active) setError(errorText(error));
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
      requestId.current++;
      dialog?.close();
    };
  }, []);
  async function refresh(loadMore = false) {
    setLoading(true);
    setError("");
    try {
      const result = await listCaptures(
        loadMore ? (cursor ?? undefined) : undefined,
      );
      setCaptures((current) =>
        loadMore
          ? [
              ...current,
              ...result.captures.filter(
                (capture) => !current.some((item) => item.id === capture.id),
              ),
            ]
          : result.captures,
      );
      setCursor(result.nextCursor);
    } catch (error) {
      setError(errorText(error));
    } finally {
      setLoading(false);
    }
  }
  async function selectCapture(id: string) {
    const sequence = ++requestId.current;
    setConnecting(false);
    setSelectedId(id);
    setSelected(null);
    setLoadingCapture(true);
    setError("");
    try {
      const result = await loadCapture(id);
      if (sequence === requestId.current) setSelected(result.capture);
    } catch (error) {
      if (sequence === requestId.current) setError(errorText(error));
    } finally {
      if (sequence === requestId.current) setLoadingCapture(false);
    }
  }
  return (
    <dialog
      ref={dialogRef}
      className="capture-inbox"
      aria-labelledby="capture-inbox-title"
      onCancel={onClose}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="capture-inbox-shell">
        <header className="capture-inbox-header">
          <div>
            <p className="eyebrow">Note Vault</p>
            <h2 id="capture-inbox-title">Cloud Inbox</h2>
          </div>
          <div className="capture-actions">
            <button
              className="thread-dialog-button"
              onClick={() => setConnecting((current) => !current)}
              aria-pressed={connecting}
              type="button"
            >
              Connect extension
            </button>
            <button
              className="search-modal-close"
              aria-label="Close Cloud Inbox"
              onClick={onClose}
              type="button"
            >
              ×
            </button>
          </div>
        </header>
        {error ? (
          <p className="capture-error" role="alert">
            {error}
          </p>
        ) : null}
        <div className="capture-inbox-body">
          <aside className="capture-list">
            <div className="capture-list-head">
              <span>Saved from the web</span>
              <button
                className="capture-refresh"
                onClick={() => void refresh()}
                disabled={loading}
                type="button"
              >
                {loading ? "Loading…" : "Refresh"}
              </button>
            </div>
            {!loading && !captures.length ? (
              <p className="capture-muted capture-list-empty">
                Your saved passages, articles, and bookmarks will appear here.
              </p>
            ) : null}
            {captures.map((capture) => (
              <button
                className={`capture-list-item${selectedId === capture.id && !connecting ? " is-active" : ""}`}
                onClick={() => void selectCapture(capture.id)}
                key={capture.id}
                type="button"
                aria-pressed={selectedId === capture.id && !connecting}
              >
                <span className="capture-kind">{capture.kind}</span>
                <strong>{capture.title}</strong>
                <span>
                  {new URL(capture.sourceUrl).hostname} ·{" "}
                  {new Date(capture.createdAt).toLocaleDateString()}
                </span>
              </button>
            ))}
            {cursor ? (
              <button
                className="thread-dialog-button capture-more"
                disabled={loading}
                onClick={() => void refresh(true)}
                type="button"
              >
                Load more
              </button>
            ) : null}
          </aside>
          <section
            className="capture-detail"
            aria-label={connecting ? "Extension connection" : "Capture preview"}
          >
            {connecting ? (
              <ExtensionConnection />
            ) : loadingCapture ? (
              <p role="status">Opening capture…</p>
            ) : selected ? (
              <>
                <div className="capture-detail-head">
                  <p className="eyebrow">
                    {selected.kind} ·{" "}
                    {new Date(selected.capturedAt).toLocaleDateString()}
                  </p>
                  <h3>{selected.title}</h3>
                  <a
                    href={selected.sourceUrl}
                    target="_blank"
                    rel="noopener noreferrer"
                  >
                    Visit original page ↗
                  </a>
                  <button
                    className="thread-dialog-button is-primary"
                    onClick={() => onOpenNote(selected)}
                    type="button"
                  >
                    Open as note
                  </button>
                </div>
                <p className="capture-muted">
                  An editable note opens in your workspace. The original capture
                  stays in your Inbox.
                </p>
                <div
                  className="capture-markdown"
                  dangerouslySetInnerHTML={{
                    __html: renderMarkdownToHtml(captureToMarkdown(selected)),
                  }}
                />
              </>
            ) : (
              <div className="capture-empty">
                <span aria-hidden="true" className="capture-empty-mark">
                  ↳
                </span>
                <h3>A home for what you find.</h3>
                <p>
                  Save a passage, an article, or a link from Chrome. Keep its
                  source close, add your thoughts, and open it as a note when
                  you’re ready.
                </p>
                <button
                  className="thread-dialog-button is-primary"
                  onClick={() => setConnecting(true)}
                  type="button"
                >
                  Connect the Chrome extension
                </button>
              </div>
            )}
          </section>
        </div>
      </div>
    </dialog>
  );
}
