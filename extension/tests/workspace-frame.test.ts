import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { Window } from "happy-dom";

type Page = { title: string; sourceUrl: string; kind: string; content: string; revision: number };
const firstPage = (): Page => ({ title: "Current source", sourceUrl: "https://source.test/first", kind: "selection", content: "A selected passage", revision: 1 });
const connection = (userId = "reader") => ({ serverUrl: "https://margin.test", token: `mc_workspace_${"A".repeat(43)}`, connectionId: `margin-${userId}`, userId, displayName: userId });
const state = (draft: any = null) => ({ connected: true, page: { annotations: [], draft }, pending: null, hasOtherPending: false });
function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((done) => { resolve = done; }); return { promise, resolve }; }
async function until(check: () => boolean, reason = "Frame did not finish the action") {
  for (let index = 0; index < 500; index++) { if (check()) return; await Bun.sleep(2); }
  throw new Error(reason);
}

let script: string;
const windows: Window[] = [];
beforeAll(async () => {
  // Bundle the real frame and transport; replace only the enormous shared App
  // with a probe that records the public embedding props.
  const build = Bun.spawn([process.execPath, "--no-env-file", new URL("./helpers/build-workspace-frame.ts", import.meta.url).pathname], { stdout: "pipe", stderr: "pipe" });
  const [source, errors, exitCode] = await Promise.all([new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited]);
  if (exitCode) throw new Error(`Workspace frame build failed: ${errors}`);
  script = source;
});
afterEach(async () => { for (const browser of windows.splice(0)) await browser.happyDOM.close(); });

async function frame(options: {
  authorized?: boolean; search?: string; settings?: ReturnType<typeof connection>; draft?: any;
  respond?: (request: any, normal: () => unknown) => unknown;
  fetch?: typeof fetch;
} = {}) {
  const browser = new Window({ url: `https://extension.test/workspace.html${options.search ?? "?tab=7&session=valid-frame"}`, settings: { enableJavaScriptEvaluation: false, disableCSSFileLoading: true } });
  windows.push(browser);
  browser.document.body.innerHTML = '<div id="root"></div>';
  let settings: ReturnType<typeof connection> | null = options.settings ?? connection();
  let page = firstPage();
  let pageState = state(options.draft);
  let credentialReads = 0;
  let accessChanges = 0;
  const messages: any[] = [];
  const network: { url: string; init?: RequestInit }[] = [];
  const storageListeners = new Set<(changes: any, area: string) => void>();
  const intervals = new Map<number, () => Promise<void>>();
  let nextInterval = 1;
  const chrome = {
    runtime: {
      async sendMessage(request: any) {
        messages.push(structuredClone(request));
        const normal = () => {
          switch (request.type) {
            case "workspace:connect": return options.authorized === false ? { error: "Frame was not opened by Margin." } : { connection: { connectionId: settings?.connectionId } };
            case "workspace:context": return structuredClone(page);
            case "workspace:state": return structuredClone(pageState);
            case "workspace:highlights": case "workspace:draft": return { ok: true };
            case "workspace:save": return { receipt: { id: "saved-capture", createdAt: "2026-09-27T12:00:00.000Z" } };
            default: return { ok: true };
          }
        };
        return options.respond ? await options.respond(request, normal) : normal();
      },
      async openOptionsPage() {},
    },
    tabs: { async create() {} },
    storage: {
      local: {
        async setAccessLevel() { accessChanges++; },
        async get(key: string) { if (key === "connection") credentialReads++; return { [key]: structuredClone(settings) }; },
        async remove() { settings = null; for (const callback of storageListeners) callback({ connection: { newValue: undefined } }, "local"); },
      },
      onChanged: { addListener(callback: any) { storageListeners.add(callback); }, removeListener(callback: any) { storageListeners.delete(callback); } },
    },
  };
  const nativeFetch = (async (url: any, init?: RequestInit) => {
    network.push({ url: String(url), init });
    return options.fetch ? options.fetch(url, init) : Response.json({ user: { id: settings?.userId } });
  }) as typeof fetch;
  Object.defineProperty(browser, "fetch", { configurable: true, value: nativeFetch });
  const globals: any = {
    window: browser, document: browser.document, navigator: browser.navigator, location: browser.location,
    chrome, URL, URLSearchParams, Request, Response, Headers, AbortController, AbortSignal,
    crypto, fetch: nativeFetch, console, performance, TextEncoder, TextDecoder,
    setTimeout: browser.setTimeout.bind(browser), clearTimeout: browser.clearTimeout.bind(browser),
    setInterval(callback: any) { const id = nextInterval++; intervals.set(id, callback); return id; },
    clearInterval(id: number) { intervals.delete(id); },
  };
  for (const name of ["HTMLElement", "Element", "Node", "Text", "Event", "MouseEvent", "HTMLInputElement", "HTMLTextAreaElement", "MutationObserver"]) globals[name] = (browser as any)[name];
  runInNewContext(script, globals);
  const button = (label: string) => {
    const item = [...browser.document.querySelectorAll("button")].find((candidate) => candidate.textContent === label);
    if (!item) throw new Error(`Missing button ${label}: ${browser.document.body.textContent}`);
    return item;
  };
  return {
    browser, messages, network,
    reads: () => credentialReads, accessChanges: () => accessChanges, probe: () => globals.__frameProbe,
    async ready() { await until(() => !!browser.document.querySelector('[data-testid="shared-app"]')); },
    async click(label: string) { button(label).click(); await Bun.sleep(5); },
    async fill(value: string) {
      const input = browser.document.getElementById("source-thought") as any;
      Object.getOwnPropertyDescriptor(browser.HTMLTextAreaElement.prototype, "value")!.set!.call(input, value);
      input.dispatchEvent(new browser.Event("input", { bubbles: true }));
      await Bun.sleep(5);
    },
    async submit() { browser.document.querySelector("form")!.dispatchEvent(new browser.Event("submit", { cancelable: true, bubbles: true })); await Bun.sleep(5); },
    async poll() { await Promise.all([...intervals.values()].map((callback) => callback())); await Bun.sleep(5); },
    page(next: Page, draft: any = null) { page = next; pageState = state(draft); },
    async switchAccount(userId: string, draft: any = null) {
      settings = connection(userId); pageState = state(draft);
      for (const callback of storageListeners) callback({ connection: { newValue: settings } }, "local");
      await Bun.sleep(10);
    },
  };
}

describe("protected extension workspace frame", () => {
  test("an unauthorized or malformed frame never reads stored credentials, installs transport or renders the app", async () => {
    for (const options of [{ authorized: false }, { search: "?tab=bad&session=valid-frame" }, { search: "?tab=7" }]) {
      const view = await frame(options);
      await until(() => !!view.browser.document.querySelector("h1"));
      expect(view.reads()).toBe(0);
      expect(view.accessChanges()).toBe(0);
      expect(view.network).toHaveLength(0);
      expect(view.probe().props).toBeNull();
      expect(view.browser.document.querySelector("button")).toBeNull();
    }
  });

  test("the authorized frame renders the current shared App using the isolated API transport", async () => {
    const view = await frame(); await view.ready();
    const props = view.probe().props;
    expect(props.extension.serverUrl).toBe("https://margin.test");
    expect(typeof props.extension.onConnect).toBe("function");
    expect(typeof props.extension.onLogout).toBe("function");
    expect(typeof props.extension.openExternal).toBe("function");
    expect(props.browserCaptureRequest).toBeUndefined();
    await view.probe().apiFetch("/api/auth/session");
    expect(view.network).toHaveLength(1);
    expect(view.network[0].url).toBe("https://margin.test/api/auth/session");
    expect(new Headers(view.network[0].init?.headers).get("Authorization")).toBe(`Bearer ${connection().token}`);
    expect(view.network[0].init?.credentials).toBe("omit");
    expect(view.messages[0].type).toBe("workspace:connect");
    expect(view.messages.every((request) => request.tabId === 7 && request.session === "valid-frame")).toBe(true);
  });

  test("saving page context hands the confirmed Capture and personal comment to the existing workspace", async () => {
    const view = await frame(); await view.ready();
    await view.click("Page context"); await view.fill("My private annotation"); await view.submit();
    await until(() => !!view.probe().props.browserCaptureRequest);
    const imported = view.probe().props.browserCaptureRequest;
    expect(imported.capture).toMatchObject({ title: firstPage().title, sourceUrl: firstPage().sourceUrl, kind: "selection", content: firstPage().content, id: "saved-capture", comment: "My private annotation" });
    expect(imported.capture.schemaVersion).toBe(1);
    expect(imported.capture.createdAt).toBe("2026-09-27T12:00:00.000Z");
    expect(imported.prompt).toBeUndefined();
    expect(view.messages.find((request) => request.type === "workspace:save").capture.comment).toBe("My private annotation");
  });

  test("Ask AI hands off only the user's explicit question with the saved source", async () => {
    const view = await frame(); await view.ready();
    await view.click("Ask page"); await view.fill("How does this connect to my research?"); await view.submit();
    await until(() => !!view.probe().props.browserCaptureRequest);
    const imported = view.probe().props.browserCaptureRequest;
    expect(imported.prompt).toBe("How does this connect to my research?");
    expect(imported.capture.content).toBe(firstPage().content);
    expect(imported.capture.comment).toBe(imported.prompt);
  });

  test("switching accounts clears draft input and aborts the previous account's transport", async () => {
    const view = await frame(); await view.ready();
    await view.probe().apiFetch("/api/vault");
    const signal = view.network[0].init?.signal;
    await view.click("Ask page"); await view.fill("Private question from first account");
    await view.switchAccount("another-reader"); await view.ready();
    await until(() => view.messages.some((request) => request.type === "workspace:context" && request.connectionId === "margin-another-reader"));
    expect(signal?.aborted).toBe(true);
    expect((view.browser.document.getElementById("source-thought") as any)?.value ?? "").toBe("");
    expect(view.probe().props.browserCaptureRequest).toBeUndefined();
    expect(view.browser.document.body.textContent).not.toContain("Private question from first account");
  });

  test("page navigation replaces prior source and draft with the new page's saved context", async () => {
    const view = await frame(); await view.ready();
    await view.click("Page context"); await view.fill("Old page thought");
    view.page({ ...firstPage(), title: "New source", sourceUrl: "https://source.test/second", content: "New passage", revision: 2 });
    await view.poll();
    expect(view.browser.document.querySelector(".browser-source-name strong")?.textContent).toBe("New source");
    expect((view.browser.document.getElementById("source-thought") as any).value).toBe("");
    expect((view.browser.document.querySelector('[aria-label="Source content preview"]') as any).value).toBe("New passage");
  });

  test("a delayed context extraction cannot replace the page reached during navigation", async () => {
    const extracted = deferred<Page>();
    const view = await frame({ respond(request, normal) {
      return request.type === "workspace:context" && request.kind === "article" ? extracted.promise : normal();
    } });
    await view.ready(); await view.click("Page context"); await view.click("Readable page");
    view.page({ ...firstPage(), title: "New source", sourceUrl: "https://source.test/second", content: "New passage", revision: 2 });
    await view.poll();
    extracted.resolve({ ...firstPage(), kind: "article", content: "Late old article body" });
    await Bun.sleep(20);
    expect(view.browser.document.querySelector(".browser-source-name strong")?.textContent).toBe("New source");
    expect((view.browser.document.querySelector('[aria-label="Source content preview"]') as any).value).toBe("New passage");
  });

  test("an old save acknowledgement cannot clear the new account's draft or import its source", async () => {
    const acknowledged = deferred<any>();
    const view = await frame({ respond(request, normal) {
      return request.type === "workspace:save" ? acknowledged.promise : normal();
    } });
    await view.ready(); await view.click("Page context"); await view.fill("Old account note"); await view.submit();
    await until(() => view.messages.some((request) => request.type === "workspace:save"));
    await view.switchAccount("another-reader"); await view.ready();
    await view.click("Page context"); await view.fill("New account draft");
    acknowledged.resolve({ receipt: { id: "old-account-capture", createdAt: "2026-09-27T12:00:00.000Z" } });
    await Bun.sleep(20);
    expect((view.browser.document.getElementById("source-thought") as any).value).toBe("New account draft");
    expect(view.probe().props.browserCaptureRequest).toBeUndefined();
    expect(view.messages.some((request) => request.type === "workspace:draft" && request.draft === null)).toBe(false);
    expect(view.browser.document.querySelector('button.primary-button')?.textContent).toBe("Save & open document");
  });

  test("finishing an old account's draft cleanup cannot reset a new account's active input", async () => {
    const cleared = deferred<any>();
    const view = await frame({ respond(request, normal) {
      return request.type === "workspace:draft" && request.draft === null ? cleared.promise : normal();
    } });
    await view.ready(); await view.click("Page context"); await view.fill("Old account note"); await view.submit();
    await until(() => view.messages.some((request) => request.type === "workspace:draft" && request.draft === null));
    await view.switchAccount("another-reader"); await view.ready();
    await view.click("Page context"); await view.fill("Keep this new thought");
    cleared.resolve({ ok: true }); await Bun.sleep(20);
    expect((view.browser.document.getElementById("source-thought") as any).value).toBe("Keep this new thought");
    expect(view.probe().props.browserCaptureRequest).toBeUndefined();
    expect(view.browser.document.querySelector('button.primary-button')?.textContent).toBe("Save & open document");
  });
});
