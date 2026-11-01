// What a signed-in visitor sees before the app's code has loaded and the vault is open: the last workspace this
// device showed, painted from saved HTML with a note that it is still opening, or when there is none, a splash
// screen with the app's mark and name. client/src/lib/bootSnapshot.ts saves the picture.

export const BOOT_SNAPSHOT_KEY = "margin-chat-boot-snapshot";
export const OFFLINE_IDENTITY_KEY = "margin-chat-offline-identity";

// Drawn by the page itself, so it needs no stylesheet but the one already in the page's head. The mark's three
// dots light up in turn while the app starts.
const MARK = (className) => `<svg class="${className}" viewBox="0 0 64 64" aria-hidden="true">`
  + '<path d="M14 42V26a9 9 0 0 1 18 0v16M32 26a9 9 0 0 1 18 0v16" fill="none" stroke="currentColor" stroke-width="4.5" stroke-linecap="round"/>'
  + '<circle class="boot-dot" cx="14" cy="42" r="5.5" fill="#7acaa4"/><circle class="boot-dot" cx="32" cy="42" r="5.5" fill="#c9b8ff"/>'
  + '<circle class="boot-dot" cx="50" cy="42" r="5.5" fill="#ff8d6d"/></svg>';
const STATUS = "Opening your vault\u2026";
// With no saved picture of the workspace: the app's mark and name, and what it is doing.
const splash = (status) => `<div class="boot-splash">${MARK("boot-mark")}<div class="boot-name">Margin Chat</div>`
  + (status ? `<div class="boot-status" role="status">${STATUS}</div>` : "") + "</div>";
// Over a saved picture, which can't be used yet: a small note that the workspace is still opening.
const PILL = `<div class="boot-pill" role="status">${MARK("boot-pill-mark")}<span>${STATUS}</span></div>`;

export const BOOT_SNAPSHOT_STYLE = `#boot-snapshot{position:fixed;inset:0;z-index:2147483000;overflow:hidden;pointer-events:none}
.boot-splash{position:absolute;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;gap:10px;background:var(--bg,#ece4d6);color:var(--ink,#1f2a24);font:inherit;padding-bottom:6vh}
.boot-mark{width:72px;height:72px}
.boot-name{font-size:20px;font-weight:600;letter-spacing:.01em}
.boot-status{font-size:14px;color:var(--muted,#6b7a72)}
.boot-pill{position:absolute;left:50%;bottom:calc(20px + env(safe-area-inset-bottom,0px));transform:translateX(-50%);display:flex;align-items:center;gap:8px;padding:7px 14px 7px 10px;border-radius:999px;background:var(--panel-strong,rgba(255,255,255,.96));border:1px solid var(--line,rgba(127,127,127,.2));color:var(--ink,#1f2a24);font-size:13px;white-space:nowrap;box-shadow:0 4px 18px rgba(0,0,0,.14)}
.boot-pill-mark{width:22px;height:22px;flex:none}
.boot-dot{animation:boot-dot 1.2s ease-in-out infinite}
.boot-dot:nth-of-type(2){animation-delay:.2s}
.boot-dot:nth-of-type(3){animation-delay:.4s}
@media (prefers-reduced-motion:reduce){.boot-dot{animation:none}}
@keyframes boot-dot{0%,60%,100%{opacity:1}30%{opacity:.25}}`;

/**
 * Runs inline in index.html. `styles` lists this build's stylesheets, so a snapshot saved by an older
 * build still finds the current file for each stylesheet it used (file names change with every build).
 */
export function bootSnapshotScript(styles) {
  return `(function () {
  var root = document.documentElement;
  try {
    var theme = localStorage.getItem("margin-chat-theme");
    root.dataset.theme = theme === "light" || theme === "dark" ? theme
      : matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  } catch (error) { /* The app sets the theme when it starts. */ }
  try {
    var path = location.pathname.replace(/\\/+$/, "") || "/";
    // Only the workspace opens from this device's saved account; other pages wait for the server.
    if (location.protocol !== "margin:" && (/^\\/(pricing|download|connect|terms|privacy|login|signup|try|oauth)(\\/|$)/.test(path)
      || /[?&]reset_token=/.test(location.search))) return;
    var user = null;
    try { user = JSON.parse(localStorage.getItem(${JSON.stringify(OFFLINE_IDENTITY_KEY)}) || "null"); } catch (error) { user = null; }
    if (!user || typeof user.id !== "string") user = null;
    // The home page shows the website to visitors; it opens the workspace only for a saved account.
    if (!user && path === "/" && !location.search) return;
    var saved = null;
    if (user) try { saved = JSON.parse(localStorage.getItem(${JSON.stringify(BOOT_SNAPSHOT_KEY)} + ":" + user.id) || "null"); } catch (error) { saved = null; }
    if (!saved || typeof saved.html !== "string" || !Array.isArray(saved.styles)) saved = null;
    var view = document.createElement("div");
    view.id = "boot-snapshot";
    view.setAttribute("aria-hidden", "true");
    view.innerHTML = user ? ${JSON.stringify(splash(true))} : ${JSON.stringify(splash(false))};
    document.body.appendChild(view);
    if (saved) {
      // The picture replaces the splash screen once the stylesheets it needs have arrived, never unstyled.
      var waiting = 1;
      var failed = false;
      var arrived = function (event) {
        if (event && event.type === "error") failed = true;
        if (--waiting === 0 && !failed && view.parentNode) view.innerHTML = saved.html + ${JSON.stringify(PILL)};
      };
      var styles = ${JSON.stringify(styles)};
      var linked = {};
      var links = document.querySelectorAll('link[rel="stylesheet"]');
      for (var i = 0; i < links.length; i++) linked[links[i].getAttribute("href")] = true;
      for (var j = 0; j < styles.length; j++) {
        var stem = styles[j].replace(/^.*\\//, "").replace(/-[A-Za-z0-9_-]{8}\\.css$/, "");
        if (linked[styles[j]] || saved.styles.indexOf(stem) < 0) continue;
        var link = document.createElement("link");
        link.rel = "stylesheet";
        link.href = styles[j];
        link.onload = link.onerror = arrived;
        waiting++;
        document.head.appendChild(link);
      }
      arrived();
    }
    var app = document.getElementById("root");
    var observer;
    var done = function () {
      if (observer) observer.disconnect();
      clearTimeout(timer);
      if (view.parentNode) view.parentNode.removeChild(view);
    };
    // The picture goes as soon as the app shows anything other than its empty starting shell: the
    // workspace once its documents are read, or a sign-in or error screen.
    var settled = function () {
      if (!app || !app.firstElementChild) return false;
      return !app.querySelector(".app-shell[aria-busy]");
    };
    var timer = setTimeout(done, 30000);
    observer = new MutationObserver(function () { if (settled()) done(); });
    if (app) observer.observe(app, { subtree: true, childList: true, attributes: true, attributeFilter: ["class", "aria-busy"] });
  } catch (error) {
    var stale = document.getElementById("boot-snapshot");
    if (stale && stale.parentNode) stale.parentNode.removeChild(stale);
  }
})();`;
}

export function bootSnapshotPlugin() {
  return {
    name: "marginchat-boot-snapshot",
    transformIndexHtml: {
      order: "post",
      handler(_html, context) {
        const styles = Object.keys(context.bundle ?? {}).filter((name) => name.endsWith(".css")).map((name) => `/${name}`).sort();
        // src/main.tsx starts the app (src/start.tsx) only after the first picture is drawn; its code downloads meanwhile.
        const start = Object.values(context.bundle ?? {}).find((item) => item.type === "chunk" && item.isDynamicEntry
          && item.moduleIds.some((id) => /[\\/]src[\\/]start\.tsx$/u.test(id)));
        return [
          ...(start ? [{ tag: "link", attrs: { rel: "modulepreload", crossorigin: "", href: `/${start.fileName}` }, injectTo: "head" }] : []),
          { tag: "style", children: BOOT_SNAPSHOT_STYLE, injectTo: "head" },
          { tag: "script", children: bootSnapshotScript(styles), injectTo: "body" },
        ];
      },
    },
  };
}
