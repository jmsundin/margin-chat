import { createWorkspaceFrameHost } from "./workspace-frame-host";

const isolated = globalThis as unknown as {
  marginOverlay?: ReturnType<typeof createWorkspaceFrameHost>;
};
// Private notes and AI conversations live in an extension-origin frame.
if (!isolated.marginOverlay) {
  const overlay = createWorkspaceFrameHost(document, (message) => chrome.runtime.sendMessage(message), chrome.runtime.getURL("workspace.html"));
  isolated.marginOverlay = overlay;
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || typeof message?.type !== "string" || !message.type.startsWith("margin:page-")) return;
    void overlay.handleMessage(message).then(sendResponse).catch((error) => sendResponse({ error: error instanceof Error ? error.message : "Unable to read this page." }));
    return true;
  });
}
