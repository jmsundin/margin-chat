import { useCallback, useEffect, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { CAPTURE_LIMITS, normalizeCapture, type Capture, type CaptureKind } from "@margin-chat/capture-contracts";
import App from "../../client/src/App";
import { setApiTransport } from "../../client/src/lib/apiTransport";
import { getSettings, trustedStorage, type ConnectionSettings } from "./storage";
import { createWorkspaceFetch } from "./workspace-transport";
import { signOut } from "./network";
import type { OverlayDraft, OverlayState, TextQuoteAnchor } from "./overlay-types";
import "../../client/src/styles.css";
import "katex/dist/katex.min.css";
import "../../client/src/components/MathEquation.css";
import "./workspace.css";

interface PageContext {
  title: string; sourceUrl: string; kind: CaptureKind; content: string;
  anchor?: TextQuoteAnchor; selectionText?: string; revision?: number;
}
interface ImportRequest { id: string; capture: Capture; prompt?: string }
const params = new URLSearchParams(location.search);
const tabId = Number(params.get("tab"));
const session = params.get("session") ?? "";
const describe = (error: unknown) => error instanceof Error ? error.message : "Margin could not complete that action.";

function BrowserWorkspace() {
  const [connection, setConnection] = useState<ConnectionSettings | null>(null);
  const connectionRef = useRef<ConnectionSettings | null>(null);
  const [checking, setChecking] = useState(true);
  const [connectedFrame, setConnectedFrame] = useState(false);
  const [captureOnly, setCaptureOnly] = useState(false);
  const [error, setError] = useState("");
  const [notice, setNotice] = useState("");
  const [context, setContext] = useState<PageContext | null>(null);
  const contextRef = useRef<PageContext | null>(null);
  const [pageState, setPageState] = useState<OverlayState | null>(null);
  const [detailsOpen, setDetailsOpen] = useState(false);
  const [communityOpen, setCommunityOpen] = useState(false);
  const [mode, setMode] = useState<"note" | "ask">("note");
  const [thought, setThought] = useState("");
  const [question, setQuestion] = useState("");
  const [busy, setBusy] = useState(false);
  const [captureRequest, setCaptureRequest] = useState<ImportRequest | null>(null);
  const controller = useRef<AbortController | null>(null);
  const bootSequence = useRef(0);
  const pageSequence = useRef(0);
  const saveSequence = useRef(0);
  const persistedDraft = useRef("");
  const draftQueue = useRef(Promise.resolve());

  const message = useCallback(async (type: string, body: Record<string, unknown> = {}) => {
    const result = await chrome.runtime.sendMessage({ type: `workspace:${type}`, tabId, session, connectionId: connectionRef.current?.connectionId, sourceUrl: contextRef.current?.sourceUrl, ...body });
    if (!result || result.error) throw new Error(result?.error || "Reopen Margin from the extension toolbar to reconnect this page.");
    return result;
  }, []);

  const applyPage = useCallback(async (next: PageContext, restore: boolean) => {
    const sequence = ++pageSequence.current;
    const previousUrl = contextRef.current?.sourceUrl;
    if (previousUrl !== next.sourceUrl) {
      setPageState(null); setThought(""); setQuestion(""); setNotice("");
    }
    contextRef.current = next;
    setContext(next);
    const state = await message("state") as OverlayState;
    if (sequence !== pageSequence.current || next.sourceUrl !== contextRef.current?.sourceUrl) return;
    setPageState(state);
    if (restore) {
      const saved = state.page.draft;
      setThought(saved?.comment ?? ""); setQuestion(saved?.question ?? "");
      setMode(saved?.mode === "ask" ? "ask" : "note");
      if (saved && !(next.kind === "selection" && next.content)) {
        const restored = { ...next, title: saved.title, kind: saved.kind, content: saved.content, anchor: saved.anchor };
        contextRef.current = restored; setContext(restored);
      }
    }
    await message("highlights", { anchors: state.page.annotations.flatMap((item) => item.anchor ? [item.anchor] : []) });
  }, [message]);

  useEffect(() => {
    let disposed = false;
    async function boot() {
      const sequence = ++bootSequence.current;
      pageSequence.current++; saveSequence.current++;
      controller.current?.abort(); controller.current = new AbortController();
      setChecking(true); setError(""); setConnection(null); connectionRef.current = null;
      setCaptureOnly(false);
      setCaptureRequest(null); setPageState(null); setThought(""); setQuestion("");
      setBusy(false); setNotice(""); setDetailsOpen(false); setCommunityOpen(false); setMode("note");
      contextRef.current = null; setContext(null); setApiTransport(null);
      try {
        if (!Number.isInteger(tabId) || tabId < 0 || !session) throw new Error("Open Margin Chat from its toolbar button on a web page.");
        const frame = await message("connect");
        if (disposed || sequence !== bootSequence.current) return;
        setConnectedFrame(true);
        await trustedStorage();
        const settings = await getSettings();
        if (disposed || sequence !== bootSequence.current) return;
        if (!settings || settings.connectionId !== frame.connection?.connectionId || !settings.token.startsWith("mc_workspace_")) {
          setCaptureOnly(!!settings && settings.connectionId === frame.connection?.connectionId);
          setError(settings ? "This connection can save captures. Sign in with Workspace + AI access to use your current Margin Chat workspace here." : "Connect your Margin Chat account to open your workspace above this page.");
          return;
        }
        connectionRef.current = settings;
        setApiTransport({ serverUrl: settings.serverUrl, fetch: createWorkspaceFetch({ connection: settings, getSettings, fetch: window.fetch.bind(window), signal: controller.current!.signal }) });
        setConnection(settings);
        const current = await message("context", { kind: "current" }) as PageContext;
        if (disposed || sequence !== bootSequence.current) return;
        await applyPage(current, true);
      } catch (failure) { if (!disposed && sequence === bootSequence.current) setError(describe(failure)); }
      finally { if (!disposed && sequence === bootSequence.current) setChecking(false); }
    }
    void boot();
    const changed = (changes: Record<string, chrome.storage.StorageChange>, area: string) => {
      if (area === "local" && changes.connection) void boot();
    };
    chrome.storage.onChanged.addListener(changed);
    return () => { disposed = true; bootSequence.current++; controller.current?.abort(); setApiTransport(null); chrome.storage.onChanged.removeListener(changed); };
  }, [message, applyPage]);

  useEffect(() => {
    if (!connection) return;
    let pending = false;
    let disposed = false;
    const timer = setInterval(async () => {
      if (pending || busy) return;
      pending = true;
      try {
        const next = await message("context", { kind: "current" }) as PageContext;
        if (disposed) return;
        const current = contextRef.current;
        if (next.sourceUrl !== current?.sourceUrl || next.revision !== current?.revision) {
          const changedPage = next.sourceUrl !== current?.sourceUrl;
          await applyPage(next, changedPage);
          if (!changedPage && next.kind === "selection") setDetailsOpen(true);
        }
      } catch (failure) { if (!disposed) setError(describe(failure)); }
      finally { pending = false; }
    }, 1000);
    return () => { disposed = true; clearInterval(timer); };
  }, [connection, message, applyPage, busy]);

  useEffect(() => {
    if (!connection || !context || checking || busy) return;
    const draft: OverlayDraft = { title: context.title, kind: context.kind, content: context.content, comment: thought, question, mode: mode === "ask" ? "ask" : "annotate", ...(context.anchor ? { anchor: context.anchor } : {}) };
    const serialized = JSON.stringify([connection.connectionId, context.sourceUrl, draft]);
    if (serialized === persistedDraft.current) return;
    const sourceUrl = context.sourceUrl;
    const connectionId = connection.connectionId;
    const timer = setTimeout(() => {
      draftQueue.current = draftQueue.current.catch(() => {}).then(async () => {
        if (contextRef.current?.sourceUrl !== sourceUrl || connectionRef.current?.connectionId !== connectionId) return;
        await message("draft", { draft, connectionId, sourceUrl });
        persistedDraft.current = serialized;
      }).catch((failure) => {
        if (contextRef.current?.sourceUrl === sourceUrl && connectionRef.current?.connectionId === connectionId) setError(`Draft not saved: ${describe(failure)}`);
      });
    }, 250);
    return () => clearTimeout(timer);
  }, [context, connection, thought, question, mode, checking, busy, message]);

  async function read(kind: CaptureKind) {
    const sequence = bootSequence.current;
    const sourceUrl = contextRef.current?.sourceUrl;
    setError("");
    try {
      const next = await message("context", { kind }) as PageContext;
      if (sequence !== bootSequence.current || contextRef.current?.sourceUrl !== sourceUrl || next.sourceUrl !== sourceUrl) return;
      contextRef.current = next; setContext(next); setDetailsOpen(true);
    } catch (failure) { if (sequence === bootSequence.current && contextRef.current?.sourceUrl === sourceUrl) setError(describe(failure)); }
  }

  function askPage() {
    setMode("ask"); setDetailsOpen(true);
    if (contextRef.current?.kind === "bookmark") void read("article");
  }

  async function save(retry = false) {
    const current = contextRef.current;
    if (!current || !connection || busy || (mode === "ask" && !question.trim() && !retry)) return;
    const sourceUrl = current.sourceUrl;
    const account = connection.connectionId;
    const sequence = ++saveSequence.current;
    const stillCurrent = () => sequence === saveSequence.current && contextRef.current?.sourceUrl === sourceUrl && connectionRef.current?.connectionId === account;
    const intent = mode;
    const prompt = question.trim();
    setBusy(true); setError(""); setNotice("Saving source…");
    try {
      await draftQueue.current;
      if (!stillCurrent()) return;
      const latest = await message("context", { kind: "current" }) as PageContext;
      if (latest.sourceUrl !== sourceUrl || connectionRef.current?.connectionId !== account) throw new Error("The page or account changed. Review the current source before saving.");
      const capture = retry ? pageState?.pending?.capture : normalizeCapture({
        schemaVersion: 1, clientCaptureId: crypto.randomUUID(), kind: current.kind,
        title: current.title, sourceUrl, content: current.content, comment: intent === "ask" ? prompt : thought,
        capturedAt: new Date().toISOString(),
      });
      if (!capture) throw new Error("There is no pending capture to retry.");
      const result = await message(retry ? "retry" : "save", retry ? {} : { capture, annotation: current.anchor ? { anchor: current.anchor } : {} });
      if (!result.receipt?.id || !result.receipt.createdAt) throw new Error("The server did not confirm this capture. Retry its pending save.");
      if (!stillCurrent()) return;
      const saved: Capture = { ...capture, id: result.receipt.id, createdAt: result.receipt.createdAt };
      setCaptureRequest({ id: crypto.randomUUID(), capture: saved, ...(intent === "ask" ? { prompt: retry ? capture.comment : prompt } : {}) });
      await message("draft", { draft: null, sourceUrl, connectionId: account });
      if (!stillCurrent()) return;
      setThought(""); setQuestion(""); setDetailsOpen(false);
      await applyPage(current, false);
      if (!stillCurrent()) return;
      setNotice(intent === "ask" ? "Source saved. Opening a linked AI conversation in your workspace…" : "Source saved and opened as a workspace document.");
    } catch (failure) {
      if (!stillCurrent()) return;
      setNotice(""); setError(describe(failure));
      try { const pending = await message("state"); if (stillCurrent()) setPageState(pending); } catch { /* Preserve the original error. */ }
    } finally { if (sequence === saveSequence.current) setBusy(false); }
  }

  async function logout() {
    const previous = connectionRef.current;
    controller.current?.abort();
    await chrome.storage.local.remove("connection");
    if (previous) await signOut(previous).catch(() => undefined);
  }
  const openExternal = (url: string) => { void chrome.tabs.create({ url }); };
  const onHandled = (id: string) => { setCaptureRequest((current) => current?.id === id ? null : current); setNotice(""); };
  const settings = () => { void chrome.runtime.openOptionsPage(); };

  if (checking) return <div className="extension-connect" role="status">Opening your Margin Chat workspace…</div>;
  if (!connection) return <div className="extension-connect"><p className="eyebrow">Margin Chat</p><h1>Your workspace, above the page.</h1><p>{error}</p>{connectedFrame && <button className="primary-button" onClick={settings}>Connect Workspace + AI</button>}{captureOnly && <p><button onClick={() => void message("pending").catch((failure) => setError(describe(failure)))}>Open capture-only clipper</button></p>}</div>;
  return <div className="browser-workspace">
    <section className="browser-source" aria-label="Web page context">
      <div className="browser-source-row"><div className="browser-source-name"><strong>{context?.title || "Current page"}</strong><small>{context?.sourceUrl}</small></div><button aria-expanded={detailsOpen} onClick={() => setDetailsOpen(!detailsOpen)}>Page context</button><button onClick={askPage}>Ask page</button><button onClick={() => setCommunityOpen(!communityOpen)} aria-expanded={communityOpen}>Community</button></div>
      {communityOpen && <div className="browser-community"><strong>Community is coming later.</strong><p>Page and passage discussions will appear here when connected. Your documents, annotations, and AI conversations remain private.</p></div>}
      {detailsOpen && <div className="browser-source-details">
        <div className="browser-context-actions" role="group" aria-label="Choose source context"><button onClick={() => void read("selection")} disabled={busy} aria-pressed={context?.kind === "selection"}>Selected passage</button><button onClick={() => void read("article")} disabled={busy} aria-pressed={context?.kind === "article"}>Readable page</button><button onClick={() => void read("bookmark")} disabled={busy} aria-pressed={context?.kind === "bookmark"}>Link only</button></div>
        {context?.kind === "bookmark" ? <p className="browser-source-hint">Only the page title and link are included. Choose Readable page or select a passage to give AI its content.</p> : <textarea className="browser-source-preview" aria-label="Source content preview" readOnly value={context?.content ?? ""} />}
        <div className="browser-context-actions"><button onClick={() => setMode("note")} aria-pressed={mode === "note"}>Annotate / save</button><button onClick={() => setMode("ask")} aria-pressed={mode === "ask"}>Ask AI</button></div>
        <form onSubmit={(event) => { event.preventDefault(); void save(); }}><label htmlFor="source-thought">{mode === "ask" ? "Question for AI" : "Your thought (optional)"}</label><textarea id="source-thought" maxLength={CAPTURE_LIMITS.comment} value={mode === "ask" ? question : thought} onChange={(event) => mode === "ask" ? setQuestion(event.target.value) : setThought(event.target.value)} required={mode === "ask"} disabled={busy} placeholder={mode === "ask" ? "What would you like to explore about this source?" : "What stands out to you?"} /><button className="primary-button" disabled={busy || !context || !!pageState?.hasOtherPending || !!(pageState?.pending && !pageState.pending.receipt)}>{busy ? "Saving…" : mode === "ask" ? "Save source & ask AI" : "Save & open document"}</button></form>
        {!!pageState?.page.annotations.length && <details><summary>Saved on this page · {pageState.page.annotations.length}</summary>{pageState.page.annotations.map((annotation) => <div className="browser-annotation" key={annotation.id}><blockquote>{annotation.anchor?.exact || annotation.excerpt || annotation.title}</blockquote><p>{annotation.comment}</p>{annotation.anchor && <button onClick={() => void message("locate", { anchor: annotation.anchor }).then((result) => { if (!result.located) setError("This passage has changed. Its saved source is still in your workspace."); }).catch((failure) => setError(describe(failure)))}>Find on page</button>}</div>)}</details>}
      </div>}
      {pageState?.hasOtherPending && <div className="browser-notice">Another page has a pending capture. <button onClick={() => void message("pending").catch((failure) => setError(describe(failure)))}>Review pending capture</button></div>}
      {pageState?.pending && !pageState.pending.receipt && <div className="browser-notice">Your previous capture is kept for retry. <button disabled={busy} onClick={() => void save(true)}>Retry save</button><button disabled={busy} onClick={() => void message("dismiss").then(() => message("state")).then(setPageState).catch((failure) => setError(describe(failure)))}>Dismiss</button></div>}
      {(error || notice) && <p className={`browser-notice${error ? " is-error" : ""}`} role="status">{error || notice}</p>}
    </section>
    <div className="browser-current-app"><App key={connection.connectionId} extension={{ serverUrl: connection.serverUrl, userId: connection.userId, onConnect: settings, onLogout: logout, openExternal }} browserCaptureRequest={captureRequest ?? undefined} onBrowserCaptureHandled={onHandled} /></div>
  </div>;
}

createRoot(document.getElementById("root")!).render(<BrowserWorkspace />);
