import { afterEach, describe, expect, test } from "bun:test";
import { randomUUID } from "node:crypto";
import { CLOUD_PLAN_KEY } from "../server/billing/plan.mjs";
import { mapBillingRow } from "../server/billing/status.mjs";
import { getBillingDashboard, grantTrialCredit } from "../server/db/billingRepository.mjs";
import { createCaptureTestDatabase } from "./helpers/captureDatabase.mjs";
import { fixture, request, user } from "./helpers/stripeFixture";

// Web sign-up: a free trial with a card, for Cloud ($10) or Cloud + AI ($20). docs/desktop-local-mode.md, step 5.

/** Stripe's view of a Checkout that started a trial: nothing paid, a $0 first invoice, the subscription trialing. */
function inTrial(f: ReturnType<typeof fixture>, plan: "plus" | "cloud" = "plus") {
  f.session.payment_status = "no_payment_required";
  f.subscription.status = "trialing";
  if (plan === "cloud") {
    f.subscription.items.data[0].price = { id: f.cloudPrice.id };
    f.subscription.metadata.planKey = CLOUD_PLAN_KEY;
  }
  Object.assign(f.invoice, { amount_paid: 0, amount_due: 0, subtotal: 0, total: 0 });
  Object.assign(f.invoice.lines.data[0], { amount: 0 });
  f.invoice.payments.data = [];
}

describe("checkout", () => {
  test("an account's first plan starts with a 14-day trial; the card is taken and a trial without one cancels", async () => {
    const f = fixture({ cloud: true });
    await f.service.createSubscriptionCheckoutSession({ request, user, plan: "plus" });
    expect(f.calls.checkouts[0]).toMatchObject({
      payment_method_collection: "always", payment_method_types: ["card"],
      subscription_data: { trial_period_days: 14, trial_settings: { end_behavior: { missing_payment_method: "cancel" } } },
    });
  });

  test("an account that already had a plan pays from the start", async () => {
    const f = fixture({ cloud: true });
    f.setAccount({ stripeSubscriptionId: "sub_old", billingStatus: "canceled" });
    await f.service.createSubscriptionCheckoutSession({ request, user, plan: "cloud" });
    expect(f.calls.checkouts[0].subscription_data.trial_period_days).toBeUndefined();
    expect(f.calls.checkouts[0].payment_method_collection).toBeUndefined();
  });

  test("STRIPE_TRIAL_DAYS sets the length, and 0 turns trials off", async () => {
    const short = fixture({ env: { STRIPE_TRIAL_DAYS: "7" } });
    await short.service.createSubscriptionCheckoutSession({ request, user });
    expect(short.calls.checkouts[0].subscription_data.trial_period_days).toBe(7);
    const off = fixture({ env: { STRIPE_TRIAL_DAYS: "0" } });
    await off.service.createSubscriptionCheckoutSession({ request, user });
    expect(off.calls.checkouts[0].subscription_data.trial_period_days).toBeUndefined();
  });
});

describe("starting the trial", () => {
  test("Cloud + AI comes with $2 of AI once; the $0 trial invoice grants nothing", async () => {
    const f = fixture(); inTrial(f);
    expect(await f.confirm()).toMatchObject({ confirmed: true, plan: "plus", trial: true, credited: true, amountMicros: 2_000_000, status: "trialing" });
    expect(f.account()).toMatchObject({ billingStatus: "trialing", stripeSubscriptionId: "sub_1" });
    // The webhook and a second confirmation find it already granted.
    await f.webhook("checkout.session.completed", f.session);
    expect(await f.confirm()).toMatchObject({ confirmed: true, credited: false, amountMicros: 0 });
    expect(f.trialCredited.size).toBe(1);
    await f.webhook("invoice.paid");
    expect(f.credited.size).toBe(0);
  });

  test("Cloud's trial grants no AI", async () => {
    const f = fixture({ cloud: true }); inTrial(f, "cloud");
    expect(await f.confirm()).toMatchObject({ confirmed: true, plan: "cloud", trial: true, credited: false });
    expect(f.calls.trialCredits).toHaveLength(0);
  });

  test("STRIPE_TRIAL_AI_CREDIT_CENTS=0 gives no allowance", async () => {
    const f = fixture({ env: { STRIPE_TRIAL_AI_CREDIT_CENTS: "0" } }); inTrial(f);
    expect(await f.confirm()).toMatchObject({ confirmed: true, trial: true, credited: false });
    expect(f.calls.trialCredits).toHaveLength(0);
  });

  test("nothing paid and not trialing is not a confirmed plan", async () => {
    const f = fixture(); inTrial(f);
    f.subscription.status = "incomplete";
    await expect(f.confirm()).rejects.toMatchObject({ statusCode: 409 });
    f.subscription.status = "trialing"; f.session.status = "open";
    await expect(f.confirm()).rejects.toMatchObject({ statusCode: 409 });
    expect(f.trialCredited.size).toBe(0);
  });

  test("when the trial ends, the first $20 payment adds $20 of credit", async () => {
    const f = fixture(); inTrial(f);
    await f.confirm();
    f.subscription.status = "active";
    Object.assign(f.invoice, { id: "in_after_trial", billing_reason: "subscription_cycle", amount_paid: 2000, amount_due: 2000, subtotal: 2000, total: 2000 });
    Object.assign(f.invoice.lines.data[0], { amount: 2000 });
    f.invoice.payments.data = [{ id: "inpay_2", invoice: "in_after_trial", status: "paid", currency: "usd", amount_paid: 2000, payment: { type: "payment_intent", payment_intent: "pi_1" } }];
    await f.webhook("invoice.paid");
    expect([...f.credited.keys()]).toEqual(["in_after_trial"]);
    expect(f.account().billingStatus).toBe("active");
  });
});

describe("Cloud to Cloud + AI during the trial", () => {
  test("changes the plan without a charge, keeps the trial, and adds the AI allowance once", async () => {
    const f = fixture({ cloud: true }); inTrial(f, "cloud");
    await f.confirm();
    expect(await f.service.upgradeToPlus({ user })).toMatchObject({ upgraded: true, plan: "plus", trial: true, credited: true, amountMicros: 2_000_000 });
    const [, args] = f.calls.updates[0];
    expect(args).toMatchObject({ items: [{ id: "si_1", price: "price_monthly", quantity: 1 }], proration_behavior: "none" });
    expect(args.billing_cycle_anchor).toBeUndefined();
    expect(args.trial_end).toBeUndefined();
    expect(f.account().billingPriceId).toBe("price_monthly");
    expect(f.credited.size).toBe(0);
  });
});

describe("who picks a plan before the website opens", () => {
  const row = (extra: Record<string, unknown>) => ({ role: "member", billing_status: "inactive", hosted_credit_balance_micros: 0, ...extra });

  test("new web accounts without a plan; never older accounts, admins, or accounts on a plan or trial", () => {
    expect(mapBillingRow(row({ web_plan_required: true }), {})).toMatchObject({ planRequired: true, freeTrialDays: 14 });
    expect(mapBillingRow(row({}), {}).planRequired).toBe(false);
    expect(mapBillingRow(row({ web_plan_required: true, role: "admin" }), {}).planRequired).toBe(false);
    expect(mapBillingRow(row({ web_plan_required: true, billing_status: "trialing" }), {}).planRequired).toBe(false);
    expect(mapBillingRow(row({ web_plan_required: true, billing_status: "past_due" }), {}).planRequired).toBe(false);
    // A trial that was canceled leaves the account to pick a plan again, this time without a trial.
    expect(mapBillingRow(row({ web_plan_required: true, billing_status: "canceled", stripe_subscription_id: "sub_1", hosted_credit_balance_micros: 400_000 }), {}))
      .toMatchObject({ planRequired: true, freeTrialDays: 0 });
  });
});

describe("trial allowance in the ledger", () => {
  const databases: any[] = [];
  afterEach(async () => { await Promise.all(databases.splice(0).map((pg) => pg.close())); });

  test("is granted once per account, adds to the balance, and isn't counted as purchased", async () => {
    const { client, pg } = await createCaptureTestDatabase(); databases.push(pg);
    await client.query("insert into marginchat_users (id,email,password_hash,display_name) values ('owner','owner@example.test','hash','Owner')");
    const grant = () => grantTrialCredit(client, { userId: "owner", amountMicros: 1_000_000, ledgerId: randomUUID(), description: "Free trial AI allowance" });
    expect(await grant()).toBe(true);
    expect(await grant()).toBe(false);
    // The database holds it to once, even past the check.
    await expect(client.query("insert into marginchat_billing_ledger (id, user_id, amount_micros, entry_type) values ($1, 'owner', 1000000, 'trial_credit')", [randomUUID()])).rejects.toThrow();
    const dashboard = await getBillingDashboard(client, "owner");
    expect(dashboard).toMatchObject({ balanceMicros: 1_000_000, totalPurchasedMicros: 0 });
    expect(dashboard.transactions[0].description).toBe("Free trial AI allowance");
  }, 30_000);
});

describe("the plan picker", () => {
  test("offers both plans with the trial, the free desktop app, and logging out", async () => {
    const { renderToStaticMarkup } = await import("react-dom/server");
    const { createElement } = await import("react");
    const { default: PlanPicker } = await import("../client/src/components/PlanPicker");
    const props = { confirming: false, submitting: false, errorMessage: null, notice: null, onStart() {}, onLogout() {}, onCheckAgain() {} };
    const account = (freeTrialDays: number) => ({ ...user, billing: { freeTrialDays, planRequired: true } }) as any;
    const html = renderToStaticMarkup(createElement(PlanPicker, { ...props, user: account(14) }));
    expect(html).toContain("Try it free for 14 days");
    expect(html).toContain("Cloud + AI");
    expect(html.match(/Start free trial/g)).toHaveLength(2);
    expect(html).toContain("/download");
    expect(html).toContain("Log out");
    const again = renderToStaticMarkup(createElement(PlanPicker, { ...props, user: account(0) }));
    expect(again).toContain("Pick a plan");
    expect(again).not.toContain("free trial");
    expect(renderToStaticMarkup(createElement(PlanPicker, { ...props, confirming: true, user: account(14) }))).toContain("Starting your plan");
    const noCloud = renderToStaticMarkup(createElement(PlanPicker, { ...props, user: { ...account(14), billing: { freeTrialDays: 14, cloudPlanAvailable: false } } }));
    expect(noCloud).not.toContain("<h2>Cloud</h2>");
    expect(noCloud).toContain("Cloud + AI");
  });
});
