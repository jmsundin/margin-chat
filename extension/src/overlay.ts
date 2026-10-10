import { createSelectionAssistant } from "./selection-assistant";
import { createWorkspaceFrameHost } from "./workspace-frame-host";

const isolated = globalThis as unknown as {
  marginOverlay?: ReturnType<typeof createWorkspaceFrameHost>;
};
// Private notes and AI conversations live in extension-origin frames.
if (!isolated.marginOverlay) {
  const send = (message: Record<string, unknown>) => chrome.runtime.sendMessage(message);
  const overlay = createWorkspaceFrameHost(document, send, chrome.runtime.getURL("workspace.html"), {
    onDockResize: (width) => { void send({ type: "overlay:dock-width", width }).catch(() => undefined); },
  });
  isolated.marginOverlay = overlay;
  // Injecting the script arms the page: selecting text offers Explain and Ask,
  // even while the workspace panel is closed.
  const assistant = createSelectionAssistant(document, send, {
    frameUrl: chrome.runtime.getURL("assistant.html"),
    register: overlay.register,
    openWorkspace: () => overlay.open(),
  });
  assistant.arm();
  // Theme and dock width are display preferences; the page never sees account data.
  const applyTheme = (theme: unknown) => { overlay.setTheme(theme); assistant.setTheme(theme); };
  void send({ type: "overlay:preferences" }).then((prefs) => {
    applyTheme(prefs?.theme);
    if (typeof prefs?.dockWidth === "number") overlay.setDockWidth(prefs.dockWidth);
  }).catch(() => undefined);
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || typeof message?.type !== "string" || !message.type.startsWith("margin:page-")) return;
    if (message.type === "margin:page-theme") { applyTheme(message.theme); sendResponse({ ok: true }); return; }
    const handled = assistant.owns(message.type) ? assistant.handleMessage(message) : overlay.handleMessage(message);
    void handled.then(sendResponse).catch((error) => sendResponse({ error: error instanceof Error ? error.message : "Unable to read this page." }));
    return true;
  });
}
