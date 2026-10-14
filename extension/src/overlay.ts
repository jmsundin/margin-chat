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
    onHeaderCollapse: (collapsed) => { void send({ type: "overlay:header-collapsed", collapsed }).catch(() => undefined); },
    onLayoutChange: (layout) => { void send({ type: "overlay:layout", layout }).catch(() => undefined); },
    // If Chrome refuses its side panel here, bring the page panel back rather than leave nothing open.
    // Some extensions (1Password among them) swallow the click Chrome needs, so point to the button inside the workspace.
    onSidePanel: () => {
      const refused = () => { void overlay.open().then(() => overlay.notify("Chrome didn't open its side panel from this menu. Click Side by side at the top of the workspace instead.")); };
      void send({ type: "overlay:side-panel" }).then((result) => { if (result?.error) refused(); }, refused);
    },
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
  // Theme, layout, dock width and the collapsed header are display preferences; the page never sees account data.
  const applyTheme = (theme: unknown) => { overlay.setTheme(theme); assistant.setTheme(theme); };
  void send({ type: "overlay:preferences" }).then((prefs) => {
    applyTheme(prefs?.theme);
    if (typeof prefs?.dockWidth === "number") overlay.setDockWidth(prefs.dockWidth);
    if (prefs?.headerCollapsed === true) overlay.setHeaderCollapsed(true);
    if (prefs?.layout) overlay.setLayout(prefs.layout);
  }).catch(() => undefined);
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (sender.id !== chrome.runtime.id || typeof message?.type !== "string" || !message.type.startsWith("margin:page-")) return;
    if (message.type === "margin:page-theme") { applyTheme(message.theme); sendResponse({ ok: true }); return; }
    const handled = assistant.owns(message.type) ? assistant.handleMessage(message) : overlay.handleMessage(message);
    void handled.then(sendResponse).catch((error) => sendResponse({ error: error instanceof Error ? error.message : "Unable to read this page." }));
    return true;
  });
}
