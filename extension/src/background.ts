import {
  CAPTURE_API_PATH,
  CAPTURE_KINDS,
  CAPTURE_LIMITS,
  normalizeCapture,
  normalizeServerUrl,
  parseCaptureReceipt,
  type CaptureInput,
} from "@margin-chat/capture-contracts";
import {
  getOverlayPage,
  getPending,
  getSettings,
  getThreads,
  trustedStorage,
  updateOverlayPage,
  updateThreads,
  type PendingSave,
  type SelectionDraft,
} from "./storage";
import type { OverlayAnnotation, OverlayDraft, OverlayState, TextQuoteAnchor } from "./overlay-types";
import { captureRequest, errorText } from "./network";
import { assertThreadCapacity, pageNotes, normalizeThread, upsertThread } from "./page-ai";
import { normalizeAnchor, record, textValue } from "./validate";
import { isTheme, THEME_MIRROR_KEY } from "./theme";

void trustedStorage();
chrome.runtime.onInstalled.addListener(() => {
  void chrome.contextMenus.removeAll().then(() =>
    chrome.contextMenus.create({
      id: "save-selection",
      title: "Annotate in Margin Chat",
      contexts: ["selection"],
      documentUrlPatterns: ["http://*/*", "https://*/*"],
    }),
  );
});

function pageUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > CAPTURE_LIMITS.url)
    throw new Error("Open a regular web page to use Margin Chat.");
  const url = new URL(value);
  if (!["http:", "https:"].includes(url.protocol) || url.username || url.password)
    throw new Error("Open a regular web page to use Margin Chat.");
  return url.href;
}

async function openPopup(tab?: chrome.tabs.Tab, selection?: SelectionDraft) {
  if (selection) await chrome.storage.session.set({ selectionDraft: selection });
  try {
    await chrome.action.openPopup(tab ? { windowId: tab.windowId } : {});
  } catch {
    await chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
  }
}

async function showOverlay(tab: chrome.tabs.Tab, selection?: SelectionDraft) {
  try {
    if (typeof tab.id !== "number") throw new Error("Missing tab.");
    const expectedUrl = pageUrl(tab.url);
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      world: "ISOLATED",
      files: ["overlay.js"],
    });
    await chrome.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [0] },
      world: "ISOLATED",
      func: (url: string, draft: SelectionDraft | null) => {
        if (location.href !== url) return;
        const overlay = (globalThis as unknown as {
          marginOverlay: { toggle(): void; open(selection?: SelectionDraft): void };
        }).marginOverlay;
        if (draft) overlay.open(draft);
        else overlay.toggle();
      },
      args: [expectedUrl, selection ?? null],
    });
  } catch {
    await openPopup(tab, selection);
  }
}

chrome.action.onClicked.addListener((tab) => { void showOverlay(tab); });
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "save-selection" || !tab) return;
  const selection: SelectionDraft = {
    text: info.selectionText ?? "",
    sourceUrl: info.frameUrl ?? info.pageUrl ?? tab.url ?? "",
    title: tab.title ?? "Saved passage",
  };
  // Selections inside a frame belong to that document, not its parent page.
  if (info.frameId && info.frameId !== 0) void openPopup(tab, selection);
  else void showOverlay(tab, selection);
});

function normalizeDraft(value: unknown): OverlayDraft | null {
  if (value === null) return null;
  const draft = record(value);
  if (!CAPTURE_KINDS.includes(draft.kind as CaptureInput["kind"]))
    throw new Error("Invalid capture kind.");
  if (draft.mode !== undefined && !["annotate", "comment", "ingest", "ask"].includes(String(draft.mode)))
    throw new Error("Invalid capture mode.");
  return {
    title: textValue(draft.title, CAPTURE_LIMITS.title, "title"),
    kind: draft.kind as CaptureInput["kind"],
    content: textValue(draft.content, CAPTURE_LIMITS.content, "content"),
    comment: textValue(draft.comment, CAPTURE_LIMITS.comment, "comment"),
    ...(draft.question === undefined ? {} : { question: textValue(draft.question, CAPTURE_LIMITS.comment, "question") }),
    ...(draft.mode === undefined ? {} : { mode: draft.mode as OverlayDraft["mode"] }),
    ...(draft.anchor === undefined ? {} : { anchor: normalizeAnchor(draft.anchor) }),
  };
}
function annotationFor(capture: CaptureInput, value: unknown): OverlayAnnotation {
  const metadata = value === undefined ? {} : record(value);
  return {
    id: capture.clientCaptureId,
    title: capture.title,
    kind: capture.kind,
    excerpt: capture.content.slice(0, 400),
    comment: capture.comment,
    capturedAt: capture.capturedAt,
    ...(metadata.anchor === undefined ? {} : { anchor: normalizeAnchor(metadata.anchor) }),
  };
}
async function recordSavedAnnotation(pending: PendingSave) {
  if (!pending.overlayAnnotation || !pending.receipt) return;
  const annotation = { ...pending.overlayAnnotation, captureId: pending.receipt.id };
  const existing = await getOverlayPage(pending.connectionId, pending.capture.sourceUrl);
  if (existing.annotations.some((item) => item.id === annotation.id && item.captureId === annotation.captureId)) return;
  await updateOverlayPage(pending.connectionId, pending.capture.sourceUrl, (page) => ({
    ...page,
    annotations: [...page.annotations.filter((item) => item.id !== annotation.id), annotation],
  }));
}

let saving = false;
async function save(input: unknown, retry: boolean, expectedConnection: unknown, annotation?: OverlayAnnotation, expectedSourceUrl?: string) {
  if (saving)
    throw new Error("A capture is already being saved. Check its status before saving again.");
  saving = true;
  try {
    await trustedStorage();
    const settings = await getSettings();
    if (!settings)
      throw new Error("Sign in to your account in extension settings first.");
    if (expectedConnection !== settings.connectionId)
      throw new Error("The signed-in account changed. Reopen Margin Chat before saving.");
    let pending: PendingSave | null = await getPending();
    if (retry) {
      if (!pending) throw new Error("There is no saved draft to retry.");
      if (pending.connectionId !== settings.connectionId)
        throw new Error("This draft belongs to a previous connection. Start a new capture for this account.");
      if (expectedSourceUrl && pending.capture.sourceUrl !== expectedSourceUrl)
        throw new Error("This page has no pending capture for the signed-in account.");
      if (pending.receipt) {
        await recordSavedAnnotation(pending);
        return pending.receipt;
      }
    } else {
      if (pending && !pending.receipt)
        throw new Error("Retry or dismiss the previous capture before saving another.");
      pending = {
        capture: normalizeCapture(input),
        connectionId: settings.connectionId,
        ...(annotation ? { overlayAnnotation: annotation } : {}),
      };
    }
    // Persist before sending. A closed panel, interrupted worker, or lost response is retryable.
    await chrome.storage.local.set({ pendingSave: pending });
    try {
      const result = await captureRequest(settings, CAPTURE_API_PATH, parseCaptureReceipt, pending.capture);
      // Explicitly copy receipt fields: future server fields must not cross into content scripts.
      pending = { ...pending, receipt: { id: result.capture.id, createdAt: result.capture.createdAt }, error: undefined };
      await chrome.storage.local.set({ pendingSave: pending });
      await recordSavedAnnotation(pending);
      return pending.receipt;
    } catch (error) {
      await chrome.storage.local.set({ pendingSave: { ...pending, error: errorText(error) } });
      throw error;
    }
  } finally {
    saving = false;
  }
}

async function requireConnection(expected: unknown) {
  const settings = await getSettings();
  if (!settings) throw new Error("Sign in to your account in extension settings first.");
  if (settings.connectionId !== expected)
    throw new Error("The signed-in account changed. Reopen Margin Chat before continuing.");
  return settings;
}
async function pagePending(connectionId: string, sourceUrl: string) {
  const pending = await getPending();
  if (!pending || pending.connectionId !== connectionId || pending.capture.sourceUrl !== sourceUrl)
    throw new Error("This page has no pending capture for the signed-in account.");
  return pending;
}
async function dismiss(expectedConnection?: unknown, sourceUrl?: string) {
  if (saving) throw new Error("Wait for the current save to finish.");
  saving = true;
  try {
    if (sourceUrl) {
      const settings = await requireConnection(expectedConnection);
      await pagePending(settings.connectionId, sourceUrl);
    }
    const pending = await getPending();
    if (pending) await recordSavedAnnotation(pending);
    await chrome.storage.local.remove("pendingSave");
    return { ok: true };
  } finally {
    saving = false;
  }
}
async function overlayMessage(message: Record<string, unknown>, sourceUrl: string) {
  await trustedStorage();
  if (message.type === "overlay:settings") {
    await chrome.runtime.openOptionsPage();
    return { ok: true };
  }
  if (message.type === "overlay:preferences") {
    const theme = (await chrome.storage.local.get(THEME_MIRROR_KEY))[THEME_MIRROR_KEY];
    const dockWidth = (await chrome.storage.local.get("dockWidth")).dockWidth;
    return { theme: isTheme(theme) ? theme : null, dockWidth: typeof dockWidth === "number" ? dockWidth : null };
  }
  if (message.type === "overlay:dock-width") {
    const width = Number(message.width);
    if (!Number.isFinite(width) || width < 200 || width > 10000) throw new Error("Invalid panel width.");
    await chrome.storage.local.set({ dockWidth: Math.round(width) });
    return { ok: true };
  }
  if (message.type === "overlay:pending") {
    await chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
    return { ok: true };
  }
  if (message.type === "overlay:state") {
    const settings = await getSettings();
    if (!settings) return { connection: null, pending: null, hasOtherPending: false, page: { annotations: [], draft: null } } satisfies OverlayState;
    const pending = await getPending();
    const samePage = pending?.connectionId === settings.connectionId && pending.capture.sourceUrl === sourceUrl;
    // A worker can stop after storing the server receipt and before writing the
    // page index. Finish that durable operation before displaying the page.
    if (samePage) await recordSavedAnnotation(pending);
    return {
      connection: { connectionId: settings.connectionId, displayName: settings.displayName },
      pending: samePage ? {
        capture: pending.capture,
        connectionId: pending.connectionId,
        ...(pending.receipt ? { receipt: { id: pending.receipt.id, createdAt: pending.receipt.createdAt } } : {}),
        ...(pending.error ? { error: pending.error } : {}),
        ...(pending.overlayAnnotation ? { overlayAnnotation: pending.overlayAnnotation } : {}),
      } : null,
      hasOtherPending: Boolean(pending && !pending.receipt && !samePage),
      page: await getOverlayPage(settings.connectionId, sourceUrl),
    } satisfies OverlayState;
  }
  if (message.type === "overlay:notes") {
    // Page-derived anchors and opaque ids only: never prompts or answers.
    const settings = await getSettings();
    return { notes: settings ? pageNotes(await getThreads(settings.connectionId), sourceUrl) : [] };
  }
  const settings = await requireConnection(message.connectionId);
  if (message.type === "overlay:draft") {
    const draft = normalizeDraft(message.draft);
    const page = await updateOverlayPage(settings.connectionId, sourceUrl, (current) => ({ ...current, draft }));
    return { ok: true, page };
  }
  if (message.type === "overlay:save") {
    const capture = normalizeCapture(message.capture);
    if (capture.sourceUrl !== sourceUrl) throw new Error("The page changed. Capture it again before saving.");
    const receipt = await save(capture, false, message.connectionId, annotationFor(capture, message.annotation));
    return { receipt, page: await getOverlayPage(settings.connectionId, sourceUrl) };
  }
  if (message.type === "overlay:retry") {
    const receipt = await save(undefined, true, message.connectionId, undefined, sourceUrl);
    return { receipt, page: await getOverlayPage(settings.connectionId, sourceUrl) };
  }
  if (message.type === "overlay:dismiss") return dismiss(message.connectionId, sourceUrl);
  if (message.type === "overlay:open") {
    if (typeof message.captureId !== "string" || !["ask", "note"].includes(String(message.intent)))
      throw new Error("Choose a saved capture to open.");
    const page = await getOverlayPage(settings.connectionId, sourceUrl);
    const pending = await getPending();
    const belongsToPage = page.annotations.some((annotation) => annotation.captureId === message.captureId) ||
      (pending?.connectionId === settings.connectionId && pending.capture.sourceUrl === sourceUrl && pending.receipt?.id === message.captureId);
    if (!belongsToPage) throw new Error("This capture does not belong to this page and account.");
    const url = new URL(`${normalizeServerUrl(settings.serverUrl)}/`);
    url.searchParams.set("inbox", "1");
    url.searchParams.set("capture", message.captureId);
    url.searchParams.set("intent", String(message.intent));
    await requireConnection(message.connectionId);
    await chrome.tabs.create({ url: url.href });
    return { ok: true };
  }
  throw new Error("Unsupported Margin Chat action.");
}

interface FrameSession {
  tabId: number;
  session: string;
  sourceUrl: string;
  documentId?: string;
}
const frameSessionKey = (tabId: number) => `workspaceFrame:${tabId}`;
async function storedFrame(tabId: number): Promise<FrameSession | undefined> {
  const key = frameSessionKey(tabId);
  return (await chrome.storage.session.get(key))[key] as FrameSession | undefined;
}
async function registerFrame(sender: chrome.runtime.MessageSender, sourceUrl: string) {
  const tabId = sender.tab!.id!;
  // Registration only follows a toolbar injection in the isolated main frame.
  // Persist the nonce across service-worker restarts; local storage never exposes it.
  const current = await storedFrame(tabId);
  if (current && current.documentId === sender.documentId && current.sourceUrl === sourceUrl) return { tabId, session: current.session };
  const frame: FrameSession = { tabId, sourceUrl, session: crypto.randomUUID(), ...(sender.documentId ? { documentId: sender.documentId } : {}) };
  await chrome.storage.session.set({ [frameSessionKey(tabId)]: frame });
  return { tabId, session: frame.session };
}
async function updateFramePage(message: Record<string, unknown>, sender: chrome.runtime.MessageSender, sourceUrl: string) {
  const tabId = sender.tab!.id!;
  const frame = await storedFrame(tabId);
  if (!frame || frame.session !== message.session || frame.documentId !== sender.documentId) throw new Error("Reopen Margin Chat for this page.");
  await chrome.storage.session.set({ [frameSessionKey(tabId)]: { ...frame, sourceUrl } });
  return { ok: true };
}
type FramePage = "workspace.html" | "assistant.html";
function workspaceSender(sender: chrome.runtime.MessageSender, page: FramePage = "workspace.html"): URL | null {
  try {
    const url = new URL(sender.url!);
    const expected = new URL(chrome.runtime.getURL(page));
    if (url.protocol !== expected.protocol || url.host !== expected.host || url.pathname !== expected.pathname || url.hash) return null;
    return url;
  } catch { return null; }
}
async function validateFrame(message: Record<string, unknown>, sender: chrome.runtime.MessageSender, page: FramePage = "workspace.html") {
  const url = workspaceSender(sender, page);
  if (!url || !Number.isSafeInteger(message.tabId) || typeof message.session !== "string") throw new Error("Open Margin Chat using the extension toolbar.");
  const tabId = message.tabId as number;
  // A nonce copied into a different tab (or an extension popup) cannot claim the
  // source page. No window.postMessage channel can request private account data.
  if (sender.tab?.id !== tabId || sender.frameId === 0 || url.searchParams.get("tab") !== String(tabId) || url.searchParams.get("session") !== message.session) throw new Error("This workspace does not belong to this page.");
  const frame = await storedFrame(tabId);
  if (!frame || frame.session !== message.session) throw new Error("This workspace session has expired. Reopen Margin Chat.");
  const tab = await chrome.tabs.get(tabId);
  if (pageUrl(tab.url) !== frame.sourceUrl) throw new Error("The page changed. Wait a moment, then try again.");
  return frame;
}
async function workspaceMessage(message: Record<string, unknown>, sender: chrome.runtime.MessageSender) {
  const frame = await validateFrame(message, sender);
  if (message.type !== "workspace:connect" && message.type !== "workspace:context" &&
      ((message.sourceUrl !== undefined && message.sourceUrl !== frame.sourceUrl) || (message.type === "workspace:draft" && message.sourceUrl === undefined)))
    throw new Error("The page changed. Capture it again before continuing.");
  if (message.type === "workspace:connect") {
    const settings = await getSettings();
    return { tabId: frame.tabId, sourceUrl: frame.sourceUrl, connection: settings ? { connectionId: settings.connectionId, displayName: settings.displayName } : null };
  }
  if (message.type === "workspace:context") {
    if (!["current", "selection", "article", "bookmark"].includes(String(message.kind ?? "current"))) throw new Error("Unsupported page context.");
    const context = await chrome.tabs.sendMessage(frame.tabId, { type: "margin:page-context", kind: message.kind ?? "current", session: frame.session }, { frameId: 0 });
    if (context?.error) throw new Error(context.error);
    if (context?.sourceUrl !== frame.sourceUrl) throw new Error("The page changed. Capture it again before continuing.");
    return context;
  }
  if (message.type === "workspace:locate" || message.type === "workspace:highlights") {
    // Only page-derived anchor text crosses into the content script, never notes,
    // account details, document content, or AI replies.
    const payload = message.type === "workspace:locate"
      ? { anchor: normalizeAnchor(message.anchor) }
      : { anchors: Array.isArray(message.anchors) && message.anchors.length <= 1000 ? message.anchors.map(normalizeAnchor) : (() => { throw new Error("Invalid page highlights."); })() };
    return chrome.tabs.sendMessage(frame.tabId, { type: message.type === "workspace:locate" ? "margin:page-locate" : "margin:page-highlights", session: frame.session, ...payload }, { frameId: 0 });
  }
  if (message.type === "workspace:threads" || message.type === "workspace:thread-imported") {
    const settings = await requireConnection(message.connectionId);
    if (message.type === "workspace:threads") {
      // The workspace is a trusted extension origin; it receives full conversations.
      const threads = (await getThreads(settings.connectionId)).filter((thread) => !thread.importedAt || thread.openRequestId);
      return { threads: [...threads].reverse() };
    }
    const id = textValue(message.id, 100, "conversation id");
    await updateThreads(settings.connectionId, (threads) => threads.map((thread) => {
      if (thread.id !== id) return thread;
      const { openRequestId, ...rest } = thread;
      // A newer open request must survive an older import's acknowledgement.
      return { ...rest, importedAt: thread.importedAt ?? new Date().toISOString(), ...(openRequestId && openRequestId !== message.openRequestId ? { openRequestId } : {}) };
    }));
    return { ok: true };
  }
  const action = String(message.type).replace(/^workspace:/, "overlay:");
  if (!["overlay:state", "overlay:draft", "overlay:save", "overlay:retry", "overlay:dismiss", "overlay:open", "overlay:settings", "overlay:pending"].includes(action)) throw new Error("Unsupported workspace action.");
  // Read state and mutate drafts only for the account rendered by this frame.
  if (action === "overlay:state") {
    const settings = await getSettings();
    if (settings && settings.connectionId !== message.connectionId) throw new Error("The signed-in account changed. Reopen Margin Chat before continuing.");
  }
  // A queued draft retains its original URL even if the page navigates while
  // storage was being read. Check again before dispatching page mutations.
  const current = await validateFrame(message, sender);
  if (current.sourceUrl !== frame.sourceUrl) throw new Error("The page changed. Capture it again before continuing.");
  return overlayMessage({ ...message, type: action }, frame.sourceUrl);
}

async function pageMessage(tabId: number, message: Record<string, unknown>) {
  const result = await chrome.tabs.sendMessage(tabId, message, { frameId: 0 });
  if (result?.error) throw new Error(result.error);
  return result;
}
/** Tell the page which passages carry a pinned note. Delivery is best effort. */
async function syncPageNotes(frame: FrameSession, connectionId: string) {
  const notes = pageNotes(await getThreads(connectionId), frame.sourceUrl);
  await chrome.tabs.sendMessage(frame.tabId, { type: "margin:page-notes", session: frame.session, notes }, { frameId: 0 }).catch(() => undefined);
}
async function assistantMessage(message: Record<string, unknown>, sender: chrome.runtime.MessageSender) {
  const frame = await validateFrame(message, sender, "assistant.html");
  const settings = await getSettings();
  const type = String(message.type);
  if (type === "assistant:connect")
    return { tabId: frame.tabId, sourceUrl: frame.sourceUrl, connection: settings ? { connectionId: settings.connectionId, displayName: settings.displayName, ...(settings.userId ? { userId: settings.userId } : {}) } : null };
  // Everything below reads or changes the signed-in account's conversations.
  if (!settings || settings.connectionId !== message.connectionId) throw new Error("The signed-in account changed. Reopen Margin Chat before continuing.");
  const account = settings.connectionId;
  const own = async (id: unknown) => {
    const thread = (await getThreads(account)).find((item) => item.id === textValue(id, 100, "conversation id"));
    if (!thread || thread.sourceUrl !== frame.sourceUrl) throw new Error("This conversation does not belong to this page.");
    return thread;
  };
  if (type === "assistant:request")
    return pageMessage(frame.tabId, { type: "margin:page-request", session: frame.session, id: textValue(message.id, 100, "request id") });
  if (type === "assistant:article") {
    // Reading the page is optional context; the card continues without it.
    try { return await pageMessage(frame.tabId, { type: "margin:page-article", session: frame.session }); }
    catch (error) { return { unavailable: errorText(error, "The page could not be read.") }; }
  }
  if (type === "assistant:close") {
    await chrome.tabs.sendMessage(frame.tabId, { type: "margin:page-close-card", session: frame.session }, { frameId: 0 }).catch(() => undefined);
    return { ok: true };
  }
  if (type === "assistant:thread-save") {
    const thread = normalizeThread(message.thread);
    if (thread.sourceUrl !== frame.sourceUrl) throw new Error("The page changed. Ask again on the current page.");
    await updateThreads(account, (threads) => {
      const next = upsertThread(threads, thread);
      assertThreadCapacity(next);
      return next;
    });
    await syncPageNotes(frame, account);
    return { ok: true };
  }
  if (type === "assistant:thread-get") return { thread: await own(message.id) };
  if (type === "assistant:thread-pin" || type === "assistant:thread-delete") {
    const target = await own(message.id);
    await updateThreads(account, (threads) => type === "assistant:thread-delete"
      ? threads.filter((thread) => thread.id !== target.id)
      : threads.map((thread) => thread.id === target.id ? { ...thread, pinned: message.pinned === true } : thread));
    await syncPageNotes(frame, account);
    return { ok: true };
  }
  if (type === "assistant:open-workspace") {
    const target = await own(message.id);
    const openRequestId = crypto.randomUUID();
    await updateThreads(account, (threads) => threads.map((thread) => thread.id === target.id ? { ...thread, openRequestId } : thread));
    await chrome.tabs.sendMessage(frame.tabId, { type: "margin:page-open-workspace", session: frame.session }, { frameId: 0 }).catch(() => undefined);
    return { ok: true };
  }
  throw new Error("Unsupported assistant action.");
}

// A theme chosen in the workspace or settings repaints every open page shell.
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !isTheme(changes[THEME_MIRROR_KEY]?.newValue)) return;
  const theme = changes[THEME_MIRROR_KEY].newValue;
  void chrome.tabs.query({}).then((tabs) => {
    for (const tab of tabs) if (typeof tab.id === "number") chrome.tabs.sendMessage(tab.id, { type: "margin:page-theme", theme }, { frameId: 0 }).catch(() => undefined);
  });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (sender.id !== chrome.runtime.id) return;
  if (typeof message?.type === "string" && message.type.startsWith("assistant:")) {
    if (!workspaceSender(sender, "assistant.html")) return;
    void assistantMessage(message, sender).then(sendResponse).catch((error) => sendResponse({ error: errorText(error, "Margin Chat could not complete that action.") }));
    return true;
  }
  if (typeof message?.type === "string" && message.type.startsWith("workspace:")) {
    if (!workspaceSender(sender)) return;
    void workspaceMessage(message, sender).then(sendResponse).catch((error) => sendResponse({ error: errorText(error) }));
    return true;
  }
  if (typeof message?.type === "string" && message.type.startsWith("overlay:")) {
    // Only our injected, main-frame script can use the page broker. No page-window
    // message bridge or externally_connectable channel is provided.
    if (typeof sender.tab?.id !== "number" || sender.frameId !== 0) return;
    let sourceUrl: string;
    try { sourceUrl = pageUrl(sender.url); } catch { return; }
    const operation = message.type === "overlay:frame" ? registerFrame(sender, sourceUrl)
      : message.type === "overlay:page" ? updateFramePage(message, sender, sourceUrl)
      : overlayMessage(message, sourceUrl);
    void operation
      .then(sendResponse)
      .catch((error) => sendResponse({ error: errorText(error) }));
    return true;
  }
  // Preserve the popup's upload and recovery interface.
  if (sender.url !== chrome.runtime.getURL("popup.html")) return;
  if (!["save", "retry", "dismiss"].includes(message?.type)) return;
  const operation = message.type === "dismiss"
    ? dismiss()
    : save(message.capture, message.type === "retry", message.connectionId).then((receipt) => ({ receipt }));
  void operation.then(sendResponse).catch((error) => sendResponse({ error: errorText(error) }));
  return true;
});
