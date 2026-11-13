import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { installUpdateProtocol } from "./worker-update-protocol.mjs";

const PUBLIC_FILES = ["/favicon.svg", "/icon.svg", "/manifest.webmanifest"];
// Excalidraw's Chinese, Japanese and Korean handwriting font is ~200 files and 13 MB, half of every update's
// download. Drawings fetch the few pieces they use from the network when they first show those characters.
const ON_DEMAND = /^\/excalidraw\/fonts\/Xiaolai\//u;

export function renderOfflineServiceWorker({ version, files, html }) {
  return `// Generated with the exact HTML and asset list for this build.
const CACHE_PREFIX = 'marginchat-app-shell-';
const CACHE_NAME = CACHE_PREFIX + ${JSON.stringify(version)};
const SHELL_FILES = ${JSON.stringify(files)};
const SHELL_PATHS = new Set(SHELL_FILES);
const SHELL_HTML = ${JSON.stringify(html)};
(${installUpdateProtocol.toString()})(self);

// Safari's Cache Storage can fail or never answer (storage pressure, a damaged cache). A
// worker that waits on it forever leaves the page white, so every cache step has a limit and
// falls back to the network.
const CACHE_WAIT_MS = 4000;
const INSTALL_WAIT_MS = 300000;
const within = (promise, ms) => {
  let timer;
  const limit = new Promise((resolve, reject) => { timer = setTimeout(() => reject(new Error('Cache Storage did not answer')), ms); });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
};

self.addEventListener('install', (event) => {
  event.waitUntil(within(precache(), INSTALL_WAIT_MS).catch(async (error) => {
    // Without a working cache this worker still installs and takes over at once, so a worker
    // stuck on a broken cache is replaced by one that loads the app from the network.
    console.warn('Offline copy unavailable; loading Margin Chat from the network.', error);
    try { await within(caches.delete(CACHE_NAME), CACHE_WAIT_MS); } catch { /* Nothing more to clean up. */ }
    await self.skipWaiting();
  }));
  // Wait by default. Restart now activates only after all open tabs are ready.
});

async function precache() {
  const cache = await caches.open(CACHE_NAME);
  // Build assets are named by their content, so a file an earlier build
  // already cached is copied instead of downloaded again. Most of a
  // deploy's 16 MB is unchanged libraries.
  const earlier = [];
  for (const name of await caches.keys()) {
    if (name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME) earlier.push(await caches.open(name));
  }
  const download = [];
  await Promise.all(SHELL_FILES.filter((path) => path !== '/index.html').map(async (path) => {
    if (path.startsWith('/assets/') && /-[A-Za-z0-9_-]{8,}\\.[^/]+$/.test(path)) {
      for (const old of earlier) {
        const hit = await old.match(path);
        if (hit) { await cache.put(path, hit); return; }
      }
    }
    download.push(path);
  }));
  await cache.addAll(download.map((path) => new Request(path, { cache: 'reload' })));
  // Embed this build's HTML so a deployment during installation cannot pair
  // newer HTML with the previous build's precached JavaScript.
  await cache.put('/index.html', new Response(SHELL_HTML, {
    headers: { 'Content-Type': 'text/html; charset=utf-8' }
  }));
}

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const clients = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    // Retain old chunks through a coordinated restart (and any new-tab race).
    // A later activation without live pages can safely reclaim old generations.
    if (!clients.length) {
      try {
        await within((async () => {
          const names = await caches.keys();
          await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
            .map((name) => caches.delete(name)));
        })(), CACHE_WAIT_MS);
      } catch { /* Old copies are reclaimed on a later activation. */ }
    }
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url = new URL(request.url);
  // Authentication, vault content, attachments, and all other API traffic are
  // handled only by the app's local vault and server, never this shared cache.
  if (request.method !== 'GET' || url.origin !== self.location.origin ||
      url.pathname === '/api' || url.pathname.startsWith('/api/')) return;
  const isNavigation = request.mode === 'navigate';
  const isOldChunk = url.pathname.startsWith('/assets/') && /-[A-Za-z0-9_-]{8,}\\.[^/]+$/.test(url.pathname);
  if (!isNavigation && !SHELL_PATHS.has(url.pathname) && !isOldChunk) return;
  const fromCache = async () => {
    const cache = await caches.open(CACHE_NAME);
    // HTML and all build assets come from the same generation, including online.
    // A new build is used only when its fully installed worker activates.
    const cached = await cache.match(isNavigation ? '/index.html' : url.pathname);
    if (cached) return cached;
    if (isOldChunk) {
      for (const name of await caches.keys()) {
        if (!name.startsWith(CACHE_PREFIX) || name === CACHE_NAME) continue;
        const old = await (await caches.open(name)).match(url.pathname);
        if (old) return old;
      }
    }
    return null;
  };
  event.respondWith((async () => {
    // A cache that fails or hangs must never block the page: go to the network instead.
    let cached = null;
    try { cached = await within(fromCache(), CACHE_WAIT_MS); } catch { cached = null; }
    return cached || fetch(request);
  })());
});
`;
}

export function offlineAppShellPlugin() {
  return {
    name: "marginchat-offline-app-shell",
    apply: "build",
    enforce: "post",
    generateBundle(_options, bundle) {
      const files = Object.keys(bundle)
        .filter((name) => !name.endsWith(".map"))
        .map((name) => `/${name}`)
        .filter((path) => !ON_DEMAND.test(path))
        .concat(PUBLIC_FILES)
        .sort();
      const digest = createHash("sha256");
      for (const name of Object.keys(bundle).sort()) {
        const entry = bundle[name];
        digest.update(name);
        digest.update(entry.type === "chunk" ? entry.code : entry.source);
      }
      // Public artwork/manifest edits must also invalidate the shell cache.
      for (const pathname of PUBLIC_FILES) {
        digest.update(readFileSync(new URL(`../public${pathname}`, import.meta.url)));
      }
      this.emitFile({
        type: "asset",
        fileName: "sw.js",
        source: renderOfflineServiceWorker({
          version: digest.digest("hex").slice(0, 16),
          files,
          html: String(bundle["index.html"].source),
        }),
      });
    },
  };
}
