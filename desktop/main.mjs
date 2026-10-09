import { app, BrowserWindow, net, protocol, session, shell } from "electron";
import { stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

// The packaged app serves the built web client from margin://app and forwards
// /api to the hosted backend, so the client keeps its same-origin relative fetches.
const SCHEME = "margin";
const APP_ORIGIN = `${SCHEME}://app`;
const API_ORIGIN = new URL(
  process.env.MARGIN_DESKTOP_API_URL?.trim() || "https://www.marginchat.com",
).origin;
// Development loads the Vite dev server, which already proxies /api to the local server.
const DEV_URL = process.env.MARGIN_DESKTOP_DEV_URL?.trim() || null;
const CLIENT_DIR = path.resolve(
  app.isPackaged
    ? path.join(process.resourcesPath, "client")
    : fileURLToPath(new URL("../dist/", import.meta.url)),
);
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

  const filePath = path.join(CLIENT_DIR, pathname);
  if (filePath.startsWith(CLIENT_DIR + path.sep) && (await isFile(filePath))) {
    return net.fetch(pathToFileURL(filePath).toString());
  }

  // Mirror the Vercel rewrite: unknown paths are client routes.
  return net.fetch(pathToFileURL(path.join(CLIENT_DIR, "index.html")).toString());
}

function handleAppRequest(request) {
  const url = new URL(request.url);
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

  app.whenReady().then(() => {
    protocol.handle(SCHEME, handleAppRequest);

    // Grant only what the vault and editor use, and only to the app itself.
    const allowed = new Set(["fileSystem", "clipboard-read", "clipboard-sanitized-write"]);
    session.defaultSession.setPermissionRequestHandler((webContents, permission, callback) => {
      callback(allowed.has(permission) && isAppUrl(webContents.getURL()));
    });

    createWindow();

    app.on("activate", () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on("window-all-closed", () => {
    if (process.platform !== "darwin") app.quit();
  });
}
