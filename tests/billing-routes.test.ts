import { describe, expect, test } from "bun:test";
import { EventEmitter } from "node:events";
import { Readable } from "node:stream";
import { createApiHandler } from "../server/routes/api.mjs";

function response() {
  return Object.assign(new EventEmitter(), {
    status: 0, headers: {} as Record<string, string>, body: "", headersSent: false, writableEnded: false,
    setHeader(name: string, value: string) { this.headers[name] = value; },
    writeHead(status: number, headers: Record<string, string>) { this.status = status; Object.assign(this.headers, headers); this.headersSent = true; },
    end(body: string) { this.body = body; this.writableEnded = true; },
  });
}
function fixture(user: any = { id: "owner", billing: { creditBalanceMicros: 0 } }) {
  const calls: any[] = [];
  let current = user;
  const handler = createApiHandler({
    runtimeConfig: { host: "localhost", port: 8787 },
    authService: { getAuthContext: async () => ({ user: current }) },
    billingService: {
      createSubscriptionCheckoutSession: async (args: any) => { calls.push(["subscription", args.user.id]); return { url: "https://checkout.stripe.com/subscription" }; },
      createTopUpCheckoutSession: async (args: any) => { calls.push(["topup", args.user.id, args.amountCents]); return { url: "https://checkout.stripe.com/topup" }; },
      getBillingDashboard: async (userId: string) => { calls.push(["dashboard", userId]); return { balanceMicros: 20_000_000, reservedMicros: 0, transactions: [] }; },
      confirmCheckout: async ({ sessionId, user }: any) => { calls.push(["confirm", user.id, sessionId]); current = { ...user, billing: { creditBalanceMicros: 20_000_000 } }; return { confirmed: true, status: "active", purchaseKind: "subscription" }; },
    },
  });
  return { calls, async request(method: string, url: string, body?: any, headers: Record<string, string> = {}) {
    const req = Object.assign(Readable.from(body === undefined ? [] : [Buffer.from(JSON.stringify(body))]), { method, url, headers: { host: "localhost", "content-type": "application/json", ...headers } });
    const res = response(); await handler(req, res);
    return { status: res.status, headers: res.headers, body: JSON.parse(res.body) };
  } };
}

describe("billing account routes", () => {
  test("blocks an old tab from paying for a different signed-in account", async () => {
    const f = fixture();
    for (const [method, path] of [["GET", "dashboard"], ["POST", "checkout"], ["POST", "topup"], ["POST", "checkout/confirm"], ["POST", "portal"]]) {
      const result = await f.request(method, `/api/billing/${path}`, { amountCents: 2000 }, { "x-margin-billing-user": "previous-user" });
      expect(result.status).toBe(409);
      expect(result.body.error).toContain("account changed");
    }
    expect(f.calls).toEqual([]);
  });

  test("checkout, top-ups and dashboard use only the signed-in account", async () => {
    const f = fixture();
    expect((await f.request("POST", "/api/billing/checkout", { userId: "other" })).status).toBe(200);
    expect((await f.request("POST", "/api/billing/topup", { userId: "other", amountCents: 2500 })).status).toBe(200);
    const dashboard = await f.request("GET", "/api/billing/dashboard?userId=other");
    expect(dashboard.status).toBe(200);
    expect(dashboard.headers["Cache-Control"]).toBe("no-store");
    expect(dashboard.body.user.id).toBe("owner");
    expect(f.calls).toEqual([["subscription", "owner"], ["topup", "owner", 2500], ["dashboard", "owner"]]);
  });

  test("confirmation returns a freshly loaded account after payment credit is applied", async () => {
    const f = fixture();
    const result = await f.request("POST", "/api/billing/checkout/confirm", { sessionId: "cs_paid", userId: "other" });
    expect(result.status).toBe(200);
    expect(result.headers["Cache-Control"]).toBe("no-store");
    expect(result.body).toMatchObject({ confirmed: true, purchaseKind: "subscription", user: { id: "owner", billing: { creditBalanceMicros: 20_000_000 } } });
    expect(f.calls).toEqual([["confirm", "owner", "cs_paid"]]);
  });

  test("billing data and payment sessions require authentication", async () => {
    const f = fixture(null);
    for (const [method, path] of [["GET", "dashboard"], ["POST", "checkout"], ["POST", "topup"], ["POST", "checkout/confirm"]]) {
      expect((await f.request(method, `/api/billing/${path}`, { amountCents: 2000 })).status).toBe(401);
    }
    expect(f.calls).toEqual([]);
  });
});
