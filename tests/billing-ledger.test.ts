import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { createCaptureTestDatabase } from "./helpers/captureDatabase.mjs";
import {
  chargeHostedRequest, creditHostedBalance, getBillingDashboard, getUserBillingAccount,
  refundHostedRequest, settleHostedRequest, syncUserBillingById,
} from "../server/db/billingRepository.mjs";

const databases: any[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map((pg) => pg.close())); });
async function fixture() {
  const { client, pg } = await createCaptureTestDatabase(); databases.push(pg);
  await client.query(`insert into marginchat_users (id,email,password_hash,display_name) values
    ('owner','owner@example.test','hash','Owner'), ('other','other@example.test','hash','Other')`);
  const fund = (source: string, amountMicros = 20_000_000, invoice = true, userId = "owner") => creditHostedBalance(client, {
    amountMicros, userId, ledgerId: randomUUID(), ...(invoice ? { stripeInvoiceId: source } : { stripeCheckoutSessionId: source }),
  });
  const reserve = (requestId: string, amountMicros: number, userId = "owner") => chargeHostedRequest(client, {
    requestId, amountMicros, userId, metadata: { model: "example-model", operation: "chat" },
  });
  return { client, pg, fund, reserve };
}

describe("prepaid billing ledger", () => {
  test("monthly renewals and top-ups accumulate once, with credit and receipt ownership preserved", async () => {
    const { client, fund } = await fixture();
    expect(await fund("in_first")).toBe(true);
    expect(await fund("in_first")).toBe(false);
    expect(await fund("in_renewal")).toBe(true);
    expect(await fund("cs_topup", 5_000_000, false)).toBe(true);
    expect(await fund("cs_topup", 5_000_000, false)).toBe(false);
    await expect(fund("in_first", 20_000_000, true, "other")).rejects.toMatchObject({ statusCode: 409 });
    await expect(fund("in_first", 10_000_000)).rejects.toMatchObject({ statusCode: 409 });
    expect(await creditHostedBalance(client, { amountMicros: 20_000_000, userId: "owner", ledgerId: randomUUID(), stripeInvoiceId: "in_first", receiptUrl: "https://invoice.stripe.com/example" })).toBe(false);
    const dashboard = await getBillingDashboard(client, "owner");
    expect(dashboard).toMatchObject({ balanceMicros: 45_000_000, reservedMicros: 0, totalPurchasedMicros: 45_000_000, usageThisMonthMicros: 0 });
    expect(dashboard.transactions).toHaveLength(3);
    expect(dashboard.transactions.find((entry: any) => entry.receiptUrl)?.receiptUrl).toBe("https://invoice.stripe.com/example");
    expect((await getBillingDashboard(client, "other")).transactions).toEqual([]);
  }, 30_000);

  test("reservations protect the prepaid limit and settlement releases unused funds exactly once", async () => {
    const { client, fund, reserve } = await fixture();
    await fund("in_first");
    expect(await reserve("request-a", 12_000_000)).toBe(8_000_000);
    expect(await reserve("request-a", 12_000_000)).toBe(8_000_000);
    expect(await reserve("request-b", 9_000_000)).toBeNull();
    expect(await reserve("request-c", 8_000_000)).toBe(0);
    expect(await getBillingDashboard(client, "owner")).toMatchObject({ balanceMicros: 0, reservedMicros: 20_000_000, usageThisMonthMicros: 0 });
    expect(await settleHostedRequest(client, { userId: "owner", requestId: "request-a", amountMicros: 3_000_000, metadata: { inputTokens: 200, outputTokens: 30 } })).toMatchObject({ settled: true, amountMicros: 3_000_000, balanceMicros: 9_000_000 });
    expect(await settleHostedRequest(client, { userId: "owner", requestId: "request-a", amountMicros: 3_000_000 })).toMatchObject({ settled: false });
    await refundHostedRequest(client, { userId: "owner", requestId: "request-c", amountMicros: 8_000_000 });
    await refundHostedRequest(client, { userId: "owner", requestId: "request-c", amountMicros: 8_000_000 });
    const dashboard = await getBillingDashboard(client, "owner");
    expect(dashboard).toMatchObject({ balanceMicros: 17_000_000, reservedMicros: 0, usageThisMonthMicros: 3_000_000 });
    expect(dashboard.transactions.filter((entry: any) => entry.type === "hosted_request")).toHaveLength(1);
    expect(dashboard.transactions[0].metadata).toMatchObject({ inputTokens: 200, outputTokens: 30, model: "example-model" });
  }, 30_000);

  test("invalid settlement, replay and cross-account requests cannot create funds or exceed a hold", async () => {
    const { client, fund, reserve } = await fixture(); await fund("in_first"); await reserve("r", 1_000_000);
    await expect(settleHostedRequest(client, { userId: "owner", requestId: "r", amountMicros: 1_000_001 })).rejects.toMatchObject({ statusCode: 409 });
    await expect(settleHostedRequest(client, { userId: "other", requestId: "r", amountMicros: 0 })).rejects.toMatchObject({ statusCode: 404 });
    await expect(reserve("r", 1_000_000, "other")).rejects.toMatchObject({ statusCode: 409 });
    await expect(reserve("bad", -100)).rejects.toMatchObject({ statusCode: 400 });
    await expect(fund("bad", Number.MAX_SAFE_INTEGER + 1)).rejects.toMatchObject({ statusCode: 400 });
    expect(await getBillingDashboard(client, "owner")).toMatchObject({ balanceMicros: 19_000_000, reservedMicros: 1_000_000 });
    await settleHostedRequest(client, { userId: "owner", requestId: "r", amountMicros: 500_000 });
    await expect(reserve("r", 1_000_000)).rejects.toMatchObject({ statusCode: 409 });
    // A refund after settlement cannot undo actual recorded provider usage.
    await refundHostedRequest(client, { userId: "owner", requestId: "r", amountMicros: 1_000_000 });
    expect((await getUserBillingAccount(client, "owner")).creditBalanceMicros).toBe(19_500_000);
  }, 30_000);

  test("a stale subscription update cannot replace the newer subscription", async () => {
    const { client } = await fixture();
    const args = { userId: "owner", stripeCustomerId: "cus_owner", stripeSubscriptionId: "sub_new", billingStatus: "active", billingPriceId: "price_monthly", billingCurrentPeriodEnd: null, billingCancelAtPeriodEnd: false, expectedStripeSubscriptionId: null };
    expect(await syncUserBillingById(client, args)).toMatchObject({ stripeSubscriptionId: "sub_new" });
    expect(await syncUserBillingById(client, { ...args, stripeSubscriptionId: "sub_old", billingStatus: "canceled" })).toBeNull();
    expect((await getUserBillingAccount(client, "owner")).stripeSubscriptionId).toBe("sub_new");
  }, 30_000);

  test("same-subscription status races use a revision and incomplete settlements fail the schema check", async () => {
    const { client, fund, reserve } = await fixture();
    const args = { userId: "owner", stripeCustomerId: "cus_owner", stripeSubscriptionId: "sub_current", billingStatus: "active", billingPriceId: "price_monthly", billingCurrentPeriodEnd: null, billingCancelAtPeriodEnd: false };
    expect(await syncUserBillingById(client, { ...args, expectedBillingRevision: 0 })).toMatchObject({ billingRevision: 1 });
    expect(await syncUserBillingById(client, { ...args, billingStatus: "canceled", expectedBillingRevision: 1 })).toMatchObject({ billingRevision: 2 });
    expect(await syncUserBillingById(client, { ...args, expectedBillingRevision: 1 })).toBeNull();
    expect((await getUserBillingAccount(client, "owner")).billingStatus).toBe("canceled");
    await fund("in_first"); await reserve("pending", 1000);
    await expect(client.query("update marginchat_usage_reservations set settled_at=now() where request_id='pending'")).rejects.toMatchObject({ code: "23514" });
  }, 30_000);
});
