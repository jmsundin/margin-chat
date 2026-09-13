import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const PUBLIC_FILES = ["/favicon.svg", "/icon.svg", "/manifest.webmanifest"];

export function renderOfflineServiceWorker({ version, files, html }) {
  return `// Generated with the exact HTML and asset list for this build.
const CACHE_PREFIX = 'marginchat-app-shell-';
const CACHE_NAME = CACHE_PREFIX + ${JSON.stringify(version)};
const SHELL_FILES = ${JSON.stringify(files)};
const SHELL_PATHS = new Set(SHELL_FILES);
const SHELL_HTML = ${JSON.stringify(html)};

self.addEventListener('install', (event) => {
  event.waitUntil((async () => {
    const cache = await caches.open(CACHE_NAME);
    await cache.addAll(SHELL_FILES.filter((path) => path !== '/index.html')
      .map((path) => new Request(path, { cache: 'reload' })));
    // Embed this build's HTML so a deployment during installation cannot pair
    // newer HTML with the previous build's precached JavaScript.
    await cache.put('/index.html', new Response(SHELL_HTML, {
      headers: { 'Content-Type': 'text/html; charset=utf-8' }
    }));
  })());
  // Do not skipWaiting: an open tab must retain the worker/assets it loaded.
});

self.addEventListener('activate', (event) => {
  event.waitUntil((async () => {
    const names = await caches.keys();
    await Promise.all(names.filter((name) => name.startsWith(CACHE_PREFIX) && name !== CACHE_NAME)
      .map((name) => caches.delete(name)));
    // Existing uncontrolled pages keep their original assets until navigation.
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
  if (!isNavigation && !SHELL_PATHS.has(url.pathname)) return;
  event.respondWith((async () => {
    const cache = await caches.open(CACHE_NAME);
    // HTML and all build assets come from the same generation, including online.
    // A new build is used only when its fully installed worker activates.
    const cached = await cache.match(isNavigation ? '/index.html' : url.pathname);
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
