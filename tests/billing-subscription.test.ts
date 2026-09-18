import { describe, expect, test } from "bun:test";
import { createBillingService } from "../server/billing/index.mjs";
import { MONTHLY_PLAN_KEY } from "../server/billing/plan.mjs";
import Stripe from "stripe";

import { fixture, user, request } from "./helpers/stripeFixture";

describe("paid monthly subscription balance", () => {
  test("creates the verified $20 monthly price and keeps customer email current", async () => {
    const f = fixture();
    expect(await f.service.createSubscriptionCheckoutSession({ request, user })).toEqual({ url: "https://checkout.stripe.test/session" });
    expect(f.calls.checkouts[0]).toMatchObject({ mode: "subscription", customer: "cus_1", client_reference_id: user.id, allow_promotion_codes: false, line_items: [{ price: "price_monthly", quantity: 1 }], subscription_data: { metadata: { userId: user.id, planKey: MONTHLY_PLAN_KEY } } });
    expect(f.calls.customers[0]).toEqual(["cus_1", { email: user.email, name: user.displayName, metadata: { userId: user.id } }]);
  });

  test("creates inline $20 monthly pricing without a configured price; customer create is idempotent", async () => {
    const f = fixture({ inline: true }); f.setAccount({ stripeCustomerId: null });
    await f.service.createSubscriptionCheckoutSession({ request, user });
    expect(f.calls.checkouts[0].line_items).toEqual([{ quantity: 1, price_data: { currency: "usd", unit_amount: 2000, recurring: { interval: "month" }, product_data: { name: "Margin Chat monthly balance", metadata: { marginChatPlan: MONTHLY_PLAN_KEY } } } }]);
    expect(f.calls.creates[0][1]).toEqual({ idempotencyKey: `margin-customer:${user.id}` });
  });

  test.each([
    ["amount", (f: any) => { f.price.unit_amount = 1900; }],
    ["currency", (f: any) => { f.price.currency = "eur"; }],
    ["annual interval", (f: any) => { f.price.recurring.interval = "year"; }],
    ["metered price", (f: any) => { f.price.recurring.usage_type = "metered"; }],
    ["inactive", (f: any) => { f.price.active = false; }],
    ["quantity transform", (f: any) => { f.price.transform_quantity = { divide_by: 10 }; }],
  ])("rejects invalid configured price: %s", async (_name, mutate) => {
    const f = fixture(); mutate(f);
    await expect(f.service.createSubscriptionCheckoutSession({ request, user })).rejects.toMatchObject({ statusCode: 503 });
    expect(f.calls.checkouts).toHaveLength(0);
  });

  test("confirmation and replayed webhooks fund each initial/renewal invoice once", async () => {
    const f = fixture();
    expect(await f.confirm()).toMatchObject({ confirmed: true, credited: true, amountMicros: 20_000_000 });
    expect(await f.confirm()).toMatchObject({ confirmed: true, credited: false });
    await f.webhook("invoice.paid"); await f.webhook("checkout.session.completed", f.session);
    expect(f.credited.size).toBe(1);
    Object.assign(f.invoice, { id: "in_renewal", billing_reason: "subscription_cycle" });
    Object.assign(f.invoice.payments.data[0], { id: "inpay_renewal", invoice: "in_renewal" });
    await f.webhook("invoice.payment_succeeded"); await f.webhook("invoice.paid");
    expect([...f.credited.values()].reduce((sum, value) => sum + value.amountMicros, 0)).toBe(40_000_000);
    expect(f.calls.credits[0]).toMatchObject({ stripeInvoiceId: "in_first", receiptUrl: f.intent.latest_charge.receipt_url, userId: user.id });
    expect(f.calls.credits[0].stripeCheckoutSessionId).toBeUndefined();
  });

  test("supports legacy invoice PaymentIntent and new allocated InvoicePayment forms", async () => {
    const f = fixture(); delete f.invoice.payments; f.invoice.payment_intent = "pi_1";
    expect(await f.confirm()).toMatchObject({ confirmed: true });
    const g = fixture(); g.intent.amount_received = 4000;
    expect(await g.confirm()).toMatchObject({ confirmed: true });
  });

  test("can grant inline plan paid invoices with the server product marker", async () => {
    const f = fixture({ inline: true });
    expect(await f.confirm()).toMatchObject({ confirmed: true });
    const other = fixture({ inline: true }); other.price.product.metadata = {};
    await other.webhook("invoice.paid"); expect(other.credited.size).toBe(0);
  });

  test.each([
    ["unpaid", (f: any) => { f.invoice.status = "open"; }],
    ["zero invoice", (f: any) => { f.invoice.amount_paid = 0; }],
    ["partially paid", (f: any) => { f.invoice.amount_paid = 1000; }],
    ["discount", (f: any) => { f.invoice.discounts = ["di_1"]; }],
    ["credit note", (f: any) => { f.invoice.post_payment_credit_notes_amount = 1; }],
    ["out of band", (f: any) => { f.invoice.paid_out_of_band = true; }],
    ["balance applied", (f: any) => { f.invoice.starting_balance = -2000; }],
    ["proration", (f: any) => { f.invoice.lines.data[0].parent.subscription_item_details.proration = true; }],
    ["quantity", (f: any) => { f.invoice.lines.data[0].quantity = 2; }],
    ["extra line", (f: any) => { f.invoice.lines.data.push(f.invoice.lines.data[0]); }],
    ["truncated lines", (f: any) => { f.invoice.lines.has_more = true; }],
    ["different price", (f: any) => { f.invoice.lines.data[0].pricing.price_details.price = "price_other"; }],
    ["different customer", (f: any) => { f.invoice.customer = "cus_other"; }],
    ["manual invoice", (f: any) => { f.invoice.billing_reason = "manual"; }],
    ["payment not allocated", (f: any) => { f.invoice.payments.data[0].amount_paid = 1000; }],
    ["different payment invoice", (f: any) => { f.invoice.payments.data[0].invoice = "in_other"; }],
    ["payment record", (f: any) => { f.invoice.payments.data[0].payment.type = "payment_record"; }],
    ["repeated payment allocation", (f: any) => { f.invoice.payments.data.push(f.invoice.payments.data[0]); }],
    ["failed payment", (f: any) => { f.intent.status = "requires_payment_method"; }],
    ["refunded", (f: any) => { f.intent.latest_charge.amount_refunded = 1; }],
    ["disputed", (f: any) => { f.intent.latest_charge.disputed = true; }],
    ["other payment customer", (f: any) => { f.intent.customer = "cus_other"; }],
  ])("never grants funds for %s", async (_name, mutate) => {
    const f = fixture(); mutate(f);
    await f.webhook("invoice.paid"); expect(f.credited.size).toBe(0);
  });

  test("credits the $20 base amount when a fully paid invoice includes tax", async () => {
    const f = fixture(); Object.assign(f.invoice, { amount_paid: 2200, amount_due: 2200, total: 2200 }); f.invoice.payments.data[0].amount_paid = 2200; f.intent.amount_received = 2200;
    expect(await f.confirm()).toMatchObject({ confirmed: true, amountMicros: 20_000_000 });
  });

  test.each(["unpaid", "no_payment_required"])("active subscription with %s checkout does not grant funds", async (paymentStatus) => {
    const f = fixture(); f.session.payment_status = paymentStatus;
    await f.webhook("customer.subscription.updated", f.subscription);
    await expect(f.confirm()).rejects.toMatchObject({ statusCode: 409 });
    expect(f.credited.size).toBe(0);
  });

  test("rejects mismatched user ownership and customer mapping", async () => {
    const f = fixture(); f.session.client_reference_id = "other";
    await expect(f.confirm()).rejects.toMatchObject({ statusCode: 403 });
    const g = fixture(); g.session.customer = "cus_other";
    await expect(g.confirm()).rejects.toMatchObject({ statusCode: 403 });
  });

  test("early invoices link only an existing account with matching customer metadata and email", async () => {
    const f = fixture(); f.setAccount({ stripeCustomerId: null }); await f.webhook("invoice.paid");
    expect(f.account().stripeCustomerId).toBe("cus_1"); expect(f.credited.size).toBe(1);
    const g = fixture(); g.setAccount({ stripeCustomerId: null }); g.customer.email = "someone-else@example.com";
    await expect(g.webhook("invoice.paid")).rejects.toMatchObject({ statusCode: 403 }); expect(g.credited.size).toBe(0);
  });

  test("retrieves current subscription state instead of trusting an old event snapshot", async () => {
    const f = fixture(); f.subscription.status = "canceled";
    await f.webhook("customer.subscription.updated", { ...f.subscription, status: "active" });
    expect(f.account().billingStatus).toBe("canceled"); expect(f.credited.size).toBe(0);
  });

  test("an old cancellation cannot replace a newer subscription", async () => {
    const f = fixture(); const newer = { ...f.subscription, id: "sub_new", created: 200, status: "active" };
    f.subscriptions.set(newer.id, newer); f.setAccount({ stripeSubscriptionId: newer.id }); f.subscription.status = "canceled";
    await f.webhook("customer.subscription.deleted", f.subscription);
    expect(f.account().stripeSubscriptionId).toBe("sub_new"); expect(f.account().billingStatus).toBe("active");
  });

  test("syncs a portal's cancel_at timestamp with a false period-end flag and clears it when restored", async () => {
    const f = fixture(); const periodEnd = Math.floor(Date.now() / 1000) + 30 * 86400;
    f.subscription.items.data[0].current_period_end = periodEnd;
    Object.assign(f.subscription, { status: "active", cancel_at_period_end: false, cancel_at: periodEnd });
    await f.webhook("customer.subscription.updated", f.subscription);
    expect(f.account().billingCancelAtPeriodEnd).toBe(true);
    expect(f.account().billingCurrentPeriodEnd.toISOString()).toBe(new Date(periodEnd * 1000).toISOString());
    f.subscription.cancel_at = null;
    await f.webhook("customer.subscription.updated", f.subscription);
    expect(f.account().billingCancelAtPeriodEnd).toBe(false);
    expect(f.account().billingStatus).toBe("active");
    expect(f.credited.size).toBe(0);
  });

  test("shows the scheduled funding stop when cancellation precedes the current period end", async () => {
    const f = fixture(); const now = Math.floor(Date.now() / 1000);
    f.subscription.items.data[0].current_period_end = now + 30 * 86400;
    f.subscription.cancel_at = now + 10 * 86400;
    await f.webhook("customer.subscription.updated", f.subscription);
    expect(f.account().billingCancelAtPeriodEnd).toBe(true);
    expect(f.account().billingCurrentPeriodEnd.getTime()).toBe(f.subscription.cancel_at * 1000);
  });

  test.each(["past", "later-period"])("does not label a %s cancel_at as this period's scheduled stop", async (kind) => {
    const f = fixture(); const now = Math.floor(Date.now() / 1000);
    f.subscription.items.data[0].current_period_end = now + 30 * 86400;
    f.subscription.cancel_at = kind === "past" ? now - 86400 : now + 60 * 86400;
    await f.webhook("customer.subscription.updated", f.subscription);
    expect(f.account().billingCancelAtPeriodEnd).toBe(false);
    expect(f.account().billingCurrentPeriodEnd.getTime()).toBe((now + 30 * 86400) * 1000);
  });

  test("rechecks a concurrent subscription replacement after compare-and-swap fails", async () => {
    const f = fixture(); const sync = f.database.syncUserBillingById; let raced = false;
    f.database.syncUserBillingById = async (args: any) => {
      if (!raced) { raced = true; f.subscriptions.set("sub_new", { ...f.subscription, id: "sub_new", created: 200 }); f.setAccount({ stripeSubscriptionId: "sub_new" }); }
      return sync(args);
    };
    await f.webhook("customer.subscription.updated", f.subscription);
    expect(f.account().stripeSubscriptionId).toBe("sub_new"); expect(f.calls.syncs).toHaveLength(2);
  });

  test("a concurrent cancellation of the same subscription cannot be overwritten by stale active state", async () => {
    const f = fixture(); f.setAccount({ stripeSubscriptionId: "sub_1" });
    const sync = f.database.syncUserBillingById; let raced = false;
    f.database.syncUserBillingById = async (args: any) => {
      if (!raced) {
        raced = true;
        f.subscription.status = "canceled";
        f.setAccount({ billingStatus: "canceled", billingRevision: 1 });
      }
      return sync(args);
    };
    await f.webhook("customer.subscription.updated", { id: "sub_1", status: "active" });
    expect(f.calls.syncs.map((args) => args.billingStatus)).toEqual(["active", "canceled"]);
    expect(f.account().billingStatus).toBe("canceled");
  });

  test("refetches Stripe after reading the account revision", async () => {
    const f = fixture(); let reads = 0;
    const retrieve = f.stripe.subscriptions.retrieve;
    f.stripe.subscriptions.retrieve = async (id: string) => {
      if (++reads === 1) {
        const stale = { ...f.subscription, status: "active" };
        f.subscription.status = "canceled";
        f.setAccount({ stripeSubscriptionId: "sub_1", billingStatus: "canceled", billingRevision: 1 });
        return stale;
      }
      return retrieve(id);
    };
    await f.webhook("customer.subscription.updated", { id: "sub_1" });
    expect(f.account().billingStatus).toBe("canceled"); expect(reads).toBe(2);
  });
});

describe("prepaid top-ups", () => {
  test("creates a server-priced Checkout with explicit receipt email", async () => {
    const f = fixture(); await f.service.createTopUpCheckoutSession({ request, user, amountCents: 1234 });
    expect(f.calls.checkouts[0]).toMatchObject({ mode: "payment", line_items: [{ quantity: 1, price_data: { currency: "usd", unit_amount: 1234 } }], payment_intent_data: { receipt_email: user.email, metadata: { creditAmountMicros: "12340000", userId: user.id } } });
  });
  test.each([499, 50001, 500.1, "500", NaN, Infinity, null, undefined])("rejects invalid amount %s", async (amountCents) => {
    const f = fixture(); await expect(f.service.createTopUpCheckoutSession({ request, user, amountCents })).rejects.toMatchObject({ statusCode: 400 }); expect(f.calls.checkouts).toHaveLength(0);
  });
  test.each([500, 50000])("accepts boundary amount %s cents", async (amountCents) => {
    const f = fixture(); await f.service.createTopUpCheckoutSession({ request, user, amountCents }); f.topup(amountCents);
    expect(await f.confirm()).toMatchObject({ confirmed: true, amountMicros: amountCents * 10000 });
  });
  test("confirmation and async webhook share one credit source and retain the receipt", async () => {
    const f = fixture(); f.topup(); expect(await f.confirm()).toMatchObject({ confirmed: true, credited: true, amountMicros: 12_340_000 });
    await f.webhook("checkout.session.async_payment_succeeded", f.session);
    expect(await f.confirm()).toMatchObject({ credited: false }); expect(f.credited.size).toBe(1);
    expect(f.calls.credits[0]).toMatchObject({ stripeCheckoutSessionId: f.session.id, receiptUrl: f.intent.latest_charge.receipt_url }); expect(f.calls.credits[0].stripeInvoiceId).toBeUndefined();
  });
  test.each([
    ["unpaid checkout", (f: any) => { f.session.payment_status = "unpaid"; }],
    ["total", (f: any) => { f.session.amount_total -= 1; }],
    ["currency", (f: any) => { f.session.currency = "eur"; }],
    ["discount", (f: any) => { f.session.total_details = { amount_discount: 1 }; }],
    ["tax", (f: any) => { f.session.total_details = { amount_tax: 1 }; }],
    ["quantity", (f: any) => { f.session.line_items.data[0].quantity = 2; }],
    ["unrelated product", (f: any) => { f.session.line_items.data[0].price.product.metadata = {}; }],
    ["inflated metadata", (f: any) => { f.session.metadata.creditAmountMicros = "500000000"; }],
    ["underpaid intent", (f: any) => { f.intent.amount_received -= 1; }],
    ["unrelated intent", (f: any) => { f.intent.metadata.userId = "other"; }],
    ["refunded intent", (f: any) => { f.intent.latest_charge.refunded = true; }],
  ])("rejects %s without granting funds", async (_name, mutate) => {
    const f = fixture(); f.topup(); mutate(f); await expect(f.confirm()).rejects.toMatchObject({ statusCode: 409 }); expect(f.credited.size).toBe(0);
  });
});

describe("billing service contracts", () => {
  test.each([
    [undefined, undefined],
    ["", undefined],
    ["   ", undefined],
    [" bpc_dedicated_test ", "bpc_dedicated_test"],
  ])("selects an optional dedicated portal configuration", async (configuredId, expectedId) => {
    const f = fixture(); let params: any;
    f.stripe.billingPortal = { sessions: { create: async (value: any) => { params = value; return { url: "https://billing.stripe.test/session" }; } } };
    const service = createBillingService({ database: f.database, env: { APP_URL: "https://margin.chat", STRIPE_PORTAL_CONFIGURATION_ID: configuredId }, stripeClient: f.stripe });
    expect(await service.createBillingPortalSession({ request, user })).toEqual({ url: "https://billing.stripe.test/session" });
    expect(params).toEqual({ customer: "cus_1", return_url: "https://margin.chat/?billing=return", ...(expectedId ? { configuration: expectedId } : {}) });
  });
  test("reports spendable funds, holds, and rollover plan without recomputing balance", async () => {
    const f = fixture(); expect(await f.service.getBillingDashboard(user.id)).toMatchObject({ balanceMicros: 20_000_000, reservedMicros: 3000, plan: { monthlyAmountMicros: 20_000_000, currency: "usd", rollover: true } });
  });
  test("reserves explicitly priced usage and settles actual usage including zero", async () => {
    const f = fixture(); const args = { userId: user.id, requestId: "request-1", amountMicros: 5000, metadata: { model: "model" } };
    expect(await f.service.reserveHostedRequest(args)).toEqual({ amountMicros: 5000, balanceMicros: 9_995_000 });
    await f.service.settleHostedRequest({ ...args, amountMicros: 450 }); await f.service.settleHostedRequest({ ...args, amountMicros: 0 });
    expect(f.calls.reserves[0]).toMatchObject(args); expect(f.calls.settlements.map((value) => value.amountMicros)).toEqual([450, 0]);
    await expect(f.service.reserveHostedRequest({ ...args, amountMicros: undefined })).rejects.toMatchObject({ statusCode: 400 });
    f.database.chargeHostedRequest = async () => null;
    await expect(f.service.reserveHostedRequest(args)).rejects.toMatchObject({ statusCode: 402 });
  });
  test("validates webhook signatures before fetching any objects", async () => {
    const f = fixture(); await expect(f.service.handleWebhook({ rawBody: "{}", signature: "invalid" })).rejects.toMatchObject({ statusCode: 400 });
    await expect(f.service.handleWebhook({ rawBody: "{}", signature: "" })).rejects.toMatchObject({ statusCode: 400 }); expect(f.calls.syncs).toHaveLength(0);
  });
  test("verifies a real Stripe signature against the exact raw request body", async () => {
    const stripe = new Stripe("sk_test_local_fixture");
    const secret = "whsec_local_fixture";
    const rawBody = JSON.stringify({ id: "evt_fixture", type: "unhandled.test", data: { object: {} } });
    const signature = await stripe.webhooks.generateTestHeaderStringAsync({ payload: rawBody, secret });
    const service = createBillingService({ database: {}, env: { STRIPE_WEBHOOK_SECRET: secret }, stripeClient: stripe });
    expect(await service.handleWebhook({ rawBody: Buffer.from(rawBody), signature })).toEqual({ received: true });
    await expect(service.handleWebhook({ rawBody: Buffer.from(`${rawBody} `), signature })).rejects.toMatchObject({ statusCode: 400 });
    const wrongSignature = await stripe.webhooks.generateTestHeaderStringAsync({ payload: rawBody, secret: "whsec_wrong" });
    await expect(service.handleWebhook({ rawBody, signature: wrongSignature })).rejects.toMatchObject({ statusCode: 400 });
  });
});
