import { createSelectionAssistant } from "./selection-assistant";
import { createWorkspaceFrameHost } from "./workspace-frame-host";

const isolated = globalThis as unknown as {
  marginOverlay?: ReturnType<typeof createWorkspaceFrameHost>;
};
// Private notes and AI conversations live in extension-origin frames.
if (!isolated.marginOverlay) {
  const send = (message: Record<string, unknown>) => chrome.runtime.sendMessage(message);
  const overlay = createWorkspaceFrameHost(document, send, chrome.runtime.getURL("workspace.html"));
  isolated.marginOverlay = overlay;
  // Injecting the script arms the page: selecting text offers Explain and Ask,
  // even while the workspace panel is closed.
  const assistant = createSelectionAssistant(document, send, {
    frameUrl: chrome.runtime.getURL("assistant.html"),
    register: overlay.register,
    openWorkspace: () => overlay.open(),
  });
  assistant.arm();
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || typeof message?.type !== "string" || !message.type.startsWith("margin:page-")) return;
    const handled = assistant.owns(message.type) ? assistant.handleMessage(message) : overlay.handleMessage(message);
    void handled.then(sendResponse).catch((error) => sendResponse({ error: error instanceof Error ? error.message : "Unable to read this page." }));
    return true;
  });
}
