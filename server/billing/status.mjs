const KNOWN_BILLING_STATUSES = new Set([
  "active",
  "canceled",
  "inactive",
  "incomplete",
  "incomplete_expired",
  "past_due",
  "paused",
  "trialing",
  "unpaid",
]);

export function normalizeBillingStatus(value) {
  if (typeof value !== "string") {
    return "inactive";
  }

  const normalizedValue = value.trim().toLowerCase();

  return KNOWN_BILLING_STATUSES.has(normalizedValue)
    ? normalizedValue
    : "inactive";
}

export function billingStatusHasAccess(status) {
  return status === "active" || status === "trialing";
}

function normalizeTrialCallsUsed(value) {
  const parsedValue = Number(value);

  if (!Number.isInteger(parsedValue) || parsedValue < 0) {
    return 0;
  }

  return parsedValue;
}

function normalizeTrialCallsLimit(value) {
  const parsedValue = Number(value);

  if (!Number.isInteger(parsedValue) || parsedValue <= 0) {
    return 100;
  }

  return parsedValue;
}

export function serializeBillingPeriodEnd(value) {
  if (!value) {
    return null;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (typeof value === "string") {
    return value;
  }

  return null;
}

export function mapBillingRow(row) {
  const status = normalizeBillingStatus(row?.billing_status);
  const trialCallsUsed = normalizeTrialCallsUsed(row?.trial_api_calls_used);
  const trialCallsLimit = normalizeTrialCallsLimit(row?.trial_api_calls_limit);
  const trialCallsRemaining = Math.max(trialCallsLimit - trialCallsUsed, 0);
  const accessKind =
    row?.role === "admin"
      ? "admin"
      : billingStatusHasAccess(status)
        ? "subscription"
        : trialCallsRemaining > 0
          ? "trial"
          : "none";

  return {
    accessKind,
    cancelAtPeriodEnd: Boolean(row?.billing_cancel_at_period_end),
    currentPeriodEnd: serializeBillingPeriodEnd(row?.billing_current_period_end),
    hasAccess: accessKind !== "none",
    hasCustomer: Boolean(row?.stripe_customer_id),
    priceId:
      typeof row?.billing_price_id === "string" && row.billing_price_id
        ? row.billing_price_id
        : null,
    status,
    trialCallsLimit,
    trialCallsRemaining,
    trialCallsUsed,
  };
}
