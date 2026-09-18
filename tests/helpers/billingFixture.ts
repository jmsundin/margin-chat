import type { AuthenticatedUser, BillingDashboardData } from "../../client/src/types";

export const billingUser: AuthenticatedUser = {
  id: "billing-user", email: "member@example.test", displayName: "Budget Member", role: "member",
  apiKeys: { hasAny: false, byProvider: {
    openai: { configured: false, hint: null }, gemini: { configured: false, hint: null },
    xai: { configured: false, hint: null }, huggingface: { configured: false, hint: null },
  } },
  billing: {
    accessKind: "subscription", cancelAtPeriodEnd: false, creditBalanceMicros: 17_123456,
    currentPeriodEnd: "2026-10-18T12:00:00.000Z", hasAccess: true, hasCustomer: true, priceId: "price_test",
    status: "active", trialCallsLimit: 0, trialCallsRemaining: 0, trialCallsUsed: 0,
  },
};

export const billingDashboard: BillingDashboardData = {
  balanceMicros: 17_123456, reservedMicros: 2_000_000, usageThisMonthMicros: 876544, totalPurchasedMicros: 20_000_000,
  subscription: { status: "active", cancelAtPeriodEnd: false, currentPeriodEnd: "2026-10-18T12:00:00.000Z" },
  plan: { monthlyAmountMicros: 20_000_000, currency: "usd", rollover: true }, user: billingUser,
  transactions: [
    { id: "usage", amountMicros: -544, type: "usage", createdAt: "2026-09-18T13:00:00.000Z", description: "Hosted AI usage", receiptUrl: null },
    { id: "estimate", amountMicros: -876000, type: "usage", createdAt: "2026-09-18T13:00:00.000Z", description: "Interrupted AI request", receiptUrl: null, metadata: { usageSource: "estimated-upper-bound" } },
    { id: "credit", amountMicros: 20_000_000, type: "subscription_credit", createdAt: "2026-09-18T12:00:00.000Z", description: "Monthly credit", receiptUrl: "https://pay.stripe.com/receipts/test" },
  ],
};
