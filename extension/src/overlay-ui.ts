import { CAPTURE_LIMITS, normalizeCapture, type CaptureKind } from "@margin-chat/capture-contracts";
import { captureTextAnchor, resolveTextAnchor, type TextAnchor } from "./anchors";
import { extractArticle, extractSelection } from "./extraction";
import { overlayStyles } from "./overlay-styles";
import type { OverlayAnnotation, OverlayDraft, OverlayState } from "./overlay-types";

type Send = (message: Record<string, unknown>) => Promise<any>;
type Layout = "docked" | "floating" | "expanded";

export function createMarginOverlay(doc: Document, send: Send, options: { shadowMode?: ShadowRootMode } = {}) {
  const win = doc.defaultView!;
  const host = doc.createElement("div");
  host.dataset.marginOverlay = "true";
  // Isolate page styles and ordinary DOM queries. This is not an input-security boundary.
  const root = host.attachShadow({ mode: options.shadowMode ?? "closed" });
  const style = doc.createElement("style");
  style.textContent = overlayStyles;
  root.append(style);
  const panel = doc.createElement("aside");
  panel.className = "panel";
  panel.setAttribute("aria-label", "Margin Chat page workspace");
  panel.hidden = true;
  // Static UI only. All page content and saved text is assigned with textContent/value.
  panel.innerHTML = `
    <header><span class="mark" aria-hidden="true">m</span><span class="brand">Margin</span><span class="privacy">Only you</span><button class="icon" id="close" aria-label="Close Margin">×</button></header>
    <div class="view-controls" role="group" aria-label="Workspace layout"><button data-layout="docked" aria-pressed="true">Docked</button><button data-layout="floating" aria-pressed="false">Floating</button><button data-layout="expanded" aria-pressed="false">Expanded</button><button id="peek">Peek at page</button></div>
    <div class="page"><strong id="page-title"></strong><small id="page-url"></small></div>
    <nav aria-label="Margin spaces"><button data-space="margin" aria-pressed="true">My margin</button><button data-space="ask" aria-pressed="false">Ask AI</button><button data-space="community" aria-pressed="false">Community · soon</button></nav>
    <main>
      <section id="connect" hidden><p class="eyebrow">Your space on the web</p><h1>A little room to think.</h1><p class="muted">Keep a passage, leave a thought, and carry the page into your Margin Chat workspace.</p><button id="sign-in" class="primary">Connect Margin Chat</button></section>
      <section id="private" hidden>
        <div id="pending" class="pending" hidden><p id="pending-text"></p><button id="retry">Retry save</button><button id="dismiss">Dismiss pending save</button><button id="review-pending" hidden>Review pending capture</button></div>
        <div class="capture-layout"><section class="compose">
          <p class="eyebrow" id="eyebrow">Private by default</p><h1 id="heading">Think in the margin.</h1><p id="intro" class="muted">Select a passage on the page to highlight it and add your thoughts.</p>
          <div class="modes" role="group" aria-label="Page context"><button data-kind="selection" aria-pressed="true">Selected passage</button><button data-kind="article" aria-pressed="false">Readable page</button><button data-kind="bookmark" aria-pressed="false">Link only</button></div>
          <form id="form"><label for="title">Title</label><input id="title" maxlength="300" required />
          <div class="context-label"><label id="context-label" for="content">Page context</label><button id="refresh-context" type="button">Read again</button></div><textarea id="content" rows="4" readonly></textarea>
          <label id="comment-label" for="comment">Your thought · optional</label><textarea id="comment" maxlength="10000" rows="3" placeholder="What stands out to you?"></textarea>
          <div id="suggestions" class="suggestions" hidden><button type="button" data-prompt="Explain the main ideas in this source.">Explain this</button><button type="button" data-prompt="What assumptions does this source make, and what should I question?">Challenge it</button><button type="button" data-prompt="Help me turn this source into actionable notes.">Make useful notes</button></div>
          <button id="save" class="primary" type="submit">Save passage & thought</button><p id="save-help" class="muted">Saved to your Cloud Inbox with a link to the source.</p></form>
        </section><section class="history"><h2 id="notes-heading">On this page</h2><div id="entries"></div></section></div>
      </section>
      <section id="community" class="community" hidden><p class="eyebrow">A future shared margin</p><h1>The conversation beside the page.</h1><p class="muted">Community discussions aren’t connected yet. Your notes and AI questions stay private.</p><div class="entry"><h2>Discuss the page</h2><p>Posts and replies attached to this source, with conversations around specific passages.</p></div><div class="entry"><h2>Choose your audience</h2><p>Share a thought with a group or publish it publicly. Sharing will always be an explicit step.</p></div><div class="entry"><h2>Bring a thought home</h2><p>Keep a community post in your own workspace with attribution and its source.</p></div></section>
    </main><p id="status" class="status" role="status" aria-live="polite"></p><footer><span id="account">Private workspace</span><button id="settings">Connection settings</button></footer>`;
  const peekTab = doc.createElement("button");
  peekTab.className = "peek-tab";
  peekTab.textContent = "Return to Margin";
  peekTab.hidden = true;
  const pageReveal = doc.createElement("button");
  pageReveal.className = "page-reveal";
  pageReveal.textContent = "Uncover page";
  pageReveal.hidden = true;
  root.append(panel, peekTab, pageReveal);
  doc.documentElement.append(host);
  const el = <T extends HTMLElement = HTMLElement>(id: string) => root.getElementById(id) as T;
  const title = el<HTMLInputElement>("title");
  const content = el<HTMLTextAreaElement>("content");
  const comment = el<HTMLTextAreaElement>("comment");
  let pageUrl = win.location.href;
  let state: OverlayState | null = null;
  let kind: CaptureKind = "article";
  let space: "margin" | "ask" | "community" = "margin";
  let anchor: TextAnchor | undefined;
  let selectedAnchor: TextAnchor | undefined;
  let selectionText = "";
  let busy = false;
  let ready = false;
  let active = false;
  let generation = 0;
  let opening = 0;
  let draftTimer: ReturnType<typeof setTimeout> | undefined;
  let layout: Layout = "docked";
  let floatingBounds: { left: number; top: number; width: number; height: number } | undefined;
  let draftWrites = Promise.resolve();
  let privateComment = "";
  let question = "";

  const report = (text: string, error = false) => {
    el("status").textContent = text;
    el("status").classList.toggle("error", error);
  };
  async function request(type: string, body: Record<string, unknown> = {}) {
    const result = await send({ type: `overlay:${type}`, connectionId: state?.connection?.connectionId, ...body });
    if (result?.error) throw new Error(result.error);
    if (!result) throw new Error("Reload the extension and reopen Margin to reconnect.");
    return result;
  }
  const errorMessage = (error: unknown) => error instanceof Error ? error.message : "Margin couldn’t complete that action. Try again.";
  function draft(): OverlayDraft {
    if (space === "ask") question = comment.value; else if (space === "margin") privateComment = comment.value;
    return { title: title.value, kind, content: content.value, comment: privateComment, question, mode: space === "ask" ? "ask" : "annotate", ...(anchor ? { anchor } : {}) };
  }
  function persistDraft(clear = false) {
    if (draftTimer) clearTimeout(draftTimer);
    if (!state?.connection || pageUrl !== win.location.href) return draftWrites;
    const body = { connectionId: state.connection.connectionId, draft: clear ? null : draft() };
    const expectedUrl = pageUrl;
    draftWrites = draftWrites.catch(() => {}).then(async () => {
      if (expectedUrl !== win.location.href) return;
      await request("draft", body);
    }).catch((error) => report(`Draft could not be saved: ${errorMessage(error)}`, true));
    return draftWrites;
  }
  function updateSave() {
    el<HTMLButtonElement>("save").disabled = busy || !ready || !state?.connection || !!state.hasOtherPending || !!(state.pending && !state.pending.receipt);
    for (const control of root.querySelectorAll<HTMLButtonElement>("[data-kind], [data-space], #retry, #dismiss")) control.disabled = busy;
    for (const field of [title, comment]) field.disabled = busy;
    el<HTMLButtonElement>("refresh-context").disabled = busy;
  }
  function readContext(nextKind = kind, persist = true) {
    kind = nextKind;
    ready = false;
    anchor = undefined;
    content.value = "";
    title.value = doc.title.slice(0, CAPTURE_LIMITS.title) || "Untitled page";
    root.querySelectorAll<HTMLButtonElement>("[data-kind]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.kind === kind)));
    content.hidden = kind === "bookmark";
    el("context-label").hidden = kind === "bookmark";
    el("refresh-context").hidden = kind === "bookmark";
    try {
      if (kind === "selection") {
        content.value = extractSelection(selectionText);
        anchor = selectedAnchor;
      } else if (kind === "article") {
        const article = extractArticle(doc);
        content.value = article.content;
        title.value = article.title;
      }
      ready = true;
      report("");
      if (persist) void persistDraft();
    } catch (error) {
      report(kind === "selection" ? "Select a passage on the page. Your selection will appear here." : errorMessage(error), kind !== "selection");
    }
    updateSave();
    renderHighlights();
  }
  function renderHighlights() {
    const css = (win as unknown as { CSS?: { highlights?: Map<string, unknown> } }).CSS;
    const Highlight = (win as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;
    if (!css?.highlights || !Highlight) return;
    const ranges = (state?.page.annotations ?? []).flatMap((item) => {
      const range = item.anchor && resolveTextAnchor(doc, item.anchor);
      return range ? [range] : [];
    });
    css.highlights.set("margin-saved-passages", new Highlight(...ranges));
    let highlightStyle = doc.querySelector<HTMLStyleElement>("style[data-margin-highlights]");
    if (!highlightStyle) {
      highlightStyle = doc.createElement("style");
      highlightStyle.dataset.marginHighlights = "true";
      highlightStyle.textContent = "::highlight(margin-saved-passages) { background-color: #e7db82a6; color: inherit; }";
      doc.documentElement.append(highlightStyle);
    }
  }
  async function openWorkspace(item: OverlayAnnotation, intent: "note" | "ask" = "note") {
    try { await request("open", { captureId: item.captureId, intent }); }
    catch (error) { report(errorMessage(error), true); }
  }
  function renderEntries() {
    const entries = el("entries");
    entries.replaceChildren();
    const annotations = state?.page.annotations ?? [];
    el("notes-heading").textContent = `On this page${annotations.length ? ` · ${annotations.length}` : ""}`;
    if (!annotations.length) {
      const empty = doc.createElement("p");
      empty.className = "empty";
      empty.textContent = "Your saved passages and thoughts will collect here. This browser remembers their place on the page.";
      entries.append(empty);
    }
    for (const item of [...annotations].reverse()) {
      const card = doc.createElement("article");
      card.className = "entry";
      const quote = doc.createElement("blockquote");
      quote.textContent = item.anchor?.exact.slice(0, 400) || item.excerpt || item.title;
      const thought = doc.createElement("p");
      thought.textContent = item.comment;
      const date = doc.createElement("small");
      date.textContent = `${item.kind === "selection" ? "Passage" : item.kind === "article" ? "Page" : "Link"} · ${new Date(item.capturedAt).toLocaleDateString()}`;
      const actions = doc.createElement("div");
      actions.className = "actions";
      if (item.anchor) {
        const locate = doc.createElement("button");
        locate.textContent = "Find on page";
        locate.addEventListener("click", () => {
          const range = resolveTextAnchor(doc, item.anchor!);
          if (!range) { report("This passage has changed or moved. Your saved copy is still in your workspace."); return; }
          const node = range.startContainer.parentElement;
          node?.scrollIntoView({ behavior: "smooth", block: "center" });
          if (layout === "expanded") peek(true);
          report("Passage highlighted on the page.");
        });
        actions.append(locate);
      }
      if (item.captureId) {
        const open = doc.createElement("button");
        open.textContent = "Open in workspace ↗";
        open.addEventListener("click", () => void openWorkspace(item));
        actions.append(open);
      }
      card.append(quote, thought, date, actions);
      entries.append(card);
    }
    renderHighlights();
  }
  function renderPending() {
    const pending = state?.pending;
    const other = !!state?.hasOtherPending;
    el("pending").hidden = !other && (!pending || !!pending.receipt);
    el("pending-text").textContent = other ? "Another page has a pending save. Review it before saving this page." : pending?.error || "A capture is waiting to be saved. Retry to keep the same capture without a duplicate.";
    el("retry").hidden = other;
    el("dismiss").hidden = other;
    el("review-pending").hidden = !other;
    updateSave();
  }
  function showSpace(next: typeof space, persist = true) {
    if (space === "ask") question = comment.value; else if (space === "margin") privateComment = comment.value;
    space = next;
    root.querySelectorAll<HTMLButtonElement>("[data-space]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.space === space)));
    el("connect").hidden = !!state?.connection || space === "community";
    el("private").hidden = !state?.connection || space === "community";
    el("community").hidden = space !== "community";
    if (space === "community") return;
    const asking = space === "ask";
    comment.value = asking ? question : privateComment;
    comment.required = asking;
    comment.placeholder = asking ? "What do you want to explore about this source?" : "What stands out to you?";
    el("eyebrow").textContent = asking ? "Think with the source" : "Private by default";
    el("heading").textContent = asking ? "Follow your curiosity." : "Think in the margin.";
    el("intro").textContent = asking ? "Bring this page or a selected passage into a conversation with AI in your workspace." : "Select a passage on the page to highlight it and add your thoughts.";
    el("comment-label").textContent = asking ? "Your question" : "Your thought · optional";
    el("save").textContent = asking ? "Continue with AI in workspace ↗" : kind === "selection" ? "Save passage & thought" : kind === "article" ? "Save page & thought" : "Save link & thought";
    el("save-help").textContent = asking ? "Saves this context, then opens Margin Chat. Review your question there before sending it to AI." : "Saved to your Cloud Inbox with a link to the source.";
    el("suggestions").hidden = !asking;
    if (persist) void persistDraft();
  }
  function captureSelection(event?: Event) {
    if (!active || busy || pageUrl !== win.location.href) return;
    if (event?.composedPath().includes(host)) return;
    const captured = captureTextAnchor(win.getSelection(), doc);
    if (!captured) return;
    if (captured.exact === selectedAnchor?.exact && captured.start === selectedAnchor.start && captured.prefix === selectedAnchor.prefix && captured.suffix === selectedAnchor.suffix) return;
    selectedAnchor = captured;
    selectionText = captured.exact;
    if (space !== "community") {
      readContext("selection");
      showSpace(space);
    }
  }
  async function refresh(restoreDraft: boolean) {
    const sequence = ++generation;
    const next = await request("state") as OverlayState;
    if (sequence !== generation || pageUrl !== win.location.href) return;
    const accountChanged = state?.connection?.connectionId !== next.connection?.connectionId;
    state = next;
    el("account").textContent = next.connection ? `Cloud Inbox · ${next.connection.displayName}` : "Private workspace";
    if (restoreDraft || accountChanged) {
      const saved = next.page.draft;
      privateComment = saved?.comment ?? "";
      question = saved?.question ?? "";
      comment.value = "";
      if (saved) {
        kind = saved.kind;
        anchor = saved.anchor;
        selectedAnchor = saved.anchor;
        selectionText = saved.anchor?.exact ?? selectionText;
        title.value = saved.title;
        content.value = saved.content;
        ready = kind === "bookmark" || !!saved.content.trim();
        space = saved.mode === "ask" ? "ask" : "margin";
        comment.value = space === "ask" ? question : privateComment;
        content.hidden = kind === "bookmark";
        el("context-label").hidden = kind === "bookmark";
        el("refresh-context").hidden = kind === "bookmark";
        root.querySelectorAll<HTMLButtonElement>("[data-kind]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.kind === kind)));
      } else {
        readContext(selectionText ? "selection" : "article", false);
      }
    }
    showSpace(space, false);
    renderPending();
    renderEntries();
  }
  async function save(retry = false) {
    if (busy || pageUrl !== win.location.href) return;
    const requestGeneration = generation;
    const requestUrl = pageUrl;
    busy = true;
    updateSave();
    report("Saving to your Cloud Inbox…");
    try {
      await persistDraft();
      if (requestGeneration !== generation || requestUrl !== win.location.href) return;
      const payload = retry ? {} : {
        capture: normalizeCapture({ schemaVersion: 1, clientCaptureId: crypto.randomUUID(), kind, title: title.value, content: content.value, comment: comment.value, sourceUrl: pageUrl, capturedAt: new Date().toISOString() }),
        annotation: anchor ? { anchor } : {}, intent: space === "ask" ? "ask" : "note",
      };
      const result = await request(retry ? "retry" : "save", payload);
      if (requestGeneration !== generation || pageUrl !== win.location.href) return;
      if (!result.receipt) throw new Error("The server did not confirm this save. Retry your pending capture.");
      await persistDraft(true);
      if (requestGeneration !== generation || requestUrl !== win.location.href) return;
      const ask = space === "ask";
      privateComment = "";
      question = "";
      comment.value = "";
      await refresh(false);
      report("Saved. Your source and thought are in your workspace.");
      if (ask) await request("open", { captureId: result.receipt.id, intent: "ask" });
    } catch (error) {
      if (requestGeneration === generation) {
        try { await refresh(false); } catch { /* Keep the original failure visible. */ }
        report(errorMessage(error), true);
      }
    } finally { busy = false; updateSave(); }
  }
  function peek(value: boolean) {
    panel.classList.toggle("peeking", value);
    peekTab.hidden = !value;
    pageReveal.hidden = value || !active || layout !== "expanded";
    if (value) peekTab.focus();
  }
  function setLayout(next: Layout) {
    if (layout === "floating") {
      const bounds = panel.getBoundingClientRect();
      if (bounds.width && bounds.height) floatingBounds = { left: bounds.left, top: bounds.top, width: bounds.width, height: bounds.height };
    }
    layout = next;
    panel.dataset.layout = next;
    panel.style.removeProperty("left");
    panel.style.removeProperty("top");
    panel.style.removeProperty("width");
    panel.style.removeProperty("height");
    if (next === "floating" && floatingBounds) {
      panel.style.width = `${Math.min(floatingBounds.width, win.innerWidth - 28)}px`;
      panel.style.height = `${Math.min(floatingBounds.height, win.innerHeight - 28)}px`;
      panel.style.left = `${Math.max(6, Math.min(floatingBounds.left, win.innerWidth - floatingBounds.width - 6))}px`;
      panel.style.top = `${Math.max(6, Math.min(floatingBounds.top, win.innerHeight - floatingBounds.height - 6))}px`;
    }
    root.querySelectorAll<HTMLButtonElement>("[data-layout]").forEach((button) => button.setAttribute("aria-pressed", String(button.dataset.layout === next)));
    peek(false);
  }
  function close() {
    void persistDraft();
    active = false;
    panel.hidden = true;
    peekTab.hidden = true;
    pageReveal.hidden = true;
  }
  async function open(selection?: { text: string; sourceUrl?: string }) {
    const openSequence = ++opening;
    const openingUrl = win.location.href;
    active = true;
    panel.hidden = false;
    peek(false);
    if (pageUrl !== win.location.href) {
      pageUrl = win.location.href;
      state = null;
      ready = false;
      anchor = selectedAnchor = undefined;
      selectionText = "";
      privateComment = question = comment.value = "";
      title.value = content.value = "";
      el("private").hidden = true;
      renderEntries();
      renderPending();
    }
    el("page-title").textContent = doc.title || "Untitled page";
    el("page-url").textContent = pageUrl;
    const captured = captureTextAnchor(win.getSelection(), doc);
    const explicitSelection = selection?.sourceUrl === pageUrl ? selection : undefined;
    selectedAnchor = captured ?? selectedAnchor;
    selectionText = captured?.exact || (selection?.sourceUrl === pageUrl ? selection.text : selectionText);
    try {
      await draftWrites;
      if (openSequence !== opening || openingUrl !== win.location.href) return;
      await refresh(true);
      if (openSequence !== opening || openingUrl !== win.location.href) return;
      if (explicitSelection?.text) {
        selectedAnchor = captured?.exact.trim() === explicitSelection.text.trim() ? captured ?? undefined : undefined;
        selectionText = explicitSelection.text;
        readContext("selection"); showSpace("margin");
      }
    } catch (error) { report(errorMessage(error), true); }
  }
  root.querySelectorAll<HTMLButtonElement>("[data-kind]").forEach((button) => button.addEventListener("click", () => { readContext(button.dataset.kind as CaptureKind); showSpace(space); }));
  root.querySelectorAll<HTMLButtonElement>("[data-space]").forEach((button) => button.addEventListener("click", () => showSpace(button.dataset.space as typeof space)));
  root.querySelectorAll<HTMLButtonElement>("[data-layout]").forEach((button) => button.addEventListener("click", () => setLayout(button.dataset.layout as Layout)));
  root.querySelectorAll<HTMLButtonElement>("[data-prompt]").forEach((button) => button.addEventListener("click", () => { comment.value = button.dataset.prompt!; comment.focus(); void persistDraft(); }));
  el("form").addEventListener("submit", (event) => { event.preventDefault(); if (ready && !el<HTMLButtonElement>("save").disabled) void save(); });
  el("retry").addEventListener("click", () => void save(true));
  el("dismiss").addEventListener("click", async () => { try { await request("dismiss"); await refresh(false); report("Pending save dismissed."); } catch (error) { report(errorMessage(error), true); } });
  el("refresh-context").addEventListener("click", () => readContext());
  for (const id of ["settings", "sign-in", "review-pending"]) el(id).addEventListener("click", () => void request(id === "review-pending" ? "pending" : "settings").catch((error) => report(errorMessage(error), true)));
  el("close").addEventListener("click", close);
  el("peek").addEventListener("click", () => peek(true));
  peekTab.addEventListener("click", () => { peek(false); el("peek").focus(); });
  pageReveal.addEventListener("click", () => peek(true));
  for (const field of [title, comment]) field.addEventListener("input", () => { if (draftTimer) clearTimeout(draftTimer); draftTimer = setTimeout(() => void persistDraft(), 250); });
  root.addEventListener("keydown", (event) => { if ((event as KeyboardEvent).key === "Escape") { event.stopPropagation(); close(); } });
  doc.addEventListener("mouseup", captureSelection);
  doc.addEventListener("keyup", captureSelection);
  // SPA navigations get their own page state. Never keep the old URL's draft or highlights.
  const navigationTimer = setInterval(() => { if (active && pageUrl !== win.location.href) void open(); }, 700);
  let drag: { x: number; y: number; left: number; top: number } | undefined;
  panel.querySelector("header")!.addEventListener("pointerdown", (event) => {
    const pointer = event as PointerEvent;
    if (layout !== "floating" || pointer.button !== 0 || (pointer.target as Element).closest("button")) return;
    const rect = panel.getBoundingClientRect();
    drag = { x: pointer.clientX, y: pointer.clientY, left: rect.left, top: rect.top };
    (pointer.currentTarget as HTMLElement).setPointerCapture?.(pointer.pointerId);
    pointer.preventDefault();
  });
  panel.querySelector("header")!.addEventListener("pointermove", (event) => {
    if (!drag) return;
    const pointer = event as PointerEvent;
    panel.style.left = `${Math.max(6, Math.min(win.innerWidth - panel.offsetWidth - 6, drag.left + pointer.clientX - drag.x))}px`;
    panel.style.top = `${Math.max(6, Math.min(win.innerHeight - panel.offsetHeight - 6, drag.top + pointer.clientY - drag.y))}px`;
  });
  panel.querySelector("header")!.addEventListener("pointerup", () => { drag = undefined; });
  panel.querySelector("header")!.addEventListener("pointercancel", () => { drag = undefined; });
  setLayout("docked");
  return {
    open,
    toggle: () => active ? close() : void open(),
    destroy: () => { clearInterval(navigationTimer); if (draftTimer) clearTimeout(draftTimer); doc.removeEventListener("mouseup", captureSelection); doc.removeEventListener("keyup", captureSelection); host.remove(); },
  };
}
