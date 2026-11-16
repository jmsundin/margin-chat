import { useContext, useEffect, useId, useMemo, useRef, useState } from "react";
import { EditorState, type Extension } from "@codemirror/state";
import { EditorView, runScopeHandlers, keymap, lineNumbers, highlightActiveLine, highlightActiveLineGutter, drawSelection, placeholder as editorPlaceholder } from "@codemirror/view";
import { defaultKeymap, history, historyKeymap, indentWithTab } from "@codemirror/commands";
import { bracketMatching, indentOnInput, syntaxHighlighting } from "@codemirror/language";
import { closeBrackets, closeBracketsKeymap, insertBracket } from "@codemirror/autocomplete";
import { CODE_KEYS_ATTRIBUTE, codeWordInsert, listenForCodeKeys, type CodeKey } from "../lib/codeKeys";
import { classHighlighter } from "@lezer/highlight";
import { sql, SQLite } from "@codemirror/lang-sql";
import { python } from "@codemirror/lang-python";
import { javascript } from "@codemirror/lang-javascript";
import { java } from "@codemirror/lang-java";
import { html } from "@codemirror/lang-html";
import { css } from "@codemirror/lang-css";
import { CODE_LANGUAGE_LABELS, codeCellKind, previewDocument, previewPage, sqlSetup, type CodeLanguage } from "../lib/codeRunner/languages";
import { CodeCellScopeContext, RUN_ALL_CELLS_EVENT } from "../lib/codeRunner/codeCellScope";
import { runCode, type RunEvent, type RunResult } from "../lib/codeRunner/runner";
import { codeSuggestions } from "../lib/codeRunner/ghostText";
import { newlineKeepingIndent } from "../lib/codeRunner/keepIndent";
import { requestCodeSuggestion } from "../lib/api";
import { ApiError } from "../lib/apiError";
import { HTML_FRAME_SANDBOX, htmlFrameDocument, readHtmlFrameMessage } from "../lib/htmlDocuments";
import { loadHtmlStorage, saveHtmlStorage } from "../lib/htmlPageData";
import { getPlayContent, hasPlayContent, subscribePlayContent } from "../lib/playContent";
import "./CodeCell.css";

/**
 * A code block in a document as a small editor: SQL, Python, JavaScript,
 * TypeScript and Java run with ▶ Run (or ⌘/Ctrl+Enter) and show what they
 * print; HTML and CSS show the page they make, updating as you type. Edits
 * are saved back into the block's Markdown fence.
 */

const SAVE_DELAY_MS = 300;
const PREVIEW_DELAY_MS = 200;

/**
 * Turned off for the rest of the visit once the server says AI isn't
 * available to this person (signed out, a guest, or out of AI allowance),
 * so typing comments doesn't keep sending requests that will fail.
 */
let suggestionsOff = false;
function stopSuggestionsOn(error: unknown) {
  if (error instanceof ApiError && [401, 402, 403].includes(error.statusCode)) suggestionsOff = true;
}

function languageExtension(language: CodeLanguage): Extension {
  switch (language) {
    case "sql": return sql({ dialect: SQLite });
    case "python": return python();
    case "javascript": return javascript();
    case "typescript": return javascript({ typescript: true });
    case "java": return java();
    case "html": return html();
    case "css": return css();
  }
}

type OutputLine = { kind: "stdout" | "stderr"; text: string } | { kind: "table"; columns: string[]; rows: unknown[][]; note: string };

/** A tap on the key row above the phone keyboard, typed as if the hardware key had been pressed. */
function pressCodeKey(view: EditorView, key: CodeKey) {
  if (view.state.readOnly) return;
  if (key.kind === "tab") { runScopeHandlers(view, new KeyboardEvent("keydown", { key: "Tab", code: "Tab" }), "editor"); return; }
  const { head, empty } = view.state.selection.main;
  const word = key.text.length > 1;
  // Brackets and quotes close themselves, and step over a closing one already there, as they do when typed.
  const bracket = word ? null : insertBracket(view.state, key.text);
  if (bracket) { view.dispatch(bracket, { scrollIntoView: true }); return; }
  const text = word ? codeWordInsert(key.text, empty ? view.state.sliceDoc(Math.max(0, head - 1), head) : "") : key.text;
  view.dispatch(view.state.update(view.state.replaceSelection(text), { scrollIntoView: true, userEvent: "input.type" }));
}

interface CodeCellProps {
  language: CodeLanguage;
  source: string;
  /** This block's position among the code blocks of its piece of Markdown. */
  index: number;
  dark: boolean;
}

export default function CodeCell({ language, source, index, dark }: CodeCellProps) {
  const scope = useContext(CodeCellScopeContext);
  const editable = Boolean(scope?.save);
  const kind = codeCellKind(language);
  const host = useRef<HTMLDivElement>(null);
  const view = useRef<EditorView | null>(null);
  const [text, setText] = useState(source);
  /** The fence text this cell last saw saved, which a save checks the block still holds. */
  const saved = useRef(source);
  const pending = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [conflict, setConflictState] = useState(false);
  const conflictRef = useRef(false);
  const setConflict = (value: boolean) => { conflictRef.current = value; setConflictState(value); };
  const [output, setOutput] = useState<OutputLine[]>([]);
  const [status, setStatus] = useState("");
  const [result, setResult] = useState<RunResult | null>(null);
  const [running, setRunning] = useState(false);
  const abort = useRef<AbortController | null>(null);
  const latest = useRef({ scope, index, language, text, running: false, run: () => undefined as void });
  const labelId = useId();

  /** The code as its fence keeps it: trailing blank lines aren't stored, so an Enter at the end is not a change. */
  function stored(code: string) { return code.replace(/\n+$/u, ""); }

  function flush() {
    if (pending.current) { clearTimeout(pending.current); pending.current = null; }
    const current = latest.current;
    const next = stored(view.current?.state.doc.toString() ?? current.text);
    if (!current.scope?.save || next === stored(saved.current) || conflictRef.current) return;
    if (current.scope.save(current.index, saved.current, next)) saved.current = next;
    else setConflict(true);
  }

  // The editor, made once; its text follows the block when it changes elsewhere.
  useEffect(() => {
    if (!host.current) return;
    const editor = new EditorView({
      parent: host.current,
      state: EditorState.create({
        doc: source,
        extensions: [
          lineNumbers(), highlightActiveLineGutter(), highlightActiveLine(), drawSelection(), history(), indentOnInput(), bracketMatching(), closeBrackets(),
          syntaxHighlighting(classHighlighter), languageExtension(language),
          // Write a comment saying what you want; the AI's code for it shows faintly and goes in on Tab.
          ...(editable ? [codeSuggestions({
            language,
            enabled: () => !suggestionsOff && navigator.onLine !== false,
            request: (prompt, signal) => requestCodeSuggestion({ prompt, signal }),
            context: () => ({ cells: latest.current.scope?.cells ?? [], own: (latest.current.scope?.offset ?? 0) + latest.current.index }),
            onError: stopSuggestionsOn,
          })] : []),
          EditorState.tabSize.of(language === "python" || language === "java" ? 4 : 2),
          EditorState.readOnly.of(!editable), EditorView.editable.of(editable),
          editorPlaceholder(kind === "preview" ? `Write ${CODE_LANGUAGE_LABELS[language]} here` : `Write ${CODE_LANGUAGE_LABELS[language]} here, then Run`),
          EditorView.contentAttributes.of({ "aria-labelledby": labelId, spellcheck: "false", autocorrect: "off", autocapitalize: "off", ...(editable ? { [CODE_KEYS_ATTRIBUTE]: language } : {}) }),
          // On phones the key row sits on top of the keyboard, so the caret's line stays clear of it.
          EditorView.scrollMargins.of(() => matchMedia("(pointer: coarse)").matches ? { bottom: 100 } : null),
          keymap.of([
            { key: "Mod-Enter", run: () => { latest.current.run(); return true; } },
            { key: "Shift-Enter", run: () => { if (kind !== "run") return false; latest.current.run(); return true; } },
            { key: "Escape", run: (target) => { target.contentDOM.blur(); return true; } },
            { key: "Enter", run: newlineKeepingIndent },
            ...closeBracketsKeymap, ...defaultKeymap, ...historyKeymap, indentWithTab,
          ]),
          EditorView.updateListener.of((update) => {
            if (!update.docChanged) return;
            const next = update.state.doc.toString();
            setText(next);
            latest.current.text = next;
            if (!latest.current.scope?.save) return;
            if (pending.current) clearTimeout(pending.current);
            pending.current = setTimeout(flush, SAVE_DELAY_MS);
          }),
          EditorView.domEventHandlers({ blur: () => { flush(); } }),
        ],
      }),
    });
    view.current = editor;
    const stopKeys = listenForCodeKeys(editor.contentDOM, (key) => pressCodeKey(editor, key));
    return () => { stopKeys(); flush(); editor.destroy(); view.current = null; };
    // The editor is made once per cell; its text is updated below.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // A change made elsewhere (another device, the AI, undo in the document) replaces the editor's text when this cell has nothing unsaved.
  useEffect(() => {
    const editor = view.current;
    if (!editor || stored(source) === stored(saved.current)) return;
    const current = editor.state.doc.toString();
    if (pending.current || conflictRef.current) { if (stored(current) === stored(source)) { saved.current = source; setConflict(false); } return; }
    saved.current = source;
    if (stored(current) !== stored(source)) editor.dispatch({ changes: { from: 0, to: current.length, insert: source } });
  }, [source, conflict]);

  // Saves on the way out of the page too, so a closed tab never drops the last keystrokes.
  useEffect(() => {
    const onHide = () => flush();
    window.addEventListener("pagehide", onHide);
    return () => window.removeEventListener("pagehide", onHide);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => () => abort.current?.abort(), []);

  // Code mode's Run all: every cell of that document runs, in page order, each runtime queuing its own.
  useEffect(() => {
    function onRunAll(event: Event) {
      const documentId = (event as CustomEvent<{ documentId: string }>).detail?.documentId;
      const owner = host.current?.closest<HTMLElement>("[data-block-editor-conversation-id]")?.dataset.blockEditorConversationId;
      if (documentId && owner === documentId && !latest.current.running) latest.current.run();
    }
    window.addEventListener(RUN_ALL_CELLS_EVENT, onRunAll);
    return () => window.removeEventListener(RUN_ALL_CELLS_EVENT, onRunAll);
  }, []);

  async function run() {
    if (kind !== "run" || language === "html" || language === "css") return;
    if (running) { abort.current?.abort(); return; }
    flush();
    const code = view.current?.state.doc.toString() ?? text;
    const controller = new AbortController();
    abort.current = controller;
    setRunning(true);
    setOutput([]);
    setResult(null);
    setStatus("Starting…");
    const cells = scope?.cells ?? [];
    const setup = language === "sql" ? sqlSetup(cells, (scope?.offset ?? 0) + index) : [];
    const lines: OutputLine[] = [];
    let frame = 0;
    const show = () => { frame = 0; setOutput([...lines]); };
    const onEvent = (event: RunEvent) => {
      if (event.type === "status") { setStatus(event.text); return; }
      if (event.type === "table") lines.push({ kind: "table", columns: event.columns, rows: event.rows, note: event.note });
      else {
        const last = lines.at(-1);
        // Keep output to a sane size: a loop printing a million lines would otherwise freeze the page.
        if (lines.length > 2000) return;
        if (last && last.kind === event.stream && "text" in last && last.text.length < 20000) last.text += `\n${event.text}`;
        else lines.push({ kind: event.stream, text: event.text });
      }
      if (!frame) frame = requestAnimationFrame(show);
    };
    const outcome = await runCode(language, code, { setup, onEvent, signal: controller.signal });
    if (frame) cancelAnimationFrame(frame);
    setOutput([...lines]);
    if (abort.current === controller) abort.current = null;
    setRunning(false);
    setStatus("");
    setResult(outcome);
  }
  latest.current = { scope, index, language, text, running, run: () => { void run(); } };

  const page = useMemo(() => {
    if (kind !== "preview") return null;
    const own = (scope?.offset ?? 0) + index;
    const cells = [...(scope?.cells ?? [])];
    // This cell's own text is what's in its editor, which may be ahead of what's saved.
    cells[own] = { language, source: text };
    for (let at = 0; at < own; at += 1) cells[at] ??= { language: "css", source: "" };
    const found = previewPage(cells, own);
    // CSS right under its HTML (with only CSS between) shows in that HTML's preview instead of a second copy.
    const attached = language === "css" && found.htmlIndex !== null && cells.slice(found.htmlIndex + 1, own).every((cell) => cell.language === "css");
    return { ...found, attached };
  }, [kind, scope, index, text, language]);

  const empty = !output.length && !result && !running;
  return <div className={`code-cell is-${language}${dark ? " is-dark" : ""}`} data-code-cell={language}
    onMouseDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}>
    <div className="code-cell-head">
      <span className="code-cell-language" id={labelId}>{CODE_LANGUAGE_LABELS[language]}</span>
      {!editable && <span className="code-cell-note">Read only</span>}
      <span className="code-cell-spacer" />
      {kind === "run" && <>
        {!empty && !running && <button type="button" className="code-cell-button is-quiet" onClick={() => { setOutput([]); setResult(null); }}>Clear</button>}
        <button type="button" className={`code-cell-button${running ? " is-stop" : " is-run"}`} onClick={() => void run()} title={running ? "Stop" : "Run (⌘/Ctrl+Enter)"}>
          {running ? "■ Stop" : "▶ Run"}
        </button>
      </>}
    </div>
    <div className="code-cell-editor" ref={host} />
    {conflict && <div className="code-cell-conflict" role="alert">
      This code changed somewhere else, so your edit here wasn't saved.
      <button type="button" className="code-cell-button is-quiet" onClick={() => void navigator.clipboard?.writeText(view.current?.state.doc.toString() ?? text)}>Copy my version</button>
      <button type="button" className="code-cell-button is-quiet" onClick={() => {
        if (pending.current) { clearTimeout(pending.current); pending.current = null; }
        const editor = view.current;
        if (editor) editor.dispatch({ changes: { from: 0, to: editor.state.doc.length, insert: source } });
        saved.current = source;
        setConflict(false);
      }}>Use the saved version</button>
    </div>}
    {kind === "run" && !empty && <div className="code-cell-output" aria-live="polite">
      {running && status && <div className="code-cell-status">{status}</div>}
      {output.map((line, at) => line.kind === "table"
        ? <div className="code-cell-table" key={at}>
            <div className="code-cell-table-scroll"><table>
              <thead><tr>{line.columns.map((column, col) => <th key={col}>{column}</th>)}</tr></thead>
              <tbody>{line.rows.map((row, r) => <tr key={r}>{row.map((value, col) => <td key={col} className={value === null ? "is-null" : undefined}>{value === null ? "NULL" : value instanceof Uint8Array ? `<${value.length} bytes>` : String(value)}</td>)}</tr>)}</tbody>
            </table></div>
            <div className="code-cell-table-note">{line.note}</div>
          </div>
        : <pre key={at} className={`code-cell-stream is-${line.kind}`}>{line.text}</pre>)}
      {result?.error && <pre className="code-cell-error">{result.error}</pre>}
      {result && !running && <div className="code-cell-result">
        {result.stopped ? "Stopped." : result.ok ? `${output.length ? "Done" : "Done, nothing printed"} in ${formatMs(result.ms)}.` : `Failed after ${formatMs(result.ms)}.`}
      </div>}
    </div>}
    {page && (page.attached
      ? <div className="code-cell-hint">These styles show in the HTML preview above.</div>
      : <CodePreview html={page.html} css={page.css} dark={dark} sample={page.htmlIndex === null} documentId={scope?.documentId} />)}
  </div>;
}

function formatMs(ms: number) {
  return ms < 1000 ? `${Math.max(1, Math.round(ms))} ms` : `${(ms / 1000).toFixed(1)} s`;
}

/** Reports the page's height so the frame grows with it; the frame has no origin, so the parent can't measure it. */
const SIZE_SCRIPT = `<script>(function(){var last=0;function send(){var h=Math.ceil(document.documentElement.scrollHeight);if(h!==last){last=h;parent.postMessage({codePreviewHeight:h},"*");}}addEventListener("load",send);new ResizeObserver(send).observe(document.documentElement);setInterval(send,1000);})();<\/script>`;

/** A page with scripts of its own is a small game or tool, not only markup to look at. */
const RUNS_SCRIPTS = /<script[\s>]/iu;
const MAX_PREVIEW_HEIGHT = 560;
const MAX_PLAY_HEIGHT = 900;

function CodePreview({ html, css, dark, sample, documentId }: { html: string; css: string[]; dark: boolean; sample: boolean; documentId?: string }) {
  const frame = useRef<HTMLIFrameElement>(null);
  // In a document, a page that runs scripts gets what a played HTML page gets: storage that lasts and the note's questions.
  const plays = Boolean(documentId) && !sample && RUNS_SCRIPTS.test(html);
  const build = () => plays
    ? htmlFrameDocument(previewDocument(html, css, dark), loadHtmlStorage(documentId!)?.data ?? {})
    : previewDocument(html, css, dark) + SIZE_SCRIPT;
  const [doc, setDoc] = useState(build);
  const [height, setHeight] = useState(160);
  useEffect(() => {
    const timer = setTimeout(() => setDoc(build()), PREVIEW_DELAY_MS);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [html, css, dark, plays, documentId]);
  useEffect(() => {
    const sendContent = () => {
      if (!documentId || !plays || !hasPlayContent(documentId)) return;
      const { questions, decks } = getPlayContent(documentId);
      frame.current?.contentWindow?.postMessage({ marginHtml: 1, type: "content", questions, decks }, "*");
    };
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const value = (event.data as { codePreviewHeight?: unknown })?.codePreviewHeight;
      if (typeof value === "number" && Number.isFinite(value)) { setHeight(Math.min(MAX_PREVIEW_HEIGHT, Math.max(60, value))); return; }
      if (!plays || !documentId) return;
      const message = readHtmlFrameMessage(event.data);
      if (message?.type === "size") setHeight(Math.min(MAX_PLAY_HEIGHT, Math.max(60, Math.ceil(message.height))));
      else if (message?.type === "storage") saveHtmlStorage(documentId, { savedAt: Date.now(), data: message.data });
      else if (message?.type === "content-request") sendContent();
    };
    window.addEventListener("message", onMessage);
    const unsubscribe = documentId && plays ? subscribePlayContent(documentId, sendContent) : undefined;
    return () => { window.removeEventListener("message", onMessage); unsubscribe?.(); };
  }, [documentId, plays]);
  return <div className="code-cell-preview">
    <div className="code-cell-preview-label">{sample ? "Preview on a sample page" : "Preview"}</div>
    <iframe ref={frame} title="HTML preview" sandbox={plays ? HTML_FRAME_SANDBOX : "allow-scripts"} srcDoc={doc} style={{ height }} />
  </div>;
}
