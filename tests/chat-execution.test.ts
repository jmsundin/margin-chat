import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { createChatExecutionService } from "../server/chat/execution.mjs";
import { createHostedUsageMeter, runMeteredProviderOperation } from "../server/billing/usage.mjs";
import { createRequestAbortScope, handleChatRequest } from "../server/routes/chat.mjs";

function fixture(reply: (...args: any[]) => any, accessKind = "credits", credentialSource = "hosted") {
  const reservations: any[] = [];
  const refunds: any[] = [];
  const settlements: any[] = [];
  const billingService = {
    getHostedUsageLimits: () => ({ maxOutputTokens: 123 }),
    reserveHostedRequest: async (args: any) => { reservations.push(args); return { amountMicros: args.amountMicros }; },
    settleHostedRequest: async (args: any) => { settlements.push(args); if (args.amountMicros === 0) refunds.push(args); },
  };
  return {
    reservations, refunds, settlements, billingService,
    user: { id: "owner", role: "member", billing: { hasAccess: true, accessKind } },
    execute: createChatExecutionService({
      apiKeyService: { getDecryptedKeys: async () => ({}) },
      billingService,
      chatService: {
        createUsageMeter: (options: any) => createHostedUsageMeter({ ...options, env: { HOSTED_MODEL_PRICES_JSON: JSON.stringify({ "openai:test": { inputMicrosPerMillionTokens: 1_000_000, outputMicrosPerMillionTokens: 2_000_000 } }) } }),
        getPlannedCredentialSource: () => credentialSource,
        requestReplyStream: (payload: any, context: any, handlers: any) => runMeteredProviderOperation(credentialSource === "hosted" ? context.usageMeter : null, {
          provider: "openai", model: "test", body: { input: "hello" }, maxOutputTokens: context.hostedMaxOutputTokens, signal: context.signal,
        }, async (tracker: any) => {
          tracker.markDispatched();
          try {
            const value = await reply(payload, context, handlers);
            tracker.recordUsage({ usage: { input_tokens: 10, output_tokens: 5 } });
            return value;
          } catch (error: any) {
            if (error.providerRejected) tracker.markRejected();
            throw error;
          }
        }),
      },
    }),
  };
}

const result = { metadata: { credentialSource: "hosted" }, reply: "Hello" };

describe("chat execution lifecycle", () => {
  test("personal credentials bypass hosted reservations and output limits", async () => {
    const personalResult = { metadata: { credentialSource: "personal" }, reply: "Hello" };
    const f = fixture(async (_payload, context) => {
      expect(context.hostedMaxOutputTokens).toBeUndefined();
      return personalResult;
    }, "credits", "personal");
    expect(await f.execute({ payload: {}, user: f.user })).toEqual(personalResult);
    expect(f.reservations).toHaveLength(0);
    expect(f.refunds).toHaveLength(0);
  });

  test("refunds one reservation using its original ID when a provider fails before output", async () => {
    const failure = Object.assign(new Error("provider unavailable"), { providerRejected: true });
    const f = fixture(async () => { throw failure; });
    await expect(f.execute({ payload: {}, user: f.user })).rejects.toBe(failure);
    expect(f.reservations).toHaveLength(1);
    expect(f.refunds).toHaveLength(1);
    expect(f.refunds[0]).toMatchObject({ requestId: f.reservations[0].requestId, userId: "owner", amountMicros: 0 });
  });

  test("does not refund a failure after the client stream started", async () => {
    const f = fixture(async (_payload, _context, handlers) => {
      await handlers.onReady(result.metadata);
      throw new Error("stream interrupted");
    });
    await expect(f.execute({ payload: {}, user: f.user })).rejects.toThrow("stream interrupted");
    expect(f.reservations).toHaveLength(1);
    expect(f.refunds).toHaveLength(0);
  });

  test("cancellation while reserving refunds the completed reservation without starting a provider", async () => {
    const controller = new AbortController();
    let started = false;
    const f = fixture(async () => { started = true; return result; });
    f.billingService.reserveHostedRequest = async (args) => {
      f.reservations.push(args);
      controller.abort();
      return { amountMicros: args.amountMicros };
    };
    await expect(f.execute({ payload: {}, user: f.user, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(started).toBe(false);
    expect(f.refunds).toHaveLength(1);
    expect(f.refunds[0]).toMatchObject({ requestId: f.reservations[0].requestId, userId: "owner", amountMicros: 0 });
  });

  test("cancellation after output retains the charge and prevents completion", async () => {
    const controller = new AbortController();
    const f = fixture(async (_payload, context, handlers) => {
      expect(context.signal).toBe(controller.signal);
      expect(context.hostedMaxOutputTokens).toBe(123);
      await handlers.onReady(result.metadata);
      controller.abort();
      return result;
    });
    await expect(f.execute({ payload: {}, user: f.user, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(f.refunds).toHaveLength(0);
  });

  test("settles subscribed hosted replies from prepaid credits too", async () => {
    const f = fixture(async () => result, "subscription");
    expect(await f.execute({ payload: {}, user: f.user })).toEqual(result);
    expect(f.reservations).toHaveLength(1);
    expect(f.settlements[0]).toMatchObject({ amountMicros: 20, metadata: { usageSource: "provider" } });
  });

  test("an already-cancelled execution never reserves or calls a provider", async () => {
    const controller = new AbortController();
    controller.abort();
    let started = false;
    const f = fixture(async () => { started = true; return result; });
    await expect(f.execute({ payload: {}, user: f.user, signal: controller.signal })).rejects.toMatchObject({ name: "AbortError" });
    expect(started).toBe(false);
    expect(f.reservations).toHaveLength(0);
  });
});

describe("HTTP chat cancellation", () => {
  test("aborting a Node HTTP response reaches the running execution signal", async () => {
    // Production runs on Node. Bun 1.3's node:http adapter does not emit close
    // when a response disconnects, so exercise the actual production transport.
    const moduleUrl = new URL("../server/routes/chat.mjs", import.meta.url).href;
    const script = `
      import { createServer } from "node:http";
      import { handleChatRequest } from ${JSON.stringify(moduleUrl)};
      let signal;
      let finish;
      const finished = new Promise(resolve => { finish = resolve; });
      const server = createServer((request, response) => {
        handleChatRequest({ request, response, user: {}, executeChatReply: async ({ signal: current, handlers }) => {
          signal = current;
          await handlers.onReady({});
          await new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason), { once: true }));
        }}).then(finish);
      });
      await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
      const controller = new AbortController();
      const response = await fetch("http://127.0.0.1:" + server.address().port + "/api/chat", {
        method: "POST", body: "{}", signal: controller.signal,
      });
      await response.body.getReader().read();
      controller.abort();
      await finished;
      console.log(JSON.stringify({ status: response.status, aborted: signal.aborted }));
      server.closeAllConnections();
      await new Promise(resolve => server.close(resolve));
    `;
    const child = Bun.spawn(["node", "--input-type=module", "-e", script], { stdout: "pipe", stderr: "pipe" });
    const [stdout, stderr, exitCode] = await Promise.all([
      new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
    ]);
    expect(stderr).toBe("");
    expect(exitCode).toBe(0);
    expect(JSON.parse(stdout)).toEqual({ status: 200, aborted: true });
  });

  test("normal request completion does not cancel a response; disconnect does, and listeners are removed", () => {
    const request = new EventEmitter();
    const response = Object.assign(new EventEmitter(), { writableEnded: false });
    const scope = createRequestAbortScope(request, response);
    request.emit("close");
    expect(scope.signal.aborted).toBe(false);
    response.emit("close");
    expect(scope.signal.aborted).toBe(true);
    scope.dispose();
    expect(request.listenerCount("aborted")).toBe(0);
    expect(response.listenerCount("close")).toBe(0);
    expect(response.listenerCount("error")).toBe(0);
  });

  test("a completed response close does not abort its request", () => {
    const request = new EventEmitter();
    const response = Object.assign(new EventEmitter(), { writableEnded: true });
    const scope = createRequestAbortScope(request, response);
    response.emit("close");
    expect(scope.signal.aborted).toBe(false);
    scope.dispose();
  });

  test("the HTTP adapter stops execution after disconnect and writes no completion event", async () => {
    const request = Readable.from([Buffer.from("{}")]);
    const writes: string[] = [];
    const response = Object.assign(new EventEmitter(), {
      writableEnded: false,
      writeHead() {},
      write(value: string) { writes.push(value); },
      end() { this.writableEnded = true; },
    });
    const f = fixture(async (_payload, _context, handlers) => {
      await handlers.onReady(result.metadata);
      response.emit("close");
      await handlers.onDelta("discarded");
      return result;
    });
    await handleChatRequest({ request, response, user: f.user, executeChatReply: f.execute });
    expect(writes.map((value) => JSON.parse(value).type)).toEqual(["metadata"]);
    expect(f.refunds).toHaveLength(0);
    expect(response.listenerCount("close")).toBe(0);
    expect(request.listenerCount("aborted")).toBe(0);
  });
});
