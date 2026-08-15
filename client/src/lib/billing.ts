import type { UserBilling } from "../types";

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
  if (billing.accessKind === "admin") {
    return "Admin access";
  }

  if (billing.accessKind === "trial") {
    return "Free trial";
  }

  if (billing.accessKind === "credits") {
    return `${formatCreditBalance(billing.creditBalanceMicros)} hosted credits`;
  }

  if (billing.accessKind === "none" && billing.trialCallsRemaining === 0) {
    return "Trial exhausted";
  }

  return getBillingStatusLabel(billing.status);
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
  const formattedPeriodEnd = formatBillingPeriodEnd(billing.currentPeriodEnd);

  if (billing.accessKind === "admin") {
    return "This admin account bypasses subscription requirements and can access the hosted models without Stripe.";
  }

  if (billing.accessKind === "trial") {
    const prepaidCopy = billing.creditBalanceMicros > 0
      ? ` You also have ${formatCreditBalance(billing.creditBalanceMicros)} in hosted credits ready when the trial ends.`
      : " Start a subscription any time to avoid losing hosted access when the trial is used up.";

    return `You have ${billing.trialCallsRemaining} of ${billing.trialCallsLimit} free model calls remaining.${prepaidCopy}`;
  }

  if (billing.accessKind === "credits") {
    return `You have ${formatCreditBalance(billing.creditBalanceMicros)} in prepaid hosted usage. Personal API keys are used instead whenever you save one for the selected provider.`;
  }

  if (billing.accessKind === "none" && billing.trialCallsRemaining === 0) {
    return `You have used all ${billing.trialCallsLimit} free model calls. Start a subscription or save a personal provider key to keep chatting.`;
  }

  if (billing.status === "active") {
    if (billing.cancelAtPeriodEnd && formattedPeriodEnd) {
      return `Your paid access stays active until ${formattedPeriodEnd}, then your account will stop calling the hosted models.`;
    }

    if (formattedPeriodEnd) {
      return `Your paid access is active. The current billing period renews around ${formattedPeriodEnd}.`;
    }

    return "Your paid access is active and this account can use the hosted models.";
  }

  if (billing.status === "trialing") {
    if (formattedPeriodEnd) {
      return `Your trial is active through ${formattedPeriodEnd}. Upgrade status will stay in sync after Stripe events arrive.`;
    }

    return "Your trial is active and this account can use the hosted models.";
  }

  if (billing.status === "past_due") {
    return "Your subscription needs attention in Stripe before this account can keep using the hosted models.";
  }

  if (billing.status === "canceled") {
    return "Your previous subscription has ended. Start a new plan to restore model access.";
  }

  if (billing.status === "unpaid") {
    return "Stripe marked the most recent invoice unpaid. Update billing to restore model access.";
  }

  if (billing.status === "incomplete" || billing.status === "incomplete_expired") {
    return "Stripe does not have a completed subscription for this account yet. Start the paid plan to unlock model access.";
  }

  if (billing.status === "paused") {
    return "Your subscription is paused. Resume it in Stripe before this account can use the hosted models.";
  }

  return "Start a subscription to use the hosted model keys, or save your own provider key below.";
}
