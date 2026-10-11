import { describe, expect, test } from "bun:test";
import { CLOUD_PLAN_KEY, MONTHLY_PLAN_KEY } from "../server/billing/plan.mjs";
import { billingPlanForPriceId, mapBillingRow } from "../server/billing/status.mjs";
import { requireCaptureAccess } from "../server/captures/index.mjs";
import { canUseCloudWorkspaceStorage } from "../server/routes/api.mjs";
import { fixture, user, request } from "./helpers/stripeFixture";

function onCloud(f: ReturnType<typeof fixture>) {
  f.subscription.items.data[0].price = { id: f.cloudPrice.id };
  f.subscription.metadata.planKey = CLOUD_PLAN_KEY;
  Object.assign(f.invoice, { amount_paid: 1000, amount_due: 1000, subtotal: 1000, total: 1000 });
  Object.assign(f.invoice.lines.data[0], { amount: 1000, pricing: { price_details: { price: f.cloudPrice.id } } });
  f.invoice.payments.data[0].amount_paid = 1000;
  f.intent.amount_received = 1000;
}

function onUpgradeInvoice(f: ReturnType<typeof fixture>) {
  Object.assign(f.invoice, { id: "in_upgrade", billing_reason: "subscription_update", amount_paid: 2000, amount_due: 2000, subtotal: 2000, total: 2000 });
  Object.assign(f.invoice.lines.data[0], { amount: 2000, pricing: { price_details: { price: f.price.id } } });
  Object.assign(f.invoice.payments.data[0], { id: "inpay_upgrade", invoice: "in_upgrade", amount_paid: 2000 });
  f.intent.amount_received = 2000;
}

describe("Cloud plan ($10, storage and sync, own AI keys)", () => {
  test("checks out the configured $10 price with the Cloud plan key", async () => {
    const f = fixture({ cloud: true });
    await f.service.createSubscriptionCheckoutSession({ request, user, plan: "cloud" });
    expect(f.calls.checkouts[0]).toMatchObject({ mode: "subscription", line_items: [{ price: "price_cloud", quantity: 1 }], subscription_data: { metadata: { planKey: CLOUD_PLAN_KEY, userId: user.id } } });
  });

  test("is unavailable without a valid configured Cloud price", async () => {
    await expect(fixture().service.createSubscriptionCheckoutSession({ request, user, plan: "cloud" })).rejects.toMatchObject({ statusCode: 503 });
    const f = fixture({ cloud: true }); f.cloudPrice.unit_amount = 2000;
    await expect(f.service.createSubscriptionCheckoutSession({ request, user, plan: "cloud" })).rejects.toMatchObject({ statusCode: 503 });
    await expect(f.service.createSubscriptionCheckoutSession({ request, user, plan: "gold" })).rejects.toMatchObject({ statusCode: 400 });
  });

  test("confirms an active Cloud subscription without granting credit", async () => {
    const f = fixture({ cloud: true }); onCloud(f);
    expect(await f.confirm()).toMatchObject({ confirmed: true, plan: "cloud", credited: false, amountMicros: 0 });
    await f.webhook("invoice.paid");
    expect(f.credited.size).toBe(0);
    expect(f.account()).toMatchObject({ billingStatus: "active", billingPriceId: "price_cloud" });
  });

  test("Plus checkouts still grant $20 when Cloud is configured", async () => {
    const f = fixture({ cloud: true });
    expect(await f.confirm()).toMatchObject({ confirmed: true, plan: "plus", credited: true, amountMicros: 20_000_000 });
  });

  test("a $10 invoice on the Plus price never grants funds", async () => {
    const f = fixture({ cloud: true }); onCloud(f); f.invoice.lines.data[0].pricing.price_details.price = f.price.id;
    await f.webhook("invoice.paid");
    expect(f.credited.size).toBe(0);
  });

  test("upgrades Cloud to Plus immediately and grants the $20 upgrade invoice once", async () => {
    const f = fixture({ cloud: true }); onCloud(f);
    await f.webhook("customer.subscription.updated", f.subscription);
    onUpgradeInvoice(f);
    expect(await f.service.upgradeToPlus({ user })).toMatchObject({ upgraded: true, plan: "plus", credited: true, amountMicros: 20_000_000 });
    expect(f.calls.updates[0][1]).toMatchObject({ items: [{ id: "si_1", price: "price_monthly", quantity: 1 }], billing_cycle_anchor: "now", proration_behavior: "none", payment_behavior: "error_if_incomplete", metadata: { planKey: MONTHLY_PLAN_KEY } });
    expect(f.account().billingPriceId).toBe("price_monthly");
    await f.webhook("invoice.paid");
    expect([...f.credited.keys()]).toEqual(["in_upgrade"]);
  });

  test("an upgrade invoice with prorations grants nothing", async () => {
    const f = fixture({ cloud: true }); onCloud(f);
    await f.webhook("customer.subscription.updated", f.subscription);
    onUpgradeInvoice(f); f.invoice.lines.data[0].parent.subscription_item_details.proration = true;
    expect(await f.service.upgradeToPlus({ user })).toMatchObject({ upgraded: true, credited: false });
    expect(f.credited.size).toBe(0);
  });

  test("refuses to upgrade without an active Cloud plan", async () => {
    const f = fixture({ cloud: true });
    await expect(f.service.upgradeToPlus({ user })).rejects.toMatchObject({ statusCode: 409 });
    await f.webhook("customer.subscription.updated", f.subscription);
    await expect(f.service.upgradeToPlus({ user })).rejects.toMatchObject({ statusCode: 409, message: "You're already on Plus." });
    expect(f.calls.updates).toHaveLength(0);
  });
});

describe("Cloud plan access", () => {
  const env = { STRIPE_CLOUD_PRICE_ID: "price_cloud" };
  const row = (priceId: string | null) => ({ role: "member", billing_status: "active", billing_price_id: priceId, hosted_credit_balance_micros: 0 });

  test("classifies the stored price", () => {
    expect(billingPlanForPriceId("price_cloud", env)).toBe("cloud");
    expect(billingPlanForPriceId("price_monthly", env)).toBe("plus");
    expect(billingPlanForPriceId("price_cloud", {})).toBe("plus");
    expect(billingPlanForPriceId(null, env)).toBeNull();
  });

  test("Cloud keeps cloud storage but not the extension or hosted AI", () => {
    const cloud = { role: "member", billing: mapBillingRow(row("price_cloud"), env) };
    expect(cloud.billing).toMatchObject({ accessKind: "subscription", plan: "cloud", hasAccess: false });
    expect(canUseCloudWorkspaceStorage(cloud)).toBe(true);
    expect(() => requireCaptureAccess(cloud)).toThrow("come with Plus");
    const plus = { role: "member", billing: mapBillingRow(row("price_monthly"), env) };
    expect(canUseCloudWorkspaceStorage(plus)).toBe(true);
    expect(() => requireCaptureAccess(plus)).not.toThrow();
    // Older capture-token rows without a price stay Plus.
    expect(() => requireCaptureAccess({ role: "member", billing: mapBillingRow(row(null), env) })).not.toThrow();
  });
});
