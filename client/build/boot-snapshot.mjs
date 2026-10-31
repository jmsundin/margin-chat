// What a signed-in visitor sees before the app's code has loaded: the last workspace this device showed,
// painted from saved HTML, or when there is none, an outline of the workspace (header, sidebar and lines
// standing in for a document). client/src/lib/bootSnapshot.ts saves the picture.

export const BOOT_SNAPSHOT_KEY = "margin-chat-boot-snapshot";
export const OFFLINE_IDENTITY_KEY = "margin-chat-offline-identity";

// Drawn by the page itself, so it needs no stylesheet but the one already in the page's head.
const OUTLINE = `<div class="boot-outline">
<div class="boot-outline-bar"><i class="boot-outline-button"></i><i class="boot-outline-search"></i><i class="boot-outline-button"></i><i class="boot-outline-button"></i></div>
<div class="boot-outline-body">
<div class="boot-outline-side">${'<i class="boot-outline-line"></i>'.repeat(8)}</div>
<div class="boot-outline-page"><i class="boot-outline-title"></i>${'<i class="boot-outline-line"></i>'.repeat(9)}</div>
</div></div>`;

export const BOOT_SNAPSHOT_STYLE = `#boot-snapshot{position:fixed;inset:0;z-index:2147483000;overflow:hidden;pointer-events:none}
.boot-outline{position:absolute;inset:0;display:flex;flex-direction:column;background:var(--bg,#ece4d6)}
.boot-outline i{display:block;border-radius:8px;background:var(--line,rgba(127,127,127,.14));animation:boot-outline-pulse 1.4s ease-in-out infinite}
.boot-outline-bar{display:flex;gap:8px;align-items:center;padding:8px 10px;flex:none}
.boot-outline-button{width:36px;height:36px;flex:none}
.boot-outline-search{height:36px;flex:1;max-width:420px}
.boot-outline-body{display:flex;flex:1;min-height:0}
.boot-outline-side{display:none;width:260px;padding:16px 12px;flex:none}
.boot-outline-side .boot-outline-line{margin:0 0 14px;width:80%}
.boot-outline-page{flex:1;max-width:760px;margin:0 auto;padding:28px 20px}
.boot-outline-title{height:30px;width:55%;margin:0 0 26px}
.boot-outline-line{height:14px;margin:0 0 14px}
.boot-outline-line:nth-child(3n){width:88%}
.boot-outline-line:nth-child(4n){width:72%}
@media (min-width:900px){.boot-outline-side{display:block}}
@media (prefers-reduced-motion:reduce){.boot-outline i{animation:none}}
@keyframes boot-outline-pulse{50%{opacity:.45}}`;

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
    view.innerHTML = ${JSON.stringify(OUTLINE)};
    document.body.appendChild(view);
    if (saved) {
      // The picture replaces the outline once the stylesheets it needs have arrived, never unstyled.
      var waiting = 1;
      var failed = false;
      var arrived = function (event) {
        if (event && event.type === "error") failed = true;
        if (--waiting === 0 && !failed && view.parentNode) view.innerHTML = saved.html;
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
