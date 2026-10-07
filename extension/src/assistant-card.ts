import { readChatReplyStream } from "../../client/src/lib/chatStream";
import { renderMarkdownLite } from "./markdown-lite";
import {
  ASK_SUGGESTIONS, buildPageAIMessage, EXPLAIN_PROMPT, PAGE_AI_LIMITS, threadTitle, truncateExcerpt,
  type PageThread, type PageThreadIntent,
} from "./page-ai";
import type { ConnectionSettings } from "./storage";
import type { TextQuoteAnchor } from "./overlay-types";

export interface CardDeps {
  params: URLSearchParams;
  /** Sends one `assistant:*` message. The card adds the tab, session, and account. */
  sendMessage(message: Record<string, unknown>): Promise<any>;
  getSettings(): Promise<ConnectionSettings | null>;
  /** An authenticated fetch bound to the signed-in account's server. */
  createFetch(settings: ConnectionSettings): typeof fetch;
  openSettings(): void;
}

type PageRequest = { quote: string; anchor?: TextQuoteAnchor; title: string; sourceUrl: string; intent: PageThreadIntent };
const WORKSPACE_TOKEN = /^mc_workspace_[A-Za-z0-9_-]{43}$/u;

/** The extension-origin answer card: prompt box, streamed answer, and what to do with it. */
export function createAssistantCard(doc: Document, deps: CardDeps) {
  const win = doc.defaultView!;
  const el = <T extends HTMLElement = HTMLElement>(id: string) => doc.getElementById(id) as T;
  const tab = Number(deps.params.get("tab"));
  const session = deps.params.get("session") ?? "";
  let connectionId = "";
  let settings: ConnectionSettings | null = null;
  let page: PageRequest | null = null;
  let thread: PageThread | null = null;
  let article: { content?: string; unavailable?: string } | null = null;
  let controller: AbortController | null = null;
  let running = false;
  let paint = 0;

  async function call(type: string, body: Record<string, unknown> = {}) {
    const result = await deps.sendMessage({ type: `assistant:${type}`, tabId: tab, session, ...(connectionId ? { connectionId } : {}), ...body });
    if (!result || result.error) throw new Error(result?.error || "Reopen Margin Chat on this page to reconnect.");
    return result;
  }
  const messageOf = (error: unknown) => error instanceof Error && error.message ? error.message : "Margin Chat could not complete that.";

  type View = "loading" | "connect" | "compose" | "reading" | "streaming" | "done" | "stopped" | "error" | "note";
  function show(view: View, detail = "") {
    const live = view === "reading" || view === "streaming";
    el("loading").hidden = view !== "loading";
    el("connect").hidden = view !== "connect";
    el("ask").hidden = view !== "compose";
    el("answer").hidden = !(view === "streaming" || view === "done" || view === "stopped" || view === "error" || view === "note") || !el("answer").textContent;
    el("status").hidden = !live;
    el("status").textContent = view === "reading" ? "Reading this page…" : view === "streaming" ? "Thinking…" : "";
    el("error").hidden = view !== "error";
    if (view === "error") el("error").textContent = detail;
    el("stop").hidden = !live;
    const finished = view === "done" || view === "note";
    el("pin").hidden = !finished;
    el("open").hidden = !finished;
    el("copy").hidden = !finished;
    el("retry").hidden = !(view === "done" || view === "stopped" || view === "error");
    el("delete").hidden = view !== "note";
    for (const row of Array.from(el("actions").querySelectorAll<HTMLElement>(".row"))) row.hidden = Array.from(row.querySelectorAll("button")).every((button) => button.hidden);
    el("actions").hidden = Array.from(el("actions").querySelectorAll<HTMLElement>(".row")).every((row) => row.hidden);
    if (view === "done" || view === "note") syncPin();
  }
  function syncPin() {
    const pinned = !!thread?.pinned;
    el("pin").textContent = pinned ? "Unpin margin note" : "Pin as margin note";
    el("pin").setAttribute("aria-pressed", String(pinned));
  }
  function showQuote(text: string) {
    el("quote").textContent = text.length > 280 ? `${text.slice(0, 279)}…` : text;
    el("quote").hidden = !text;
  }
  function renderAnswer(text: string) {
    renderMarkdownLite(el("answer"), text);
    el("answer").hidden = !text;
  }
  function scheduleRender(text: string) {
    if (paint) return;
    const flush = () => { paint = 0; renderAnswer(text); };
    // Coalesce streamed fragments into one paint; the final text is always rendered synchronously.
    paint = win.setTimeout(flush, 40) as unknown as number;
  }

  async function readContext() {
    if (article) return article;
    try { article = { content: String((await call("article")).content ?? "") }; }
    catch (error) { article = { unavailable: messageOf(error) }; }
    if (!article.unavailable && !article.content?.trim()) article = { unavailable: "No readable text was found on this page." };
    return article;
  }

  async function failureText(response: Response) {
    const payload = await response.json().catch(() => null);
    const detail = typeof payload?.error === "string" ? payload.error : "";
    if (response.status === 401) return "Your Margin Chat session has expired. Sign in again in the extension settings.";
    if (response.status === 402) return detail || "Add money to continue using hosted AI.";
    return detail || `Margin Chat could not answer (${response.status}).`;
  }

  async function run(prompt: string) {
    if (!page || !settings || running) return;
    const text = prompt.trim();
    if (!text) return;
    running = true;
    const id = thread?.id ?? crypto.randomUUID();
    thread = {
      id, createdAt: new Date().toISOString(), sourceUrl: page.sourceUrl, title: page.title, quote: page.quote,
      ...(page.anchor ? { anchor: page.anchor } : {}), intent: page.intent, prompt: text, answer: "", pinned: !!thread?.pinned,
    };
    renderAnswer("");
    el("context").hidden = true;
    const abort = controller = new AbortController();
    try {
      show("reading");
      const context = await readContext();
      if (abort.signal.aborted) throw new DOMException("Stopped", "AbortError");
      const excerpt = context.unavailable ? undefined : context.content;
      const cut = excerpt ? truncateExcerpt(excerpt).truncated : false;
      el("context").textContent = context.unavailable
        ? "Used only the selected passage. The rest of the page could not be read."
        : cut ? "Used the selected passage and the first part of this page." : "Used the selected passage and this page.";
      el("context").hidden = false;
      show("streaming");
      const now = new Date().toISOString();
      const response = await deps.createFetch(settings)("/api/chat", {
        method: "POST", signal: abort.signal,
        headers: { Accept: "application/x-ndjson", "Content-Type": "application/json", ...(settings.userId ? { "X-Margin-Vault-User": settings.userId } : {}) },
        body: JSON.stringify({
          serviceId: "backend-services",
          ai: { mode: "fast", contextScope: "conversation" },
          conversation: { id, title: threadTitle(thread), parentId: null, branchAnchor: null, documents: [], ancestorContext: [] },
          messages: [{ id: `page-${id}`, role: "user", createdAt: now, content: buildPageAIMessage({ title: page.title, url: page.sourceUrl, quote: page.quote, prompt: text, ...(excerpt ? { excerpt } : {}) }) }],
        }),
      });
      if (!response.ok) throw new Error(await failureText(response));
      if (!response.body) throw new Error("Margin Chat returned an empty answer.");
      let partial = "";
      const result = await readChatReplyStream(response.body, (delta) => {
        partial += delta; thread!.answer = partial;
        el("status").hidden = true; // the text itself now shows progress
        scheduleRender(partial);
      });
      if (paint) { win.clearTimeout(paint); paint = 0; }
      thread.answer = result.reply;
      renderAnswer(result.reply);
      await call("thread-save", { thread });
      show("done");
      el("live").textContent = "Answer ready.";
    } catch (error) {
      if (paint) { win.clearTimeout(paint); paint = 0; }
      if (thread) renderAnswer(thread.answer);
      if (abort.signal.aborted) show("stopped");
      else show("error", messageOf(error));
    } finally { running = false; if (controller === abort) controller = null; }
  }

  function choose(intent: PageThreadIntent) {
    if (!page) return;
    if (intent === "explain") void run(EXPLAIN_PROMPT);
    else { show("compose"); el<HTMLTextAreaElement>("prompt").focus(); }
  }
  async function start() {
    show("loading");
    try {
      const hello = await call("connect");
      if (!hello.connection) { el("connect-text").textContent = "Connect your Margin Chat account to ask about this page."; show("connect"); return; }
      connectionId = hello.connection.connectionId;
      settings = await deps.getSettings();
      if (!settings || settings.connectionId !== connectionId || !WORKSPACE_TOKEN.test(settings.token)) {
        el("connect-text").textContent = "This connection can save captures only. Sign in with Workspace + AI access to ask about this page.";
        show("connect"); return;
      }
      const threadId = deps.params.get("thread");
      if (threadId) {
        thread = (await call("thread-get", { id: threadId })).thread as PageThread;
        showQuote(thread.quote);
        el("heading").textContent = "Margin note";
        el("sub").textContent = thread.prompt;
        el("sub").hidden = false;
        renderAnswer(thread.answer);
        show("note");
        el("card").focus();
        return;
      }
      page = await call("request", { id: deps.params.get("request") }) as PageRequest;
      showQuote(page.quote);
      if (page.intent === "explain") { el("card").focus(); void run(EXPLAIN_PROMPT); }
      else choose("ask");
    } catch (error) {
      // Nothing was asked yet, so there is nothing to retry or keep.
      show("error", messageOf(error));
      el("retry").hidden = true; el("actions").hidden = true;
    }
  }

  async function togglePin() {
    if (!thread) return;
    const pinned = !thread.pinned;
    try { await call("thread-pin", { id: thread.id, pinned }); thread.pinned = pinned; syncPin(); el("live").textContent = pinned ? "Pinned as a margin note." : "Unpinned."; }
    catch (error) { show("error", messageOf(error)); }
  }
  async function copy() {
    if (!thread) return;
    try { await win.navigator.clipboard.writeText(thread.answer); el("live").textContent = "Copied."; }
    catch {
      const area = doc.createElement("textarea"); area.value = thread.answer; doc.body.append(area); area.select();
      try { doc.execCommand("copy"); el("live").textContent = "Copied."; } catch { /* Clipboard unavailable here. */ }
      area.remove();
    }
  }

  el("explain-chip").addEventListener("click", () => choose("explain"));
  el("ask").addEventListener("submit", (event) => { event.preventDefault(); void run(el<HTMLTextAreaElement>("prompt").value); });
  el<HTMLTextAreaElement>("prompt").addEventListener("keydown", (event) => {
    if (event.key === "Enter" && !event.shiftKey && !event.isComposing) { event.preventDefault(); void run(el<HTMLTextAreaElement>("prompt").value); }
  });
  for (const suggestion of ASK_SUGGESTIONS) {
    const chip = doc.createElement("button"); chip.type = "button"; chip.textContent = suggestion;
    chip.addEventListener("click", () => { const box = el<HTMLTextAreaElement>("prompt"); box.value = suggestion; box.focus(); });
    el("chips").append(chip);
  }
  el<HTMLTextAreaElement>("prompt").maxLength = PAGE_AI_LIMITS.prompt;
  el("stop").addEventListener("click", () => controller?.abort());
  el("retry").addEventListener("click", () => { if (thread) void run(thread.prompt); else choose(page?.intent ?? "ask"); });
  el("pin").addEventListener("click", () => void togglePin());
  el("copy").addEventListener("click", () => void copy());
  el("open").addEventListener("click", () => { if (thread) void call("open-workspace", { id: thread.id }).catch((error) => show("error", messageOf(error))); });
  el("delete").addEventListener("click", async () => { if (!thread) return; try { await call("thread-delete", { id: thread.id }); await call("close"); } catch (error) { show("error", messageOf(error)); } });
  el("close").addEventListener("click", () => { controller?.abort(); void call("close").catch(() => undefined); });
  el("settings").addEventListener("click", () => deps.openSettings());
  doc.addEventListener("keydown", (event) => { if (event.key === "Escape") { controller?.abort(); void call("close").catch(() => undefined); } });

  return { start };
}
