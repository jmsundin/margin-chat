import { expect, test } from "bun:test";
import { findDeepLink, pathForDeepLink, pathForWebsiteLink } from "../desktop/deepLinks.mjs";
import {
  claimAutoOpen, desktopAppLink, launchDesktopApp, readDesktopPreference, saveDesktopPreference, shouldOfferDesktopApp,
} from "../client/src/lib/desktopHandoff";

const computer = { platform: "mac" as const, inDesktopApp: false, inExtension: false, search: "", hasInstaller: true };

test("only browsers on a computer with a published installer are offered the desktop app", () => {
  expect(shouldOfferDesktopApp(computer)).toBe(true);
  expect(shouldOfferDesktopApp({ ...computer, platform: "windows" })).toBe(true);
  expect(shouldOfferDesktopApp({ ...computer, platform: "linux" })).toBe(true);
  // Phones, tablets and Chromebooks keep the web app with nothing in the way.
  for (const platform of ["ios", "android", "chromeos", "unknown"] as const) {
    expect(shouldOfferDesktopApp({ ...computer, platform })).toBe(false);
  }
  expect(shouldOfferDesktopApp({ ...computer, inDesktopApp: true })).toBe(false);
  expect(shouldOfferDesktopApp({ ...computer, inExtension: true })).toBe(false);
  expect(shouldOfferDesktopApp({ ...computer, hasInstaller: false })).toBe(false);
  // Stripe returns, password resets and capture handoffs finish in the browser that started them.
  expect(shouldOfferDesktopApp({ ...computer, search: "?checkout=success&session_id=cs_1" })).toBe(false);
  expect(shouldOfferDesktopApp({ ...computer, search: "?reset_token=abc" })).toBe(false);
});

test("the website's link opens the app at the same page", () => {
  expect(desktopAppLink("/")).toBe("marginchat://open");
  expect(desktopAppLink("/maps/jon")).toBe("marginchat://open?path=%2Fmaps%2Fjon");
  expect(desktopAppLink("//evil.example")).toBe("marginchat://open");
  expect(pathForDeepLink(desktopAppLink("/maps/jon"))).toBe("/maps/jon");
});

test("the desktop app follows marginchat:// links only to its own pages", () => {
  expect(pathForDeepLink("marginchat://open")).toBe("/");
  expect(pathForDeepLink("marginchat://open?path=%2Fmaps%2Fjon")).toBe("/maps/jon");
  expect(pathForDeepLink("marginchat://open?path=//evil.example")).toBe("/");
  expect(pathForDeepLink("marginchat://open?path=https://evil.example")).toBe("/");
  // Marketing and sign-up pages stay on the website.
  expect(pathForDeepLink("marginchat://open?path=%2Fpricing")).toBe("/");
  expect(pathForDeepLink("https://www.marginchat.com/")).toBeNull();
  expect(pathForDeepLink("not a url")).toBeNull();
});

test("links to the website's app pages open inside the desktop app", () => {
  expect(pathForWebsiteLink("https://www.marginchat.com/")).toBe("/");
  expect(pathForWebsiteLink("https://marginchat.com/maps/jon/")).toBe("/maps/jon");
  expect(pathForWebsiteLink("https://www.marginchat.com/pricing")).toBeNull();
  expect(pathForWebsiteLink("https://www.marginchat.com/download")).toBeNull();
  expect(pathForWebsiteLink("https://www.marginchat.com/?reset_token=abc")).toBeNull();
  expect(pathForWebsiteLink("http://www.marginchat.com/")).toBeNull();
  expect(pathForWebsiteLink("https://marginchat.com.evil.example/")).toBeNull();
  expect(pathForWebsiteLink("https://en.wikipedia.org/wiki/Margin")).toBeNull();
});

test("Windows and Linux pass the launching link on the command line", () => {
  expect(findDeepLink(["/opt/Margin Chat/margin-chat", "--no-sandbox", "marginchat://open?path=%2Fx"])).toBe("marginchat://open?path=%2Fx");
  expect(findDeepLink(["C:\\Margin Chat.exe", "MarginChat://open"])).toBe("MarginChat://open");
  expect(findDeepLink(["/opt/Margin Chat/margin-chat"])).toBeNull();
});

function memoryStore() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => { values.set(key, value); },
    removeItem: (key: string) => { values.delete(key); },
  };
}

test("the browser remembers whether this computer uses the app or the browser", () => {
  const store = memoryStore();
  expect(readDesktopPreference(store)).toBeNull();
  saveDesktopPreference("app", store);
  expect(readDesktopPreference(store)).toBe("app");
  saveDesktopPreference("web", store);
  expect(readDesktopPreference(store)).toBe("web");
  saveDesktopPreference(null, store);
  expect(readDesktopPreference(store)).toBeNull();
  const refusing = { getItem() { throw new Error("denied"); }, setItem() { throw new Error("denied"); }, removeItem() { throw new Error("denied"); } };
  expect(readDesktopPreference(refusing)).toBeNull();
  expect(() => saveDesktopPreference("app", refusing)).not.toThrow();
});

test("the app opens by itself once per browser session", () => {
  const session = memoryStore();
  expect(claimAutoOpen(session)).toBe(true);
  expect(claimAutoOpen(session)).toBe(false);
  expect(claimAutoOpen(null)).toBe(false);
});

function fakeWindow() {
  const listeners = new Map<string, Set<() => void>>();
  const on = (type: string, listener: () => void) => { (listeners.get(type) ?? listeners.set(type, new Set()).get(type)!).add(listener); };
  const off = (type: string, listener: () => void) => { listeners.get(type)?.delete(listener); };
  const fire = (type: string) => { for (const listener of [...(listeners.get(type) ?? [])]) listener(); };
  const timers: (() => void)[] = [];
  const state = { focused: true, visibility: "visible", assigned: [] as string[] };
  const target = {
    addEventListener: on,
    removeEventListener: off,
    setTimeout: (callback: () => void) => timers.push(callback),
    clearTimeout: () => {},
    location: { assign: (url: string) => { state.assigned.push(url); } },
    document: {
      addEventListener: (type: string, listener: () => void) => on(`document:${type}`, listener),
      removeEventListener: (type: string, listener: () => void) => off(`document:${type}`, listener),
      hasFocus: () => state.focused,
      get visibilityState() { return state.visibility; },
    },
  };
  return { target: target as unknown as Window, state, fire, timers, listeners };
}

test("opening the app counts as opened when the page loses focus", async () => {
  const page = fakeWindow();
  const watch = launchDesktopApp("marginchat://open", { target: page.target });
  expect(page.state.assigned).toEqual(["marginchat://open"]);
  page.state.focused = false;
  page.fire("blur");
  expect(await watch.done).toBe(true);
  expect([...page.listeners.values()].every((set) => set.size === 0)).toBe(true);
});

test("an app that never comes forward counts as not opened", async () => {
  const page = fakeWindow();
  const watch = launchDesktopApp("marginchat://open", { target: page.target });
  page.timers[0]!();
  expect(await watch.done).toBe(false);
  const cancelled = launchDesktopApp("marginchat://open", { target: page.target });
  cancelled.cancel();
  expect(await cancelled.done).toBe(false);
});
