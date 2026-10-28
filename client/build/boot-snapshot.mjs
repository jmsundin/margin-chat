// The last workspace this device showed, painted from saved HTML before the app's code has loaded,
// so opening the app shows the workspace instead of a blank screen. client/src/lib/bootSnapshot.ts saves it.

export const BOOT_SNAPSHOT_KEY = "margin-chat-boot-snapshot";
export const OFFLINE_IDENTITY_KEY = "margin-chat-offline-identity";

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
    var user = JSON.parse(localStorage.getItem(${JSON.stringify(OFFLINE_IDENTITY_KEY)}) || "null");
    if (!user || typeof user.id !== "string") return;
    var saved = JSON.parse(localStorage.getItem(${JSON.stringify(BOOT_SNAPSHOT_KEY)} + ":" + user.id) || "null");
    if (!saved || typeof saved.html !== "string" || !Array.isArray(saved.styles)) return;
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
      document.head.appendChild(link);
    }
    var view = document.createElement("div");
    view.id = "boot-snapshot";
    view.setAttribute("aria-hidden", "true");
    view.innerHTML = saved.html;
    document.body.appendChild(view);
    var app = document.getElementById("root");
    var observer;
    var done = function () {
      if (observer) observer.disconnect();
      clearTimeout(timer);
      if (view.parentNode) view.parentNode.removeChild(view);
    };
    // The snapshot goes as soon as the app shows anything other than its empty starting shell: the
    // workspace once its documents are read, or a sign-in or error screen.
    var settled = function () {
      if (!app || !app.firstElementChild) return false;
      var busy = app.querySelector(".app-shell[aria-busy]");
      return !busy;
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

const BOOT_SNAPSHOT_STYLE = "#boot-snapshot{position:fixed;inset:0;z-index:2147483000;overflow:hidden;pointer-events:none}";

export function bootSnapshotPlugin() {
  return {
    name: "marginchat-boot-snapshot",
    transformIndexHtml: {
      order: "post",
      handler(_html, context) {
        const styles = Object.keys(context.bundle ?? {}).filter((name) => name.endsWith(".css")).map((name) => `/${name}`).sort();
        return [
          { tag: "style", children: BOOT_SNAPSHOT_STYLE, injectTo: "head" },
          { tag: "script", children: bootSnapshotScript(styles), injectTo: "body" },
        ];
      },
    },
  };
}
