import type { BillingNotice, CheckoutConfirmation, UserBilling } from "../types";

export function getBillingStatusLabel(status: UserBilling["status"]) {
  switch (status) {
    case "active":
      return "Active";
    case "trialing":
      return "Trialing";
    case "past_due":
      return "Past due";
    case "canceled":
      return "Canceled";
    case "unpaid":
      return "Unpaid";
    case "incomplete":
      return "Incomplete";
    case "incomplete_expired":
      return "Incomplete expired";
    case "paused":
      return "Paused";
    default:
      return "Inactive";
  }
}

export function getBillingDisplayLabel(billing: UserBilling) {
  if (billing.accessKind === "admin") return "Admin access";
  if (billing.status === "active" || billing.status === "trialing") return "Monthly prepaid plan";
  if (billing.creditBalanceMicros > 0) return `${formatCreditBalance(billing.creditBalanceMicros)} available`;
  return "Prepaid AI usage";
}

export function formatCreditBalance(micros: number) {
  return new Intl.NumberFormat(undefined, {
    currency: "USD",
    style: "currency",
  }).format(Math.max(micros, 0) / 1_000_000);
}

export function formatBillingPeriodEnd(value: string | null) {
  if (!value) {
    return null;
  }

  const parsedDate = new Date(value);

  if (Number.isNaN(parsedDate.getTime())) {
    return null;
  }

  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
  }).format(parsedDate);
}

export function getBillingStatusCopy(billing: UserBilling) {
  const periodEnd = formatBillingPeriodEnd(billing.currentPeriodEnd);
  const balance = formatCreditBalance(billing.creditBalanceMicros);
  if (billing.accessKind === "admin") return "This admin account has hosted model access. Personal provider keys are billed by their provider.";
  if (billing.status === "active" || billing.status === "trialing") {
    const renewal = billing.cancelAtPeriodEnd
      ? `Monthly funding ends${periodEnd ? ` on ${periodEnd}` : " at the end of this period"}. Your unused credits remain available.`
      : `$20 per month adds $20 to your AI budget.${periodEnd ? ` Next renewal: ${periodEnd}.` : ""} Unused credits carry over.`;
    return `${renewal} Available balance: ${balance}.`;
  }
  if (["past_due", "unpaid", "incomplete", "incomplete_expired", "paused"].includes(billing.status)) {
    return `Your monthly payment needs attention in Stripe. You can still use your ${balance} remaining prepaid balance.`;
  }
  if (billing.status === "canceled") return `Your monthly plan has ended. Your ${balance} unused balance remains available; add money whenever you need it.`;
  return "Add money for hosted AI use, or subscribe for $20 in credit each month. Unused credits carry over. Personal API keys are billed directly by their provider.";
}

/** Parse decimal dollars without floating-point rounding or silently accepting extra cents. */
export function parseTopUpAmountCents(value: string): number | null {
  const match = /^(\d+)(?:\.(\d{1,2}))?$/.exec(value.trim());
  if (!match) return null;
  const cents = Number(match[1]) * 100 + Number((match[2] ?? "").padEnd(2, "0"));
  return Number.isSafeInteger(cents) && cents >= 500 && cents <= 50000 ? cents : null;
}

export function formatUsageCost(micros: number) {
  return new Intl.NumberFormat(undefined, { style: "currency", currency: "USD", minimumFractionDigits: 2, maximumFractionDigits: 6 })
    .format(Math.max(micros, 0) / 1_000_000);
}

export function getCheckoutReturn(params: URLSearchParams) {
  const result = params.get("checkout");
  if (["subscription_success", "success", "topup_success"].includes(result ?? "")) {
    return { kind: "success" as const, sessionId: params.get("session_id") };
  }
  if (["subscription_canceled", "canceled", "topup_canceled"].includes(result ?? "")) {
    return { kind: "canceled" as const, sessionId: null };
  }
  return null;
}

export function getCheckoutConfirmationNotice(confirmation: CheckoutConfirmation): BillingNotice {
  if (!confirmation.confirmed) return {
    kind: "info", message: "Your payment is not confirmed yet. Refresh billing shortly to check your balance, or open Stripe for the payment status.",
  };
  return {
    kind: "success",
    message: confirmation.purchaseKind === "subscription"
      ? "Your subscription payment is confirmed. Your monthly credit is available, and unused credit carries over."
      : "Your payment is confirmed and the money has been added to your AI balance.",
  };
}

export function getReceiptUrl(value: string | null) {
  if (!value) return null;
  try { const url = new URL(value); return url.protocol === "https:" ? url.href : null; }
  catch { return null; }
}
