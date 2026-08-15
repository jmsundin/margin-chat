import { describe, expect, test } from "bun:test";
import { createBillingService } from "../server/billing/index.mjs";

function createUser() {
  return {
    billing: { status: "inactive" },
    displayName: "Ada Lovelace",
    email: "ada@example.com",
    id: "user-1",
    role: "member",
  };
}

describe("Stripe subscription checkout", () => {
  test("creates a subscription-mode Checkout Session for the configured price", async () => {
    let checkoutPayload: Record<string, unknown> | null = null;
    const database = {
      getUserBillingAccount: async () => ({
        displayName: "Ada Lovelace",
        email: "ada@example.com",
        id: "user-1",
        stripeCustomerId: null,
      }),
      updateStripeCustomerId: async () => undefined,
    };
    const stripeClient = {
      checkout: {
        sessions: {
          create: async (payload: Record<string, unknown>) => {
            checkoutPayload = payload;
            return { url: "https://checkout.stripe.test/session" };
          },
        },
      },
      customers: {
        create: async () => ({ id: "cus_1" }),
      },
    };
    const service = createBillingService({
      database,
      env: {
        APP_URL: "https://margin.chat",
        STRIPE_PRICE_ID: "price_monthly",
      },
      stripeClient,
    });

    const result = await service.createSubscriptionCheckoutSession({
      request: { headers: {} },
      user: createUser(),
    });

    expect(result.url).toBe("https://checkout.stripe.test/session");
    expect(checkoutPayload).toMatchObject({
      client_reference_id: "user-1",
      customer: "cus_1",
      line_items: [{ price: "price_monthly", quantity: 1 }],
      mode: "subscription",
      payment_method_types: ["card"],
      success_url:
        "https://margin.chat/?checkout=subscription_success&session_id={CHECKOUT_SESSION_ID}",
    });
  });

  test("confirms only the signed-in user's configured subscription", async () => {
    let syncedBilling: Record<string, unknown> | null = null;
    const subscription = {
      cancel_at_period_end: false,
      customer: "cus_1",
      id: "sub_1",
      items: {
        data: [
          {
            current_period_end: 1_800_000_000,
            price: { id: "price_monthly" },
          },
        ],
      },
      status: "active",
    };
    const database = {
      syncUserBillingById: async (args: Record<string, unknown>) => {
        syncedBilling = args;
      },
      updateStripeCustomerId: async () => undefined,
    };
    const stripeClient = {
      checkout: {
        sessions: {
          retrieve: async () => ({
            client_reference_id: "user-1",
            customer: "cus_1",
            metadata: { userId: "user-1" },
            mode: "subscription",
            status: "complete",
            subscription,
          }),
        },
      },
    };
    const service = createBillingService({
      database,
      env: { STRIPE_PRICE_ID: "price_monthly" },
      stripeClient,
    });

    const result = await service.confirmSubscriptionCheckout({
      sessionId: "cs_test_marginchat",
      user: createUser(),
    });

    expect(result).toEqual({ confirmed: true, status: "active" });
    expect(syncedBilling).toMatchObject({
      billingPriceId: "price_monthly",
      billingStatus: "active",
      stripeCustomerId: "cus_1",
      stripeSubscriptionId: "sub_1",
      userId: "user-1",
    });
    expect(
      (syncedBilling?.billingCurrentPeriodEnd as Date).toISOString(),
    ).toBe("2027-01-15T08:00:00.000Z");
  });

  test("rejects a Checkout Session belonging to another user", async () => {
    const service = createBillingService({
      database: {},
      env: { STRIPE_PRICE_ID: "price_monthly" },
      stripeClient: {
        checkout: {
          sessions: {
            retrieve: async () => ({
              client_reference_id: "user-2",
              metadata: { userId: "user-2" },
              mode: "subscription",
              status: "complete",
              subscription: "sub_2",
            }),
          },
        },
      },
    });

    await expect(
      service.confirmSubscriptionCheckout({
        sessionId: "cs_test_someone_else",
        user: createUser(),
      }),
    ).rejects.toMatchObject({ statusCode: 403 });
  });
});
