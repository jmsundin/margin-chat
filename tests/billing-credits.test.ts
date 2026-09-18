import { describe, expect, test } from "bun:test";
import { mapBillingRow } from "../server/billing/status.mjs";

describe("hosted credit access", () => {
  test("requires prepayment even when legacy trial calls remain", () => {
    const billing = mapBillingRow({ role: "member", billing_status: "inactive", trial_api_calls_used: 0, trial_api_calls_limit: 100 });
    expect(billing.accessKind).toBe("none");
    expect(billing.hasAccess).toBe(false);
  });

  test("an active subscription preserves cloud access but cannot bypass an empty balance", () => {
    const empty = mapBillingRow({ role: "member", billing_status: "active", hosted_credit_balance_micros: 0 });
    expect(empty.accessKind).toBe("subscription");
    expect(empty.hasAccess).toBe(false);
    expect(mapBillingRow({ role: "member", billing_status: "active", hosted_credit_balance_micros: 20_000_000 }).hasAccess).toBe(true);
  });

  test("remaining prepaid credit stays usable after a subscription is canceled", () => {
    const billing = mapBillingRow({ role: "member", billing_status: "canceled", hosted_credit_balance_micros: 2_000_000 });
    expect(billing.accessKind).toBe("credits");
    expect(billing.hasAccess).toBe(true);
  });

  test("administrators retain their existing hosted access", () => {
    expect(mapBillingRow({ role: "admin", hosted_credit_balance_micros: 0 }).hasAccess).toBe(true);
  });

  test("unlocks hosted access after the trial is exhausted", () => {
    const billing = mapBillingRow({
      billing_status: "inactive",
      hosted_credit_balance_micros: "9750000",
      role: "member",
      trial_api_calls_limit: 100,
      trial_api_calls_used: 100,
    });

    expect(billing.accessKind).toBe("credits");
    expect(billing.creditBalanceMicros).toBe(9_750_000);
    expect(billing.hasAccess).toBe(true);
  });

  test("keeps personal-key-only accounts out of hosted billing access", () => {
    const billing = mapBillingRow({
      billing_status: "inactive",
      hosted_credit_balance_micros: 0,
      role: "member",
      trial_api_calls_limit: 100,
      trial_api_calls_used: 100,
    });

    expect(billing.accessKind).toBe("none");
    expect(billing.hasAccess).toBe(false);
  });
});
