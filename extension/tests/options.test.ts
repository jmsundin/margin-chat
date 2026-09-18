import { afterEach, beforeAll, describe, expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { Window } from "happy-dom";
import { connectionIdentity } from "../src/storage";

let optionsScript: string;
let optionsHtml: string;
const windows: Window[] = [];
beforeAll(async () => {
  // Isolate the bundler from Bun's shared module cache after other extension bundles run.
  const build = Bun.spawn([process.execPath, "build", new URL("../src/options.ts", import.meta.url).pathname, "--target=browser", "--format=iife"], { stdout: "pipe", stderr: "pipe" });
  const [source, errors, exitCode] = await Promise.all([
    new Response(build.stdout).text(), new Response(build.stderr).text(), build.exited,
  ]);
  if (exitCode) throw new Error(`Options build failed: ${errors}`);
  optionsScript = source;
  optionsHtml = await Bun.file(new URL("../public/options.html", import.meta.url)).text();
});
afterEach(async () => { for (const window of windows.splice(0)) await window.happyDOM.close(); });
const response = (userId = "reader", suffix = "A") => ({
  token: `mc_extension_${suffix.repeat(43)}`,
  user: { id: userId, displayName: "Reader", email: `${userId}@example.test` },
  expiresAt: new Date(Date.now() + 86400_000).toISOString(),
});
async function until(check: () => boolean) {
  for (let i = 0; i < 500; i++) { if (check()) return; await Bun.sleep(2); }
  throw new Error("Options did not finish the action");
}
async function createOptions(fetchImpl: typeof fetch, storage: Record<string, any> = {}, allowed = true) {
  const window = new Window({ settings: { enableJavaScriptEvaluation: false, disableCSSFileLoading: true } });
  windows.push(window);
  window.document.write(optionsHtml.replace(/<script[\s\S]*?<\/script>/g, ""));
  const requested: string[] = [];
  const removed: string[] = [];
  let accessLevel: string;
  runInNewContext(optionsScript, {
    document: window.document, URL, AbortSignal, Error, TypeError,
    fetch: fetchImpl,
    chrome: {
      storage: { local: {
        async setAccessLevel(value: { accessLevel: string }) { accessLevel = value.accessLevel; },
        async get(key: string) { return { [key]: structuredClone(storage[key]) }; },
        async set(value: object) { Object.assign(storage, structuredClone(value)); },
        async remove(key: string) { delete storage[key]; },
      } },
      permissions: {
        async request({ origins }: { origins: string[] }) { requested.push(...origins); return allowed; },
        async remove({ origins }: { origins: string[] }) { removed.push(...origins); return true; },
      },
    },
  });
  await Bun.sleep(0);
  const element = (id: string) => window.document.getElementById(id)!;
  const input = (id: string) => element(id) as unknown as HTMLInputElement;
  return {
    storage, requested, removed, element, input, accessLevel: () => accessLevel,
    async login(email = "reader@example.test", server = "https://margin.example") {
      input("server-url").value = server;
      input("email").value = email;
      input("password").value = " my account password ";
      element("connection-form").dispatchEvent(new window.Event("submit", { cancelable: true }));
      await until(() => !input("connect").disabled);
    },
    async logout() {
      element("disconnect").click();
      await until(() => !input("disconnect").disabled);
    },
  };
}

describe("extension password sign-in", () => {
  test("requests access before sending credentials, stores only a scoped session, and clears the password", async () => {
    let app: Awaited<ReturnType<typeof createOptions>>;
    app = await createOptions((async (url, init) => {
      expect(app.requested).toEqual(["https://margin.example/*"]);
      expect(String(url)).toBe("https://margin.example/api/v1/extension-session");
      expect(init?.method).toBe("POST");
      expect(init?.credentials).toBe("omit");
      expect(init?.redirect).toBe("error");
      expect(init?.cache).toBe("no-store");
      expect(new Headers(init?.headers).has("Authorization")).toBe(false);
      expect(JSON.parse(String(init?.body))).toEqual({ email: "reader@example.test", password: " my account password " });
      return Response.json(response());
    }) as typeof fetch);
    await app.login();
    expect(app.element("status").textContent).toContain("Signed in.");
    expect(app.input("password").value).toBe("");
    expect(app.storage.connection).toMatchObject({ userId: "reader", token: response().token });
    expect(app.storage.connection.connectionId).toBe(connectionIdentity("https://margin.example", "reader"));
    expect(JSON.stringify(app.storage)).not.toContain("password");
    expect(app.accessLevel()).toBe("TRUSTED_CONTEXTS");
  });

  test("denied permission never sends credentials and wrong passwords do not replace an existing session", async () => {
    let requests = 0;
    const fetchImpl = (async () => { requests++; return Response.json({ error: "Email or password is incorrect." }, { status: 401 }); }) as typeof fetch;
    const denied = await createOptions(fetchImpl, {}, false);
    await denied.login();
    expect(requests).toBe(0);
    expect(denied.storage.connection).toBeUndefined();
    expect(denied.input("password").value).toBe("");
    const previous = { serverUrl: "https://margin.example", ...response(), displayName: "Reader" };
    const app = await createOptions(fetchImpl, { connection: previous });
    await app.login();
    expect(app.storage.connection).toEqual(previous);
    expect(app.element("status").textContent).toBe("Email or password is incorrect.");
    expect(app.input("password").value).toBe("");
  });

  test("logout revokes the browser session, and the same account can recover a pending capture after signing back in", async () => {
    const calls: { method?: string; token: string | null }[] = [];
    let id = "reader";
    const app = await createOptions((async (_url, init) => {
      calls.push({ method: init?.method, token: new Headers(init?.headers).get("Authorization") });
      return Response.json(init?.method === "DELETE" ? { ok: true } : response(id));
    }) as typeof fetch);
    await app.login();
    const first = app.storage.connection.connectionId;
    app.storage.pendingSave = { connectionId: first, capture: { title: "Keep this draft" } };
    await app.logout();
    expect(app.storage.connection).toBeUndefined();
    expect(calls[1]).toEqual({ method: "DELETE", token: `Bearer ${response().token}` });
    expect(app.removed).toEqual(["https://margin.example/*"]);
    await app.login();
    expect(app.storage.connection.connectionId).toBe(first);
    expect(app.storage.pendingSave.connectionId).toBe(first);
    id = "another-user";
    await app.login("another-user@example.test");
    expect(app.storage.connection.connectionId).not.toBe(first);
    expect(app.storage.pendingSave.connectionId).toBe(first);
    expect(connectionIdentity("https://other.example", "reader")).not.toBe(first);
  });

  test("offline sign-out removes the local credential and reports that server revocation could not complete", async () => {
    const app = await createOptions((async (_url, init) => {
      if (init?.method === "DELETE") throw new TypeError("Offline");
      return Response.json(response());
    }) as typeof fetch);
    await app.login();
    await app.logout();
    expect(app.storage.connection).toBeUndefined();
    expect(app.element("connected").hidden).toBe(true);
    expect(app.element("status").textContent).toContain("could not be reached");
  });

  test("rejects malformed session replies instead of saving a broken connection", async () => {
    const app = await createOptions((async () => Response.json({ token: "bad", user: {} })) as typeof fetch);
    await app.login();
    expect(app.storage.connection).toBeUndefined();
    expect(app.element("status").textContent).toContain("valid session");
    expect(app.input("password").value).toBe("");
  });

  test("migrates a legacy pending draft only when its owner is verified", async () => {
    for (const userId of ["reader", "someone-else", undefined, 42]) {
      const storage = {
        connection: { serverUrl: "https://margin.example", token: `mc_capture_${"B".repeat(43)}`, connectionId: "legacy-connection", displayName: "Reader" },
        pendingSave: { connectionId: "legacy-connection", capture: { title: "Legacy draft" } },
      };
      const app = await createOptions((async (url) => Response.json(String(url).endsWith("capture-connection") ? { userId, displayName: "Reader", expiresAt: response().expiresAt } : response())) as typeof fetch, storage);
      await app.login();
      expect(app.storage.pendingSave.connectionId).toBe(userId === "reader" ? app.storage.connection.connectionId : "legacy-connection");
    }
  });
});
