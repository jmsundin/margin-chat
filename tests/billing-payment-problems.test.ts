import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { CLOUD_PLAN_KEY } from "../server/billing/plan.mjs";
import { mapBillingRow } from "../server/billing/status.mjs";
import { canUseCloudWorkspaceStorage } from "../server/routes/api.mjs";
import { createCaptureTestDatabase } from "./helpers/captureDatabase.mjs";
import {
  chargeHostedRequest, creditHostedBalance, findStripeCredits, getBillingDashboard, getUserBillingAccount,
  reverseStripeCredit, settleHostedRequest, STALE_HOLD_MINUTES,
} from "../server/db/billingRepository.mjs";
import { fixture, user } from "./helpers/stripeFixture";

// What a member sees when a payment goes wrong: a declined renewal, a retry, a cancellation,
// a declined upgrade, a refund or a dispute, and a server that stopped mid-request.

const memberWith = (status: string, balance = 0) => ({ billing: mapBillingRow({ billing_status: status, hosted_credit_balance_micros: balance, role: "member" }) });

describe("failed and retried renewals", () => {
  test("a declined renewal marks the plan past due without credit; the paid retry adds $20 once", async () => {
    const f = fixture();
    await f.confirm();
    expect(f.credited.size).toBe(1);
    // Stripe fails the renewal and keeps retrying the card.
    f.subscription.status = "past_due";
    Object.assign(f.invoice, { id: "in_renewal", billing_reason: "subscription_cycle", status: "open", amount_paid: 0, amount_remaining: 2000 });
    f.invoice.payments.data = [];
    await f.webhook("invoice.payment_failed");
    await f.webhook("invoice.paid");
    expect(f.account().billingStatus).toBe("past_due");
    expect(f.credited.size).toBe(1);
    // A later retry succeeds.
    f.subscription.status = "active";
    Object.assign(f.invoice, { status: "paid", amount_paid: 2000, amount_remaining: 0 });
    f.invoice.payments.data = [{ id: "inpay_renewal", invoice: "in_renewal", status: "paid", currency: "usd", amount_paid: 2000, payment: { type: "payment_intent", payment_intent: "pi_1" } }];
    await f.webhook("invoice.paid"); await f.webhook("invoice.payment_succeeded");
    expect(f.account().billingStatus).toBe("active");
    expect([...f.credited.keys()]).toEqual(["in_first", "in_renewal"]);
  });

  test("past due keeps the cloud vault and sync while Stripe retries; a lapsed plan does not", () => {
    expect(canUseCloudWorkspaceStorage(memberWith("past_due"))).toBe(true);
    for (const status of ["canceled", "unpaid", "incomplete_expired", "inactive"]) {
      expect(canUseCloudWorkspaceStorage(memberWith(status))).toBe(false);
    }
    // Leftover credit still pays for AI after a plan ends.
    expect(memberWith("canceled", 5_000_000).billing).toMatchObject({ accessKind: "credits", hasAccess: true });
  });

  test("past due does not count as an active plan for checkout guards", async () => {
    const f = fixture();
    f.setAccount({ billingStatus: "past_due", stripeSubscriptionId: "sub_1" });
    // Starting a second subscription is allowed only when nothing is active; past due is handled in the portal.
    const result = await f.service.createSubscriptionCheckoutSession({ request: { headers: {} }, user });
    expect(result.url).toBeTruthy();
  });
});

describe("cancellation", () => {
  test("a canceled subscription ends the plan and keeps the prepaid credit", async () => {
    const f = fixture();
    await f.confirm();
    f.subscription.status = "canceled";
    await f.webhook("customer.subscription.deleted", f.subscription);
    expect(f.account()).toMatchObject({ billingStatus: "canceled", stripeSubscriptionId: "sub_1" });
    expect(f.credited.size).toBe(1);
    expect(f.calls.reserves).toHaveLength(0);
  });
});

describe("declined upgrade", () => {
  test("a declined card leaves the Cloud plan unchanged and grants nothing", async () => {
    const f = fixture({ cloud: true });
    f.subscription.items.data[0].price = { id: f.cloudPrice.id };
    f.subscription.metadata.planKey = CLOUD_PLAN_KEY;
    await f.webhook("customer.subscription.updated", f.subscription);
    f.stripe.onUpdate = () => { throw Object.assign(new Error("Your card was declined."), { type: "StripeCardError", code: "card_declined" }); };
    await expect(f.service.upgradeToPlus({ user })).rejects.toMatchObject({ statusCode: 402 });
    expect(f.account().billingPriceId).toBe("price_cloud");
    expect(f.credited.size).toBe(0);
  });
});

describe("refunds and disputes take back the credit they paid for", () => {
  function withReversals(f: ReturnType<typeof fixture>, credits: any[]) {
    const reversals: any[] = [];
    f.database.findStripeCredits = async (args: any) => credits.filter((credit) => credit.paymentIntentId === args.paymentIntentId || args.invoiceIds?.includes(credit.invoiceId));
    f.database.reverseStripeCredit = async (args: any) => { reversals.push(args); return args; };
    const charge: any = { id: "ch_1", payment_intent: "pi_1", customer: "cus_1", amount: 2000, amount_captured: 2000, amount_refunded: 0 };
    f.stripe.charges = { retrieve: async () => charge };
    f.stripe.invoicePayments.list = async () => ({ data: [{ invoice: "in_old" }] });
    return { reversals, charge };
  }

  test("a full refund takes back all of it and a partial refund its share", async () => {
    const f = fixture();
    const { reversals, charge } = withReversals(f, [{ id: "led_1", userId: user.id, amountMicros: 20_000_000, paymentIntentId: "pi_1" }]);
    charge.amount_refunded = 500;
    await f.webhook("charge.refunded", charge);
    charge.amount_refunded = 2000;
    await f.webhook("charge.refunded", charge);
    expect(reversals.map((entry) => [entry.creditLedgerId, entry.targetMicros, entry.reason])).toEqual([["led_1", 5_000_000, "refund"], ["led_1", 20_000_000, "refund"]]);
  });

  test("a dispute takes back the whole credit", async () => {
    const f = fixture();
    const { reversals } = withReversals(f, [{ id: "led_1", userId: user.id, amountMicros: 12_340_000, paymentIntentId: "pi_1" }]);
    await f.webhook("charge.dispute.created", { id: "dp_1", charge: "ch_1" });
    expect(reversals[0]).toMatchObject({ creditLedgerId: "led_1", targetMicros: 12_340_000, reason: "dispute", chargeId: "ch_1" });
  });

  test("credits from before payment IDs were stored are found through the invoice", async () => {
    const f = fixture();
    const { reversals, charge } = withReversals(f, [{ id: "led_old", userId: user.id, amountMicros: 20_000_000, invoiceId: "in_old" }]);
    charge.amount_refunded = 2000;
    await f.webhook("charge.refunded", charge);
    expect(reversals[0]).toMatchObject({ creditLedgerId: "led_old", targetMicros: 20_000_000 });
  });

  test("new subscription credits record the PaymentIntent that paid them", async () => {
    const f = fixture();
    await f.confirm();
    expect(f.calls.credits[0].metadata.paymentIntentIds).toEqual(["pi_1"]);
  });
});

const databases: any[] = [];
afterEach(async () => { await Promise.all(databases.splice(0).map((pg) => pg.close())); });
async function ledger() {
  const { client, pg } = await createCaptureTestDatabase(); databases.push(pg);
  await client.query(`insert into marginchat_users (id,email,password_hash,display_name) values ('owner','owner@example.test','hash','Owner')`);
  const balance = async () => (await getUserBillingAccount(client, "owner"))!.creditBalanceMicros;
  return { client, balance };
}

describe("payment reversals in the ledger", () => {
  test("refunds are idempotent, partial refunds add up, and spent credit is recorded as unrecovered", async () => {
    const { client, balance } = await ledger();
    await creditHostedBalance(client, { amountMicros: 20_000_000, userId: "owner", ledgerId: randomUUID(), stripeInvoiceId: "in_1", metadata: { paymentIntentIds: ["pi_sub"] } });
    await creditHostedBalance(client, { amountMicros: 5_000_000, userId: "owner", ledgerId: randomUUID(), stripeCheckoutSessionId: "cs_1", metadata: { paymentIntentId: "pi_top" } });
    const [subscription] = await findStripeCredits(client, { paymentIntentId: "pi_sub" });
    const [topUp] = await findStripeCredits(client, { paymentIntentId: "pi_top" });
    expect(subscription).toMatchObject({ userId: "owner", amountMicros: 20_000_000 });
    expect(topUp).toMatchObject({ amountMicros: 5_000_000 });
    expect(await findStripeCredits(client, { paymentIntentId: "pi_none", invoiceIds: ["in_1"] })).toHaveLength(1);

    const reverse = (credit: any, targetMicros: number) => reverseStripeCredit(client, { creditLedgerId: credit.id, targetMicros, chargeId: "ch", reason: "refund", ledgerId: randomUUID() });
    expect(await reverse(topUp, 2_000_000)).toMatchObject({ reversedMicros: 2_000_000, takenMicros: 2_000_000 });
    expect(await reverse(topUp, 2_000_000)).toMatchObject({ reversedMicros: 0 });
    expect(await reverse(topUp, 5_000_000)).toMatchObject({ reversedMicros: 3_000_000 });
    expect(await reverse(topUp, 9_000_000)).toMatchObject({ reversedMicros: 0 });
    expect(await balance()).toBe(20_000_000);

    // The member spent $18 of the $20 before the refund: $2 comes back, $18 is recorded as unrecovered.
    await chargeHostedRequest(client, { amountMicros: 18_000_000, requestId: "r1", userId: "owner" });
    await settleHostedRequest(client, { amountMicros: 18_000_000, requestId: "r1", userId: "owner" });
    expect(await reverse(subscription, 20_000_000)).toMatchObject({ reversedMicros: 20_000_000, takenMicros: 2_000_000, unrecoveredMicros: 18_000_000 });
    expect(await reverse(subscription, 20_000_000)).toMatchObject({ reversedMicros: 0 });
    expect(await balance()).toBe(0);
    const dashboard = await getBillingDashboard(client, "owner");
    // Purchased is net of everything refunded, including the part already spent.
    expect(dashboard.totalPurchasedMicros).toBe(0);
    expect(dashboard.transactions.filter((entry: any) => entry.type === "stripe_payment_reversal").map((entry: any) => entry.description))
      .toEqual(["Payment refunded", "Payment refunded", "Payment refunded"]);
  }, 30_000);

  test("a hold left by a server that stopped mid-request is released, and a late settlement can't charge it", async () => {
    const { client, balance } = await ledger();
    await creditHostedBalance(client, { amountMicros: 1_000_000, userId: "owner", ledgerId: randomUUID(), stripeCheckoutSessionId: "cs_1" });
    await chargeHostedRequest(client, { amountMicros: 400_000, requestId: "lost", userId: "owner" });
    await chargeHostedRequest(client, { amountMicros: 100_000, requestId: "running", userId: "owner" });
    await client.query(`update marginchat_usage_reservations set created_at = now() - make_interval(mins => $1) where request_id = 'lost'`, [STALE_HOLD_MINUTES + 1]);
    expect(await getBillingDashboard(client, "owner")).toMatchObject({ balanceMicros: 900_000, reservedMicros: 100_000 });
    expect(await settleHostedRequest(client, { amountMicros: 400_000, requestId: "lost", userId: "owner" })).toMatchObject({ settled: false, amountMicros: 0 });
    expect(await settleHostedRequest(client, { amountMicros: 50_000, requestId: "running", userId: "owner" })).toMatchObject({ settled: true });
    expect(await balance()).toBe(950_000);
  }, 30_000);
});
