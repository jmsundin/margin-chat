import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { bootSnapshotPlugin, bootSnapshotScript } from "../client/build/boot-snapshot.mjs";
import { forgetBootSnapshot, saveBootSnapshot } from "../client/src/lib/bootSnapshot";

const USER = { id: "user-1", email: "a@example.test" };
const STYLES = ["/assets/index-NEWHASH1.css", "/assets/WorkspaceApp-NEWHASH2.css", "/assets/KnowledgeGraphWorkspace-NEWHASH3.css"];

// Stylesheets aren't fetched; each one the page adds counts as arrived, or with `failing`, as failed.
function page(url = "https://www.marginchat.com/app", failing = false) {
  const window = new Window({ url, settings: { disableCSSFileLoading: true, handleDisabledFileLoadingAsSuccess: !failing } });
  window.document.head.innerHTML = '<link rel="stylesheet" href="/assets/index-NEWHASH1.css">';
  window.document.body.innerHTML = '<div id="root"></div>';
  return window;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

// Runs index.html's inline script against the test page's globals, as the browser would.
function boot(window: Window) {
  const globals = { window, document: window.document, localStorage: window.localStorage, location: window.location,
    matchMedia: window.matchMedia.bind(window), MutationObserver: window.MutationObserver,
    setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window) };
  new Function(...Object.keys(globals), bootSnapshotScript(STYLES))(...Object.values(globals));
}

const saved = { html: '<div class="app-shell"><main class="workspace-content" id="workspace-main"><h1 data-document-id="doc-1">Second note</h1><div role="menu">Rename</div></main></div>', styles: ["index", "WorkspaceApp"] };
const original = { document: globalThis.document, localStorage: globalThis.localStorage };
afterEach(() => Object.assign(globalThis, original));

describe("workspace picture at startup", () => {
  test("saves the open workspace without scripts, canvases, session-only images, toasts or overlong lists", () => {
    const window = page();
    Object.assign(globalThis, { document: window.document, localStorage: window.localStorage });
    window.document.head.innerHTML += '<link rel="stylesheet" href="/assets/WorkspaceApp-OLDHASH2.css">';
    const items = Array.from({ length: 200 }, (_, index) => `<li>Note ${index}</li>`).join("");
    window.document.getElementById("root")!.innerHTML = `<div class="app-shell"><ul class="thread-list">${items}</ul>
      <main class="workspace-content"><h1>Second note</h1><canvas></canvas><img src="blob:https://x/1"><img src="/icon.svg"><script>1</script></main>
      <div class="workspace-notifications"><p>Update ready</p></div></div>`;
    saveBootSnapshot(USER.id);
    const stored = JSON.parse(window.localStorage.getItem(`margin-chat-boot-snapshot:${USER.id}`)!);
    expect(stored.styles).toEqual(["index", "WorkspaceApp"]);
    expect(stored.html).toContain("Second note");
    expect(stored.html).toContain("/icon.svg");
    for (const gone of ["<canvas", "blob:", "<script", "Update ready", "workspace-notifications", "Note 120", "Rename", "id=", "data-document-id"]) expect(stored.html).not.toContain(gone);
    expect(stored.html).toContain("Note 119");
    forgetBootSnapshot(USER.id);
    expect(window.localStorage.getItem(`margin-chat-boot-snapshot:${USER.id}`)).toBeNull();
  });

  test("nothing is saved while the documents are still being read", () => {
    const window = page();
    Object.assign(globalThis, { document: window.document, localStorage: window.localStorage });
    window.localStorage.setItem(`margin-chat-boot-snapshot:${USER.id}`, JSON.stringify(saved));
    window.document.getElementById("root")!.innerHTML = '<div class="app-shell is-vault-opening" aria-busy="true"></div>';
    saveBootSnapshot(USER.id);
    expect(window.localStorage.getItem(`margin-chat-boot-snapshot:${USER.id}`)).toBeNull();
  });

  test("index.html paints the saved workspace with this build's stylesheets until the app shows its own", async () => {
    const window = page();
    window.localStorage.setItem("margin-chat-offline-identity", JSON.stringify(USER));
    window.localStorage.setItem("margin-chat-theme", "light");
    window.localStorage.setItem(`margin-chat-boot-snapshot:${USER.id}`, JSON.stringify(saved));
    boot(window);
    const { document } = window;
    expect(document.documentElement.dataset.theme).toBe("light");
    const links = [...document.querySelectorAll("link[rel=stylesheet]")];
    expect(links.map((link) => link.getAttribute("href"))).toEqual(STYLES.slice(0, 2));
    await settle();
    expect(document.getElementById("boot-snapshot")?.textContent).toContain("Second note");
    const root = document.getElementById("root")!;
    // The empty starting shell, then the workspace while its documents are read: the picture stays.
    root.innerHTML = '<div class="app-shell" aria-busy="true"></div>';
    await settle();
    expect(document.getElementById("boot-snapshot")).not.toBeNull();
    root.innerHTML = '<div class="app-shell is-vault-opening" aria-busy="true"><main class="workspace-content"></main></div>';
    await settle();
    expect(document.getElementById("boot-snapshot")).not.toBeNull();
    root.firstElementChild!.removeAttribute("aria-busy");
    await settle();
    expect(document.getElementById("boot-snapshot")).toBeNull();
    await window.happyDOM.abort();
  });

  test("a stylesheet that can't be loaded keeps the outline instead of an unstyled picture", async () => {
    const window = page(undefined, true);
    window.localStorage.setItem("margin-chat-offline-identity", JSON.stringify(USER));
    window.localStorage.setItem(`margin-chat-boot-snapshot:${USER.id}`, JSON.stringify(saved));
    boot(window);
    await settle();
    expect(window.document.querySelector("#boot-snapshot .boot-outline")).not.toBeNull();
    expect(window.document.getElementById("boot-snapshot")?.textContent).not.toContain("Second note");
    await window.happyDOM.abort();
  });

  test("sign-in, trial and website pages get nothing; the website's home page waits for a saved account", async () => {
    for (const [url, identity] of [["https://www.marginchat.com/login", USER], ["https://www.marginchat.com/try", USER],
      ["https://www.marginchat.com/pricing", USER], ["https://www.marginchat.com/", null]] as const) {
      const window = page(url);
      if (identity) window.localStorage.setItem("margin-chat-offline-identity", JSON.stringify(identity));
      window.localStorage.setItem(`margin-chat-boot-snapshot:${USER.id}`, JSON.stringify(saved));
      boot(window);
      expect(window.document.getElementById("boot-snapshot")).toBeNull();
      await window.happyDOM.abort();
    }
  });

  test("without a saved picture, an outline of the workspace shows at once", async () => {
    for (const [url, identity] of [["https://www.marginchat.com/", { ...USER, id: "user-2" }], ["https://www.marginchat.com/app", null],
      ["https://www.marginchat.com/app", { ...USER, id: "someone-else" }]] as const) {
      const window = page(url);
      if (identity) window.localStorage.setItem("margin-chat-offline-identity", JSON.stringify(identity));
      // Another account's picture is never shown.
      window.localStorage.setItem(`margin-chat-boot-snapshot:${USER.id}`, JSON.stringify(saved));
      boot(window);
      const view = window.document.getElementById("boot-snapshot")!;
      expect(view.querySelector(".boot-outline-bar")).not.toBeNull();
      expect(view.textContent).not.toContain("Second note");
      // A sign-in or "checking your session" screen replaces it.
      window.document.getElementById("root")!.innerHTML = '<div class="app-shell"><div class="auth-chrome"></div></div>';
      await settle();
      expect(window.document.getElementById("boot-snapshot")).toBeNull();
      await window.happyDOM.abort();
    }
  });

  test("a workspace too big to save whole is saved with less of each list", () => {
    const window = page();
    Object.assign(globalThis, { document: window.document, localStorage: window.localStorage });
    const paragraph = `<p>${"word ".repeat(1000)}</p>`;
    window.document.getElementById("root")!.innerHTML = `<div class="app-shell"><main class="workspace-content">${paragraph.repeat(125)}</main></div>`;
    saveBootSnapshot(USER.id);
    const stored = JSON.parse(window.localStorage.getItem(`margin-chat-boot-snapshot:${USER.id}`)!);
    expect(stored.html.length).toBeLessThan(600_000);
    expect(stored.html.split("<p>").length - 1).toBe(30);
  });
});

test("the page fetches the app's code while it draws the first picture, which the app starts after", () => {
  const bundle = {
    "assets/index-AAAAAAAA.js": { type: "chunk", isEntry: true, isDynamicEntry: false, moduleIds: ["/repo/client/src/main.tsx"], fileName: "assets/index-AAAAAAAA.js" },
    "assets/start-BBBBBBBB.js": { type: "chunk", isEntry: false, isDynamicEntry: true, moduleIds: ["/repo/client/src/start.tsx", "/repo/client/src/App.tsx"], fileName: "assets/start-BBBBBBBB.js" },
    "assets/index-CCCCCCCC.css": { type: "asset", fileName: "assets/index-CCCCCCCC.css" },
  };
  const tags = (bootSnapshotPlugin().transformIndexHtml as any).handler("", { bundle });
  expect(tags[0]).toEqual({ tag: "link", attrs: { rel: "modulepreload", crossorigin: "", href: "/assets/start-BBBBBBBB.js" }, injectTo: "head" });
  expect(tags.map((tag: any) => tag.tag)).toEqual(["link", "style", "script"]);
});
