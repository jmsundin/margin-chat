import { expect, test } from "bun:test";
import { runInNewContext } from "node:vm";
import { installUpdateProtocol } from "../client/build/worker-update-protocol.mjs";

function setup(replies: Array<"ready" | "busy" | "silent" | "commit-error">) {
  let handler: (event: any) => void;
  let activated = 0;
  let enumerations = 0;
  const events: string[] = [];
  let extraClient = false;
  const clients = replies.map((reply, index) => ({
    id: String(index), url: "https://margin.test/",
    postMessage(message: { type: string }, ports: MessagePort[] = []) {
      events.push(`${index}:${message.type}`);
      if (!ports[0] || reply === "silent") return;
      ports[0].postMessage(reply === "busy" || reply === "commit-error" && message.type === "MARGIN_COMMIT_UPDATE"
        ? { error: "Unsaved work" } : { ready: true });
      ports[0].close();
    },
  }));
  const scope = {
    registration: { scope: "https://margin.test/" },
    clients: { async matchAll() { enumerations++; return extraClient && enumerations > 1 ? [...clients, { id: "new", url: "https://margin.test/" }] : clients; } },
    async skipWaiting() { activated++; },
    addEventListener(_type: string, callback: typeof handler) { handler = callback; },
  };
  runInNewContext(`(${installUpdateProtocol.toString()})(scope)`, {
    scope, MessageChannel, crypto,
    setTimeout: (fn: () => void) => setTimeout(fn, 30), clearTimeout,
  });
  const restart = async () => {
    const channel = new MessageChannel();
    const response = new Promise<any>((resolve) => {
      channel.port1.onmessage = (event) => { channel.port1.close(); resolve(event.data); };
    });
    let pending: Promise<void> | undefined;
    handler!({ data: { type: "MARGIN_RESTART" }, source: clients[0], ports: [channel.port2], waitUntil: (value: Promise<void>) => { pending = value; } });
    await pending;
    return response;
  };
  return { restart, events, addTab: () => { extraClient = true; }, get activated() { return activated; } };
}

test("restart prepares and confirms every tab before activating once", async () => {
  const app = setup(["ready", "ready"]);
  expect(await app.restart()).toEqual({ ready: true });
  expect(app.activated).toBe(1);
  expect(app.events).toEqual(["0:MARGIN_PREPARE_UPDATE", "1:MARGIN_PREPARE_UPDATE", "0:MARGIN_COMMIT_UPDATE", "1:MARGIN_COMMIT_UPDATE", "0:MARGIN_RELOAD_UPDATE", "1:MARGIN_RELOAD_UPDATE"]);
});

test.each(["busy", "silent", "commit-error"] as const)("a %s tab prevents activation and releases every tab", async (reply) => {
  const app = setup(["ready", reply]);
  expect((await app.restart()).error).toBeTruthy();
  expect(app.activated).toBe(0);
  expect(app.events.slice(-2)).toEqual(["0:MARGIN_CANCEL_UPDATE", "1:MARGIN_CANCEL_UPDATE"]);
});

test("a newly opened tab prevents committing an obsolete readiness snapshot", async () => {
  const app = setup(["ready"]);
  app.addTab();
  expect((await app.restart()).error).toContain("open tabs changed");
  expect(app.activated).toBe(0);
});

test("concurrent restart requests cannot independently activate the same worker", async () => {
  const app = setup(["ready"]);
  const replies = await Promise.all([app.restart(), app.restart()]);
  expect(replies.filter((reply) => reply.ready)).toHaveLength(1);
  expect(replies.filter((reply) => reply.error)).toHaveLength(1);
  expect(app.activated).toBe(1);
});
