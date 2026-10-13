import { app, BrowserWindow, dialog, Menu, net, protocol, session, shell } from "electron";
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { createClientBundles } from "./clientBundles.mjs";
import { createShellUpdater, DEFAULT_FEED } from "./shellUpdater.mjs";

// The packaged app serves the built web client from margin://app and forwards
// /api to the hosted backend, so the client keeps its same-origin relative fetches.
const SCHEME = "margin";
const APP_ORIGIN = `${SCHEME}://app`;
const API_ORIGIN = new URL(
  process.env.MARGIN_DESKTOP_API_URL?.trim() || "https://www.marginchat.com",
).origin;
// Development loads the Vite dev server, which already proxies /api to the local server.
const DEV_URL = process.env.MARGIN_DESKTOP_DEV_URL?.trim() || null;
const BUNDLED_CLIENT_DIR = path.resolve(
  app.isPackaged
    ? path.join(process.resourcesPath, "client")
    : fileURLToPath(new URL("../dist/", import.meta.url)),
);
// Newer clients downloaded from the website live beside the app's own data.
const clientBundles = createClientBundles({
  root: path.join(app.getPath("userData"), "client-bundles"),
  bundledDir: BUNDLED_CLIENT_DIR,
  origin: API_ORIGIN,
  fetchImpl: (url, init) => net.fetch(String(url), init),
});
const CLIENT_UPDATE_INTERVAL = 15 * 60 * 1000;
// New versions of the app itself come from the latest Desktop release on GitHub.
const shellUpdater = createShellUpdater({
  currentVersion: app.getVersion(),
  feedUrl: process.env.MARGIN_DESKTOP_UPDATE_FEED?.trim() || DEFAULT_FEED,
  downloadsDir: path.join(app.getPath("userData"), "app-updates"),
  fetchImpl: (url, init) => net.fetch(String(url), init),
});
const SHELL_UPDATE_INTERVAL = 4 * 60 * 60 * 1000;
// The page opens this path once it has saved its edits for an app update.
const INSTALL_UPDATE_PATH = "/__margin/install-update";
// Where "Download update" sends people: the download page picks this system's installer.
const DOWNLOAD_URL = process.env.MARGIN_DESKTOP_DOWNLOAD_URL?.trim() || "https://www.marginchat.com/download";
const PROXIED_PREFIXES = ["/api/", "/_vercel/"];
// Request headers that describe the margin:// page rather than the backend request.
const DROPPED_REQUEST_HEADERS = ["host", "origin", "referer", "cookie"];

protocol.registerSchemesAsPrivileged([
  {
    scheme: SCHEME,
    privileges: {
      standard: true,
      secure: true,
      supportFetchAPI: true,
      corsEnabled: true,
      stream: true,
      codeCache: true,
    },
  },
]);

function isProxiedPath(pathname) {
  return pathname === "/api" || PROXIED_PREFIXES.some((prefix) => pathname.startsWith(prefix));
}

async function forwardToBackend(request, url) {
  const headers = new Headers(request.headers);
  for (const name of DROPPED_REQUEST_HEADERS) headers.delete(name);
  const hasBody = request.method !== "GET" && request.method !== "HEAD";

  // net.fetch uses the default session's cookie jar, so the HttpOnly auth cookie
  // lives under the backend's domain and never reaches the renderer.
  const response = await net.fetch(new URL(url.pathname + url.search, API_ORIGIN), {
    method: request.method,
    headers,
    body: hasBody ? request.body : undefined,
    duplex: hasBody ? "half" : undefined,
    credentials: "include",
  });
  const responseHeaders = new Headers(response.headers);
  responseHeaders.delete("set-cookie");
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: responseHeaders,
  });
}

async function isFile(filePath) {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function serveClientFile(url) {
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return new Response("Bad request", { status: 400 });
  }

  // The newest client first; older ones still serve chunks a page loaded before
  // an update asks for.
  const dirs = clientBundles.dirs();
  for (const dir of dirs) {
    const filePath = path.join(dir, pathname);
    if (filePath.startsWith(dir + path.sep) && (await isFile(filePath))) {
      return net.fetch(pathToFileURL(filePath).toString());
    }
  }

  // Mirror the Vercel rewrite: unknown paths are client routes.
  return net.fetch(pathToFileURL(path.join(dirs[0], "index.html")).toString());
}

function handleAppRequest(request) {
  const url = new URL(request.url);
  if (url.pathname === INSTALL_UPDATE_PATH) return installShellUpdateNow();
  return isProxiedPath(url.pathname) ? forwardToBackend(request, url) : serveClientFile(url);
}

function isAppUrl(rawUrl) {
  try {
    const url = new URL(rawUrl);
    // Node gives custom schemes an opaque "null" origin, so match margin://app by parts.
    if (url.protocol === `${SCHEME}:`) return url.host === "app";
    return DEV_URL !== null && url.origin === new URL(DEV_URL).origin;
  } catch {
    return false;
  }
}

function openExternally(rawUrl) {
  if (/^(https?|mailto):/i.test(rawUrl)) void shell.openExternal(rawUrl);
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 720,
    minHeight: 480,
    title: "Margin Chat",
    backgroundColor: "#ffffff",
    show: false,
    webPreferences: {
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
    },
  });

  window.once("ready-to-show", () => window.show());

  // Links to other sites (billing, sources, docs) open in the default browser.
  window.webContents.setWindowOpenHandler(({ url }) => {
    if (!isAppUrl(url)) openExternally(url);
    return { action: "deny" };
  });
  window.webContents.on("will-navigate", (event, url) => {
    if (isAppUrl(url)) return;
    event.preventDefault();
    openExternally(url);
  });

  void window.loadURL(DEV_URL ?? `${APP_ORIGIN}/`);
  return window;
}

// Mirrors client/src/lib/workspaceViewShortcuts.ts; the page handles the switch.
const WORKSPACE_VIEWS = [
  { mode: "chat", label: "Document View", accelerator: "CmdOrCtrl+Shift+D" },
  { mode: "tiles", label: "Tile View", accelerator: "CmdOrCtrl+Shift+L" },
  { mode: "graph", label: "Map View", accelerator: "CmdOrCtrl+G" },
];

function showWorkspaceView(window, mode) {
  void window?.webContents.executeJavaScript(
    `window.dispatchEvent(new CustomEvent("margin:set-view", { detail: ${JSON.stringify(mode)} }))`,
  );
}

function buildAppMenu() {
  const isMac = process.platform === "darwin";
  const template = [
    ...(isMac ? [{ role: "appMenu" }] : []),
    { role: "fileMenu" },
    { role: "editMenu" },
    {
      label: "View",
      submenu: [
        ...WORKSPACE_VIEWS.map(({ mode, label, accelerator }) => ({
          label,
          accelerator,
          click: (_item, window) => showWorkspaceView(window, mode),
        })),
        { type: "separator" },
        { role: "reload" },
        { role: "forceReload" },
        { role: "toggleDevTools" },
        { type: "separator" },
        { role: "resetZoom" },
        { role: "zoomIn" },
        { role: "zoomOut" },
        { type: "separator" },
        { role: "togglefullscreen" },
      ],
    },
    { role: "windowMenu" },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

// The page restarts into the update by itself at a quiet moment, after saving
// edits (client/src/components/AppUpdateNotice.tsx).
function announceUpdate(detail) {
  for (const window of BrowserWindow.getAllWindows()) {
    void window.webContents.executeJavaScript(
      `window.dispatchEvent(new CustomEvent("margin:desktop-update-ready", { detail: ${JSON.stringify(detail)} }))`,
    ).catch(() => {});
  }
}
const announceClientUpdate = (version) => announceUpdate({ kind: "client", commit: version.commit });

function startClientUpdates() {
  let running = null;
  const check = () => (running ??= clientBundles.update()
    .then((version) => { if (version) announceClientUpdate(version); })
    .catch((error) => console.warn("Client update failed; trying again later.", error))
    .finally(() => { running = null; }));
  void check();
  setInterval(check, CLIENT_UPDATE_INTERVAL);
  // A window coming back into view is a good moment to look again.
  app.on("browser-window-focus", () => { void check(); });
}

let quittingForUpdate = false;
function installShellUpdateNow() {
  if (!shellUpdater.install({ relaunch: true })) return new Response("No update is ready.", { status: 409 });
  quittingForUpdate = true;
  setImmediate(() => app.quit());
  return new Response("Installing the update…", { headers: { "Content-Type": "text/plain; charset=utf-8" } });
}

// New versions of the app itself download in the background and install when
// the page restarts at a quiet moment, or when the person quits.
function startShellUpdates() {
  let offeredManual = null;
  let running = null;
  const check = () => (running ??= shellUpdater.check()
    .then(async (update) => {
      if (!update) return;
      if (!update.manual) {
        announceUpdate({ kind: "app", version: update.version });
        return;
      }
      // A .deb install or an app run from the disk image can't replace itself.
      if (offeredManual === update.version) return;
      offeredManual = update.version;
      const window = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
      const options = {
        type: "info",
        buttons: ["Download", "Later"],
        defaultId: 0,
        cancelId: 1,
        message: "A new desktop app is available",
        detail: process.platform === "darwin"
          ? `Margin Chat ${update.version} is out. Move Margin Chat to your Applications folder and it will install updates by itself from then on.`
          : `Margin Chat ${update.version} is out. This copy was installed in a way it can't update by itself, so download the new version once.`,
      };
      const { response } = window ? await dialog.showMessageBox(window, options) : await dialog.showMessageBox(options);
      if (response === 0) openExternally(DOWNLOAD_URL);
    })
    .catch((error) => console.warn("App update check failed; trying again later.", error))
    .finally(() => { running = null; }));
  setTimeout(check, 30 * 1000);
  setInterval(check, SHELL_UPDATE_INTERVAL);
  // Quitting installs a downloaded update, so the next launch is the new version.
  app.on("before-quit", () => {
    if (!quittingForUpdate) shellUpdater.install({ relaunch: false });
  });
}

// Two windows writing the same vault folder race each other, so keep one instance.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on("second-instance", () => {
    const [window] = BrowserWindow.getAllWindows();
    if (!window) return;
    if (window.isMinimized()) window.restore();
    window.focus();
  });

  app.whenReady().then(async () => {
    // Serve the newest client already on disk; a broken download falls back to the installed one.
    if (!DEV_URL) await clientBundles.load().catch((error) => console.warn("Using the installed client.", error));
    protocol.handle(SCHEME, handleAppRequest);

    // Grant only what the vault, editor and voice typing use, and only to the app itself.
    const allowed = new Set(["fileSystem", "clipboard-read", "clipboard-sanitized-write"]);
    const microphoneOnly = (permission, details) => permission === "media" &&
      Array.isArray(details?.mediaTypes) && details.mediaTypes.length > 0 && details.mediaTypes.every((type) => type === "audio");
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback, details) => {
      callback((allowed.has(permission) || microphoneOnly(permission, details)) && isAppUrl(webContents.getURL()));
    });

    buildAppMenu();
    createWindow();
    // The dev server is always current, so only bundled builds check.
    if (!DEV_URL) {
      startClientUpdates();
      startShellUpdates();
    }

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
