import { useEffect, useMemo, useRef, useState } from "react";
import { readChatGPTHistory, type HistoryChat, type HistoryImportReceipt, type HistoryPreview } from "../lib/chatHistoryImport";
import "./ChatHistoryImport.css";

interface Props {
  existingIds: string[];
  cloudSyncEnabled: boolean;
  onImport: (chats: HistoryChat[]) => Promise<HistoryImportReceipt>;
  onUndo: (receipt: HistoryImportReceipt) => Promise<{ removed: number; kept: number }>;
  onOpenChat: (id: string) => void;
  onClose: () => void;
}

export default function ChatHistoryImport({ existingIds, cloudSyncEnabled, onImport, onUndo, onOpenChat, onClose }: Props) {
  const dialog = useRef<HTMLDialogElement>(null);
  const input = useRef<HTMLInputElement>(null);
  const alive = useRef(true);
  const busyRef = useRef(false);
  const [busy, setBusy] = useState<"reading" | "importing" | "undoing" | null>(null);
  const [preview, setPreview] = useState<HistoryPreview | null>(null);
  const [selected, setSelected] = useState(new Set<string>());
  const [query, setQuery] = useState("");
  const [page, setPage] = useState(0);
  const [previewId, setPreviewId] = useState<string | null>(null);
  const [receipt, setReceipt] = useState<HistoryImportReceipt | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const existing = useMemo(() => new Set(existingIds), [existingIds]);
  const filtered = useMemo(() => (preview?.chats ?? []).filter((chat) => chat.title.toLocaleLowerCase().includes(query.toLocaleLowerCase())), [preview, query]);
  const chosen = (preview?.chats ?? []).filter((chat) => selected.has(chat.id) && !existing.has(chat.id));
  const shown = preview?.chats.find((chat) => chat.id === previewId);
  const warnings = [...new Set([...(preview?.warnings ?? []), ...chosen.flatMap((chat) => chat.warnings)])];

  useEffect(() => {
    alive.current = true;
    const previous = document.activeElement as HTMLElement | null;
    dialog.current?.showModal();
    return () => { alive.current = false; dialog.current?.close(); previous?.focus(); };
  }, []);

  async function run(kind: NonNullable<typeof busy>, operation: () => Promise<void>) {
    if (busyRef.current) return;
    busyRef.current = true; setBusy(kind); setError(null);
    try { await operation(); }
    catch (failure) { if (alive.current) setError(failure instanceof Error ? failure.message : "Your history could not be imported. Try again."); }
    finally { busyRef.current = false; if (alive.current) setBusy(null); }
  }

  function read(files: File[]) {
    if (!files.length) return;
    void run("reading", async () => {
      setPreview(null); setReceipt(null); setNotice(null); setSelected(new Set()); setPreviewId(null);
      const result = await readChatGPTHistory(files);
      if (!alive.current) return;
      setPreview(result); setQuery(""); setPage(0);
      setSelected(new Set(result.chats.filter((chat) => !existing.has(chat.id)).map((chat) => chat.id)));
    });
  }

  return <dialog ref={dialog} className="history-import-dialog" aria-labelledby="history-import-title"
    onClick={(event) => {
      if (event.target !== event.currentTarget) return;
      const bounds = event.currentTarget.getBoundingClientRect();
      if (event.clientX < bounds.left || event.clientX > bounds.right || event.clientY < bounds.top || event.clientY > bounds.bottom) onClose();
    }}
    onCancel={(event) => { event.preventDefault(); if (!busyRef.current) onClose(); }}>
    <header className="history-import-head">
      <div><p className="eyebrow">Start with familiar conversations</p><h2 id="history-import-title">Bring your chat history</h2></div>
      <button type="button" className="thread-dialog-button" disabled={!!busy} onClick={onClose} aria-label="Close history import">Close</button>
    </header>
    <div className="history-import-body" aria-busy={!!busy}>
      {receipt ? <section aria-label="Import complete">
        <h3>{notice ? "Import undone" : `${receipt.conversationIds.length} ${receipt.conversationIds.length === 1 ? "chat" : "chats"} imported`}</h3>
        <p role="status">{notice ?? `Saved on this device. ${cloudSyncEnabled ? "Cloud sync will follow your usual settings." : "Download your vault to keep an independent backup."}`}</p>
        {!!receipt.skipped && <p>{receipt.skipped} already imported {receipt.skipped === 1 ? "chat was" : "chats were"} skipped.</p>}
        {!notice && <p>You can search, annotate, branch, and continue these chats with your chosen Margin Chat model.</p>}
        <div className="history-import-actions">
          {receipt.conversationIds[0] && <button type="button" className="thread-dialog-button is-primary" disabled={!!busy}
            onClick={() => { onOpenChat(receipt.conversationIds[0]); onClose(); }}>Open imported chat</button>}
          {!!Object.keys(receipt.files).length && <button type="button" className="thread-dialog-button" disabled={!!busy} onClick={() => void run("undoing", async () => {
            const result = await onUndo(receipt);
            if (!alive.current) return;
            setNotice(`Removed ${result.removed} imported chats. ${result.kept ? `${result.kept} changed or connected chats were kept.` : "Your other chats are unchanged."}`);
            setReceipt({ files: {}, conversationIds: [], skipped: 0 });
          })}>{busy === "undoing" ? "Undoing…" : "Undo this import"}</button>}
        </div>
        {!notice && <p className="history-import-muted">Undo is available here until you close this window. Chats edited, moved, pinned, grouped, or connected since import are kept.</p>}
      </section> : <>
        <p>Import conversations from a ChatGPT export. Preview and choose what to bring with you.</p>
        <details><summary>How to export from ChatGPT</summary>
          <p>In ChatGPT, open Settings → Data controls → Export data. Download the export when it is ready, then choose the ZIP below. You can also select conversations.json or several numbered conversation JSON files.</p>
          <a href="https://help.openai.com/en/articles/7260999-how-do-i-export-my-chatgpt-history-and-data" target="_blank" rel="noreferrer">Open ChatGPT export instructions</a>
        </details>
        <div className="history-import-drop" onDragOver={(event) => event.preventDefault()} onDrop={(event) => {
          event.preventDefault(); if (!busyRef.current) read(Array.from(event.dataTransfer.files));
        }}>
          <button type="button" className="thread-dialog-button is-primary" disabled={!!busy} onClick={() => input.current?.click()}>
            {busy === "reading" ? "Reading your export…" : preview ? "Choose another export" : "Choose ChatGPT export"}
          </button>
          <span>or drop a ZIP or conversation JSON files here</span>
          <input ref={input} type="file" hidden multiple accept=".zip,.json,application/zip,application/json" disabled={!!busy}
            onChange={(event) => { read(Array.from(event.currentTarget.files ?? [])); event.currentTarget.value = ""; }} />
        </div>
        <p className="history-import-muted">Preview stays in your browser. Only selected chats are saved. Attachments, account settings, memories, and subscriptions aren’t imported. Replies use your Margin Chat model and billing settings.</p>
        {preview && <>
          <div className="history-import-tools">
            <label>Find a conversation<input type="search" value={query} disabled={!!busy} onChange={(event) => { setQuery(event.target.value); setPage(0); }} /></label>
            <button type="button" className="thread-dialog-button" disabled={!!busy} onClick={() => setSelected(new Set(filtered.filter((chat) => !existing.has(chat.id)).map((chat) => chat.id)))}>Select matching chats</button>
            <button type="button" className="thread-dialog-button" disabled={!!busy} onClick={() => setSelected(new Set())}>Clear selection</button>
          </div>
          <p role="status">{chosen.length} selected · {preview.chats.length} found · {preview.chats.filter((chat) => existing.has(chat.id)).length} already here</p>
          <div className="history-import-list" aria-label="Conversations to import">
            {filtered.slice(page * 50, (page + 1) * 50).map((chat) => <div key={chat.id} className="history-import-row">
              <label><input type="checkbox" checked={selected.has(chat.id) && !existing.has(chat.id)} disabled={!!busy || existing.has(chat.id)}
                onChange={(event) => { const checked = event.target.checked; setSelected((current) => { const next = new Set(current); if (checked) next.add(chat.id); else next.delete(chat.id); return next; }); }} />
                <span><strong>{chat.title}</strong><small>{chat.messages.length} messages · {chat.updatedAt.startsWith("1970-") ? "Date unavailable" : new Date(chat.updatedAt).toLocaleDateString()}{existing.has(chat.id) ? " · Already here" : ""}</small></span>
              </label>
              <button type="button" className="thread-dialog-button" aria-label={`Preview ${chat.title}`} aria-expanded={previewId === chat.id}
                onClick={() => setPreviewId(previewId === chat.id ? null : chat.id)}>Preview</button>
            </div>)}
            {!filtered.length && <p>No matching conversations.</p>}
          </div>
          {filtered.length > 50 && <div className="history-import-actions">
            <button type="button" className="thread-dialog-button" disabled={page === 0} onClick={() => setPage(page - 1)}>Previous</button>
            <span>Page {page + 1} of {Math.ceil(filtered.length / 50)}</span>
            <button type="button" className="thread-dialog-button" disabled={(page + 1) * 50 >= filtered.length} onClick={() => setPage(page + 1)}>Next</button>
          </div>}
          {shown && <section className="history-import-preview" aria-label={`Conversation preview: ${shown.title}`}>
            <h3>{shown.title}</h3>
            {shown.warnings.map((warning) => <p key={warning}>{warning}</p>)}
            {shown.messages.slice(0, 20).map((message) => <div key={message.id}><strong>{message.role === "user" ? "You" : "ChatGPT"}</strong><pre>{message.content.slice(0, 6000)}</pre></div>)}
            <p className="history-import-muted">Preview shows up to 20 messages and 6,000 characters per message. Import keeps the full text.</p>
          </section>}
          {!!warnings.length && <ul className="history-import-warnings">{warnings.map((warning) => <li key={warning}>{warning}</li>)}</ul>}
        </>}
      </>}
      {error && <p role="alert" className="profile-dialog-error">{error}</p>}
    </div>
    <footer className="history-import-actions">
      {!receipt && <button type="button" className="thread-dialog-button is-primary" disabled={!!busy || !chosen.length} onClick={() => void run("importing", async () => {
        const result = await onImport(chosen);
        if (alive.current) setReceipt(result);
      })}>{busy === "importing" ? "Saving your chats…" : `Import ${chosen.length || "selected"} ${chosen.length === 1 ? "chat" : "chats"}`}</button>}
      <button type="button" className="thread-dialog-button" disabled={!!busy} onClick={onClose}>{receipt ? "Done" : "Cancel"}</button>
    </footer>
  </dialog>;
}
