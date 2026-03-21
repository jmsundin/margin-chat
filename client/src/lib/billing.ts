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

  if (billing.accessKind === "none" && billing.trialCallsRemaining === 0) {
    return "Trial exhausted";
  }

  return getBillingStatusLabel(billing.status);
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
    return `You have ${billing.trialCallsRemaining} of ${billing.trialCallsLimit} free model calls remaining. Start a paid plan any time to avoid losing access when the trial is used up.`;
  }

  if (billing.accessKind === "none" && billing.trialCallsRemaining === 0) {
    return `You have used all ${billing.trialCallsLimit} free model calls. Start a paid plan to keep chatting with the hosted models.`;
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

  return "Start the paid plan before this account can use your hosted model keys.";
}
