import { describe, expect, test } from "bun:test";
import { mapBillingRow } from "../server/billing/status.mjs";

describe("hosted credit access", () => {
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
