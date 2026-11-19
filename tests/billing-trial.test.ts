import { describe, expect, test } from "bun:test";
import { planTrial } from "../server/billing/index.mjs";
import { MONTHLY_PLAN_KEY } from "../server/billing/plan.mjs";
import { fixture, user, request } from "./helpers/stripeFixture";

/** A Checkout that started a card-backed Plus trial: nothing paid, subscription trialing. */
function onTrial(f: ReturnType<typeof fixture>) {
  Object.assign(f.subscription, { status: "trialing", trial_end: 1_800_000_000 });
  Object.assign(f.session, { payment_status: "no_payment_required", invoice: "in_trial", metadata: { ...f.session.metadata, trial: "true" } });
  Object.assign(f.invoice, { id: "in_trial", amount_paid: 0, amount_due: 0, subtotal: 0, total: 0 });
}

describe("Plus free trial (card up front, one-click cancel)", () => {
  test("is off unless STRIPE_TRIAL_DAYS is set; trial credit is optional and capped at $20", async () => {
    expect(planTrial({})).toBeNull();
    for (const value of ["0", "-1", "1.5", "week", "91", ""]) expect(planTrial({ STRIPE_TRIAL_DAYS: value })).toBeNull();
    expect(planTrial({ STRIPE_TRIAL_DAYS: "7" })).toEqual({ days: 7, creditMicros: 0 });
    expect(planTrial({ STRIPE_TRIAL_DAYS: "7", STRIPE_TRIAL_CREDIT_CENTS: "200" })).toEqual({ days: 7, creditMicros: 2_000_000 });
    for (const value of ["-5", "2001", "1.5", "lots"]) expect(planTrial({ STRIPE_TRIAL_DAYS: "7", STRIPE_TRIAL_CREDIT_CENTS: value })).toEqual({ days: 7, creditMicros: 0 });
    const f = fixture();
    await expect(f.service.createSubscriptionCheckoutSession({ request, user, plan: "plus", trial: true })).rejects.toMatchObject({ statusCode: 409 });
    expect((await f.service.getBillingDashboard(user.id)).trial).toBeNull();
  });

  test("checks out Plus with a trial that requires a card and cancels without one", async () => {
    for (const inline of [false, true]) {
      const f = fixture({ trialDays: 7, inline });
      await f.service.createSubscriptionCheckoutSession({ request, user, plan: "plus", trial: true });
      expect(f.calls.checkouts[0]).toMatchObject({
        mode: "subscription", payment_method_collection: "always", metadata: { trial: "true" },
        subscription_data: { trial_period_days: 7, trial_settings: { end_behavior: { missing_payment_method: "cancel" } }, metadata: { planKey: MONTHLY_PLAN_KEY, userId: user.id } },
      });
    }
  });

  test("an ordinary checkout carries no trial, and Cloud has none", async () => {
    const f = fixture({ cloud: true, trialDays: 7 });
    await f.service.createSubscriptionCheckoutSession({ request, user, plan: "plus" });
    expect(f.calls.checkouts[0].subscription_data.trial_period_days).toBeUndefined();
    expect(f.calls.checkouts[0].payment_method_collection).toBeUndefined();
    expect(f.calls.checkouts[0].metadata.trial).toBeUndefined();
    await expect(f.service.createSubscriptionCheckoutSession({ request, user, plan: "cloud", trial: true })).rejects.toMatchObject({ statusCode: 400 });
  });

  test("one trial per account: any earlier subscription uses it up", async () => {
    const f = fixture({ trialDays: 7, trialCreditCents: 200 });
    expect((await f.service.getBillingDashboard(user.id)).trial).toEqual({ days: 7, creditMicros: 2_000_000, eligible: true });
    f.setAccount({ stripeSubscriptionId: "sub_old", billingStatus: "canceled" });
    await expect(f.service.createSubscriptionCheckoutSession({ request, user, plan: "plus", trial: true })).rejects.toMatchObject({ statusCode: 409 });
    expect((await f.service.getBillingDashboard(user.id)).trial).toMatchObject({ eligible: false });
    // Subscribing without a trial still works.
    await f.service.createSubscriptionCheckoutSession({ request, user, plan: "plus" });
    expect(f.calls.checkouts).toHaveLength(1);
  });

  test("confirms a started trial with nothing paid and grants the trial credit once", async () => {
    const f = fixture({ trialDays: 7, trialCreditCents: 200 }); onTrial(f);
    expect(await f.confirm()).toMatchObject({
      confirmed: true, plan: "plus", trial: true, credited: true, amountMicros: 2_000_000, status: "trialing",
      trialEnd: new Date(1_800_000_000 * 1000).toISOString(),
    });
    expect(await f.confirm()).toMatchObject({ confirmed: true, trial: true, credited: false });
    await f.webhook("checkout.session.completed", f.session);
    await f.webhook("invoice.paid");
    expect([...f.credited.keys()]).toEqual(["in_trial"]);
    expect(f.credited.get("in_trial")).toMatchObject({ amountMicros: 2_000_000, description: "Free trial credit", metadata: { trialSubscriptionId: "sub_1" } });
    expect(f.account()).toMatchObject({ billingStatus: "trialing", billingPriceId: "price_monthly" });
  });

  test("a trial without configured credit grants nothing", async () => {
    const f = fixture({ trialDays: 7 }); onTrial(f);
    expect(await f.confirm()).toMatchObject({ confirmed: true, trial: true, credited: false, amountMicros: 0 });
    expect(f.credited.size).toBe(0);
  });

  test("the first paid invoice after the trial grants the usual $20", async () => {
    const f = fixture({ trialDays: 7, trialCreditCents: 200 }); onTrial(f);
    await f.confirm();
    f.subscription.status = "active";
    Object.assign(f.invoice, { id: "in_month1", billing_reason: "subscription_cycle", amount_paid: 2000, amount_due: 2000, subtotal: 2000, total: 2000 });
    f.invoice.payments.data[0].invoice = "in_month1";
    await f.webhook("invoice.paid");
    expect([...f.credited.keys()]).toEqual(["in_trial", "in_month1"]);
    expect(f.credited.get("in_month1").amountMicros).toBe(20_000_000);
    expect(f.calls.reversals).toEqual([]);
  });

  test("a trialing subscription that was not started as a trial here is not confirmed", async () => {
    const f = fixture({ trialDays: 7, trialCreditCents: 200 });
    f.subscription.status = "trialing";
    Object.assign(f.session, { payment_status: "no_payment_required" });
    await expect(f.confirm()).rejects.toMatchObject({ statusCode: 409 });
    expect(f.credited.size).toBe(0);
  });

  test("cancels a trial at once, takes back its unused credit, and the trial cannot be restarted", async () => {
    const f = fixture({ trialDays: 7, trialCreditCents: 200 }); onTrial(f);
    await f.confirm();
    expect(await f.service.cancelTrial({ user })).toEqual({ canceled: true });
    expect(f.calls.cancels).toEqual(["sub_1"]);
    expect(f.calls.reversals).toMatchObject([{ creditLedgerId: "in_trial", targetMicros: 2_000_000, reason: "trial_ended" }]);
    expect(f.account()).toMatchObject({ billingStatus: "canceled", stripeSubscriptionId: "sub_1" });
    await expect(f.service.createSubscriptionCheckoutSession({ request, user, plan: "plus", trial: true })).rejects.toMatchObject({ statusCode: 409 });
  });

  test("a trial ended in Stripe (portal, or no card at the end) also gives its unused credit back", async () => {
    const f = fixture({ trialDays: 7, trialCreditCents: 200 }); onTrial(f);
    await f.confirm();
    Object.assign(f.subscription, { status: "canceled", ended_at: 1_799_999_000 });
    await f.webhook("customer.subscription.deleted", f.subscription);
    expect(f.calls.reversals).toMatchObject([{ creditLedgerId: "in_trial", reason: "trial_ended" }]);
  });

  test("a plan canceled after it converted keeps its credit", async () => {
    const f = fixture({ trialDays: 7, trialCreditCents: 200 }); onTrial(f);
    await f.confirm();
    Object.assign(f.subscription, { status: "canceled", ended_at: 1_805_000_000 });
    await f.webhook("customer.subscription.deleted", f.subscription);
    expect(f.calls.reversals).toEqual([]);
  });

  test("refuses to cancel anything that is not a trial", async () => {
    const f = fixture({ trialDays: 7 });
    await expect(f.service.cancelTrial({ user })).rejects.toMatchObject({ statusCode: 409 });
    await f.webhook("customer.subscription.updated", f.subscription);
    await expect(f.service.cancelTrial({ user })).rejects.toMatchObject({ statusCode: 409 });
    expect(f.calls.cancels).toEqual([]);
    expect(f.account().billingStatus).toBe("active");
  });
});
