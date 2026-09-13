import {
  CAPTURE_LIMITS,
  escapeMarkdown,
  normalizeCapture,
  type CaptureInput,
  type CaptureKind,
} from "@margin-chat/capture-contracts";
import {
  getPending,
  getSettings,
  trustedStorage,
  type ConnectionSettings,
  type SelectionDraft,
} from "./storage";
import { errorText } from "./network";
const el = <T extends HTMLElement>(id: string) =>
  document.getElementById(id) as T;
const title = el<HTMLInputElement>("title");
const content = el<HTMLTextAreaElement>("content");
const comment = el<HTMLTextAreaElement>("comment");
const status = el("status");
let settings: ConnectionSettings | null = null;
let tab: chrome.tabs.Tab | undefined;
let selectionDraft: SelectionDraft | undefined;
let sourceUrl = "";
let kind: CaptureKind = "selection";
let readSequence = 0;
let sending = false;
function show(section: string) {
  for (const id of ["connect", "clip", "pending"])
    el(id).hidden = id !== section;
}
function report(message: string, error = false) {
  status.textContent = message;
  status.className = error ? "error" : "";
}
async function showPending() {
  const pending = await getPending();
  if (!pending) return false;
  show("pending");
  el("pending-heading").textContent = pending.receipt
    ? "Saved to your Inbox."
    : "Capture kept here";
  el("pending-title").textContent = pending.capture.title;
  const sameConnection = settings?.connectionId === pending.connectionId;
  el("pending-description").textContent = pending.receipt
    ? "Your source link and note are saved with the capture."
    : sameConnection
      ? "If the connection was interrupted, retrying checks the same save without creating a duplicate."
      : "This draft belongs to a previous connection. Reconnect that account or start a new capture.";
  el<HTMLButtonElement>("retry").hidden =
    Boolean(pending.receipt) || !sameConnection;
  el<HTMLButtonElement>("new").textContent = pending.receipt
    ? "Capture this page"
    : "Dismiss draft";
  el<HTMLButtonElement>("open-inbox").hidden =
    !pending.receipt || !sameConnection;
  report(pending.error ?? "", Boolean(pending.error));
  return true;
}
async function readPage(nextKind: CaptureKind) {
  const sequence = ++readSequence;
  kind = nextKind;
  content.value = "";
  el<HTMLButtonElement>("save").disabled = true;
  report("Reading page…");
  document
    .querySelectorAll<HTMLButtonElement>("[data-kind]")
    .forEach((button) =>
      button.setAttribute("aria-pressed", String(button.dataset.kind === kind)),
    );
  content.hidden = kind === "bookmark";
  el("content-label").hidden = kind === "bookmark";
  try {
    let pageUrl = selectionDraft?.sourceUrl ?? tab?.url ?? "";
    if (!/^https?:\/\//u.test(pageUrl))
      throw new Error(
        "Open a regular web page to capture it. Browser settings and extension pages cannot be clipped.",
      );
    let extracted: {
      title: string;
      content: string;
      error?: string;
      sourceUrl?: string;
    } = {
      title: selectionDraft?.title ?? tab?.title ?? "Untitled page",
      content: "",
    };
    if (nextKind === "selection" && selectionDraft)
      extracted.content = escapeMarkdown(selectionDraft.text);
    else if (nextKind !== "bookmark") {
      if (!tab?.id)
        throw new Error("Open the clipper from the web page you want to save.");
      await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        files: ["content.js"],
      });
      const results = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: (captureKind: CaptureKind) =>
          (
            globalThis as unknown as {
              marginExtract: (kind: CaptureKind) => unknown;
            }
          ).marginExtract(captureKind),
        args: [nextKind],
      });
      extracted = results[0]?.result as typeof extracted;
      if (!extracted)
        throw new Error("Unable to read this page. Try saving a bookmark.");
      if (extracted.error) throw new Error(extracted.error);
      pageUrl = extracted.sourceUrl ?? pageUrl;
    }
    if (sequence !== readSequence) return;
    sourceUrl = pageUrl;
    if (extracted.content.length > CAPTURE_LIMITS.content)
      throw new Error(
        "This capture is too large. Highlight a shorter passage.",
      );
    title.value = extracted.title.slice(0, CAPTURE_LIMITS.title);
    content.value = extracted.content;
    el("source").textContent = sourceUrl;
    el("source").title = sourceUrl;
    el<HTMLButtonElement>("save").disabled = false;
    report("");
  } catch (error) {
    if (sequence === readSequence) report(errorText(error), true);
  }
}
async function initialize() {
  await trustedStorage();
  settings = await getSettings();
  if (!settings) {
    show("connect");
    return;
  }
  if (await showPending()) return;
  const session = await chrome.storage.session.get("selectionDraft");
  selectionDraft = session.selectionDraft as SelectionDraft | undefined;
  await chrome.storage.session.remove("selectionDraft");
  [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!selectionDraft && tab?.id && /^https?:\/\//u.test(tab.url ?? "")) {
    try {
      const [result] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => ({
          text: window.getSelection()?.toString() ?? "",
          sourceUrl: location.href,
          title: document.title,
        }),
      });
      if (result?.result?.text?.trim()) {
        selectionDraft = result.result;
      }
    } catch {
      /* The article reader presents the supported-page error below. */
    }
  }
  show("clip");
  el("destination").textContent = `Cloud Inbox · ${settings.displayName}`;
  await readPage(selectionDraft ? "selection" : "article");
}
async function send(type: "save" | "retry", capture?: CaptureInput) {
  if (sending) return;
  sending = true;
  el<HTMLButtonElement>("save").disabled = true;
  el<HTMLButtonElement>("retry").disabled = true;
  el<HTMLButtonElement>("new").disabled = true;
  report("Saving to your Cloud Inbox…");
  try {
    const result = await chrome.runtime.sendMessage({ type, capture });
    await showPending();
    if (result?.error) report(result.error, true);
  } catch (error) {
    await showPending();
    report(errorText(error), true);
  } finally {
    sending = false;
    el<HTMLButtonElement>("save").disabled = false;
    el<HTMLButtonElement>("retry").disabled = false;
    el<HTMLButtonElement>("new").disabled = false;
  }
}
for (const id of ["settings", "connect-button"])
  el(id).addEventListener("click", () => void chrome.runtime.openOptionsPage());
document
  .querySelectorAll<HTMLButtonElement>("[data-kind]")
  .forEach((button) =>
    button.addEventListener(
      "click",
      () => void readPage(button.dataset.kind as CaptureKind),
    ),
  );
el("capture-form").addEventListener("submit", (event) => {
  event.preventDefault();
  try {
    const capture = normalizeCapture({
      schemaVersion: 1,
      clientCaptureId: crypto.randomUUID(),
      kind,
      title: title.value,
      content: content.value,
      comment: comment.value,
      sourceUrl,
      capturedAt: new Date().toISOString(),
    });
    void send("save", capture);
  } catch (error) {
    report(errorText(error), true);
  }
});
el("retry").addEventListener("click", () => void send("retry"));
el("new").addEventListener("click", async () => {
  const result = await chrome.runtime.sendMessage({ type: "dismiss" });
  if (result?.error) {
    report(result.error, true);
    return;
  }
  comment.value = "";
  await initialize();
});
el("open-inbox").addEventListener("click", () => {
  if (settings)
    void chrome.tabs.create({ url: `${settings.serverUrl}/?inbox=1` });
});
void initialize().catch((error) => report(errorText(error), true));
