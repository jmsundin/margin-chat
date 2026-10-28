import { afterEach, describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { bootSnapshotScript } from "../client/build/boot-snapshot.mjs";
import { forgetBootSnapshot, saveBootSnapshot } from "../client/src/lib/bootSnapshot";

const USER = { id: "user-1", email: "a@example.test" };
const STYLES = ["/assets/index-NEWHASH1.css", "/assets/WorkspaceApp-NEWHASH2.css", "/assets/KnowledgeGraphWorkspace-NEWHASH3.css"];

function page(url = "https://www.marginchat.com/app") {
  const window = new Window({ url, settings: { enableJavaScriptEvaluation: true, suppressInsecureJavaScriptEnvironmentWarning: true, disableCSSFileLoading: true } as any });
  window.document.head.innerHTML = '<link rel="stylesheet" href="/assets/index-NEWHASH1.css">';
  window.document.body.innerHTML = '<div id="root"></div>';
  return window;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

function boot(window: Window) {
  const script = window.document.createElement("script");
  script.textContent = bootSnapshotScript(STYLES);
  window.document.body.appendChild(script);
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
    expect(document.getElementById("boot-snapshot")?.textContent).toContain("Second note");
    expect([...document.querySelectorAll("link[rel=stylesheet]")].map((link) => link.getAttribute("href"))).toEqual(STYLES.slice(0, 2));
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

  test("sign-in pages, other accounts and signed-out devices get no picture", async () => {
    for (const [url, identity] of [["https://www.marginchat.com/login", USER], ["https://www.marginchat.com/try", USER],
      ["https://www.marginchat.com/app", { ...USER, id: "someone-else" }], ["https://www.marginchat.com/app", null]] as const) {
      const window = page(url);
      if (identity) window.localStorage.setItem("margin-chat-offline-identity", JSON.stringify(identity));
      window.localStorage.setItem(`margin-chat-boot-snapshot:${USER.id}`, JSON.stringify(saved));
      boot(window);
      expect(window.document.getElementById("boot-snapshot")).toBeNull();
      await window.happyDOM.abort();
    }
  });
});
