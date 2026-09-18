import {
  CAPTURE_API_PATH,
  normalizeCapture,
  parseCaptureReceipt,
} from "@margin-chat/capture-contracts";
import {
  getPending,
  getSettings,
  trustedStorage,
  type PendingSave,
} from "./storage";
import { captureRequest, errorText } from "./network";

void trustedStorage();
chrome.runtime.onInstalled.addListener(() => {
  void chrome.contextMenus.removeAll().then(() =>
    chrome.contextMenus.create({
      id: "save-selection",
      title: "Save selection to Margin",
      contexts: ["selection"],
      documentUrlPatterns: ["http://*/*", "https://*/*"],
    }),
  );
});
chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== "save-selection" || !tab) return;
  void chrome.storage.session
    .set({
      selectionDraft: {
        text: info.selectionText ?? "",
        sourceUrl: info.frameUrl ?? info.pageUrl ?? tab.url ?? "",
        title: tab.title ?? "Saved passage",
      },
    })
    .then(async () => {
      try {
        await chrome.action.openPopup({ windowId: tab.windowId });
      } catch {
        await chrome.tabs.create({ url: chrome.runtime.getURL("popup.html") });
      }
    });
});

let saving = false;
async function save(input: unknown, retry: boolean, expectedConnection: unknown) {
  if (saving)
    throw new Error(
      "A capture is already being saved. Reopen the popup to check its status.",
    );
  saving = true;
  try {
    await trustedStorage();
    const settings = await getSettings();
    if (!settings)
      throw new Error("Sign in to your account in extension settings first.");
    if (expectedConnection !== settings.connectionId)
      throw new Error("The signed-in account changed. Reopen the popup before saving.");
    let pending: PendingSave | null = await getPending();
    if (retry) {
      if (!pending) throw new Error("There is no saved draft to retry.");
      if (pending.connectionId !== settings.connectionId)
        throw new Error(
          "This draft belongs to a previous connection. Start a new capture for this account.",
        );
      if (pending.receipt) return pending.receipt;
    } else {
      if (pending && !pending.receipt)
        throw new Error(
          "Retry or dismiss the previous capture before saving another.",
        );
      pending = {
        capture: normalizeCapture(input),
        connectionId: settings.connectionId,
      };
    }
    // Persist before sending. A closed popup, interrupted worker, or lost response is retryable.
    await chrome.storage.local.set({ pendingSave: pending });
    try {
      const result = await captureRequest(
        settings,
        CAPTURE_API_PATH,
        parseCaptureReceipt,
        pending.capture,
      );
      await chrome.storage.local.set({
        pendingSave: { ...pending, receipt: result.capture, error: undefined },
      });
      return result.capture;
    } catch (error) {
      await chrome.storage.local.set({
        pendingSave: { ...pending, error: errorText(error) },
      });
      throw error;
    }
  } finally {
    saving = false;
  }
}

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  // Only our own popup can initiate uploads; content scripts and web pages cannot.
  if (
    sender.id !== chrome.runtime.id ||
    sender.url !== chrome.runtime.getURL("popup.html")
  )
    return;
  if (
    message?.type !== "save" &&
    message?.type !== "retry" &&
    message?.type !== "dismiss"
  )
    return;
  if (message.type === "dismiss") {
    if (saving) {
      sendResponse({ error: "Wait for the current save to finish." });
      return;
    }
    void chrome.storage.local
      .remove("pendingSave")
      .then(() => sendResponse({ ok: true }));
  } else {
    void save(message.capture, message.type === "retry", message.connectionId)
      .then((receipt) => sendResponse({ receipt }))
      .catch((error) => sendResponse({ error: errorText(error) }));
  }
  return true;
});
