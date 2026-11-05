import { describe, expect, test } from "bun:test";
import { Window } from "happy-dom";
import { bootSnapshotPlugin, bootSnapshotScript } from "../client/build/boot-snapshot.mjs";

const USER = { id: "user-1", email: "a@example.test" };

function page(url = "https://www.marginchat.com/app") {
  const window = new Window({ url });
  window.document.body.innerHTML = '<div id="root"></div>';
  return window;
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 10));

// Runs index.html's inline script against the test page's globals, as the browser would.
function boot(window: Window) {
  const globals = { window, document: window.document, localStorage: window.localStorage, location: window.location,
    matchMedia: window.matchMedia.bind(window), MutationObserver: window.MutationObserver,
    setTimeout: window.setTimeout.bind(window), clearTimeout: window.clearTimeout.bind(window) };
  new Function(...Object.keys(globals), bootSnapshotScript())(...Object.values(globals));
}

describe("splash screen at startup", () => {
  test("every open shows the Margin Chat splash, saying the vault is opening, until the workspace can be used", async () => {
    for (const url of ["https://www.marginchat.com/app", "https://www.marginchat.com/"]) {
      const window = page(url);
      window.localStorage.setItem("margin-chat-offline-identity", JSON.stringify(USER));
      window.localStorage.setItem("margin-chat-theme", "light");
      boot(window);
      const { document } = window;
      expect(document.documentElement.dataset.theme).toBe("light");
      const view = document.getElementById("boot-snapshot")!;
      expect(view.querySelector(".boot-splash .boot-mark")).not.toBeNull();
      expect(view.textContent).toBe("Margin ChatOpening your vault\u2026");
      const root = document.getElementById("root")!;
      // The empty starting shell, then the workspace while its documents are read: the splash stays.
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
    }
  });

  test("pictures of the workspace saved by earlier versions are cleared and never shown", async () => {
    const window = page();
    window.localStorage.setItem("margin-chat-offline-identity", JSON.stringify(USER));
    window.localStorage.setItem(`margin-chat-boot-snapshot:${USER.id}`, JSON.stringify({ html: "<h1>Second note</h1>", styles: [] }));
    window.localStorage.setItem("margin-chat-boot-snapshot:someone-else", "{}");
    window.localStorage.setItem("margin-chat-theme", "dark");
    boot(window);
    expect(window.document.getElementById("boot-snapshot")?.textContent).not.toContain("Second note");
    expect(Object.keys(window.localStorage).filter((key) => key.startsWith("margin-chat-boot-snapshot"))).toEqual([]);
    expect(window.localStorage.getItem("margin-chat-theme")).toBe("dark");
    await window.happyDOM.abort();
  });

  test("sign-in, trial and website pages get nothing; the website's home page waits for a saved account", async () => {
    for (const [url, identity] of [["https://www.marginchat.com/login", USER], ["https://www.marginchat.com/try", USER],
      ["https://www.marginchat.com/pricing", USER], ["https://www.marginchat.com/", null]] as const) {
      const window = page(url);
      if (identity) window.localStorage.setItem("margin-chat-offline-identity", JSON.stringify(identity));
      boot(window);
      expect(window.document.getElementById("boot-snapshot")).toBeNull();
      await window.happyDOM.abort();
    }
  });

  test("without a saved account the workspace page shows the mark and name only, until the sign-in screen", async () => {
    const window = page();
    boot(window);
    const view = window.document.getElementById("boot-snapshot")!;
    expect(view.textContent).toBe("Margin Chat");
    window.document.getElementById("root")!.innerHTML = '<div class="app-shell"><div class="auth-chrome"></div></div>';
    await settle();
    expect(window.document.getElementById("boot-snapshot")).toBeNull();
    await window.happyDOM.abort();
  });
});

test("the page fetches the app's code while it draws the splash screen, which the app starts after", () => {
  const bundle = {
    "assets/index-AAAAAAAA.js": { type: "chunk", isEntry: true, isDynamicEntry: false, moduleIds: ["/repo/client/src/main.tsx"], fileName: "assets/index-AAAAAAAA.js" },
    "assets/start-BBBBBBBB.js": { type: "chunk", isEntry: false, isDynamicEntry: true, moduleIds: ["/repo/client/src/start.tsx", "/repo/client/src/App.tsx"], fileName: "assets/start-BBBBBBBB.js" },
    "assets/index-CCCCCCCC.css": { type: "asset", fileName: "assets/index-CCCCCCCC.css" },
  };
  const tags = (bootSnapshotPlugin().transformIndexHtml as any).handler("", { bundle });
  expect(tags[0]).toEqual({ tag: "link", attrs: { rel: "modulepreload", crossorigin: "", href: "/assets/start-BBBBBBBB.js" }, injectTo: "head" });
  expect(tags.map((tag: any) => tag.tag)).toEqual(["link", "style", "script"]);
});
