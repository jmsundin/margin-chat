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

/** Which subscription the stored price belongs to. Plus is the default for older rows. */
export function billingPlanForPriceId(priceId, env = process.env) {
  if (!priceId) return null;
  const cloudPriceId = env.STRIPE_CLOUD_PRICE_ID?.trim();
  return cloudPriceId && priceId === cloudPriceId ? "cloud" : "plus";
}

export function mapBillingRow(row, env = process.env) {
  const status = normalizeBillingStatus(row?.billing_status);
  const trialCallsUsed = normalizeTrialCallsUsed(row?.trial_api_calls_used);
  const trialCallsLimit = normalizeTrialCallsLimit(row?.trial_api_calls_limit);
  const trialCallsRemaining = Math.max(trialCallsLimit - trialCallsUsed, 0);
  const creditBalanceMicros = Math.max(
    Number(row?.hosted_credit_balance_micros ?? 0),
    0,
  );
  const accessKind =
    row?.role === "admin"
      ? "admin"
      : billingStatusHasAccess(status)
        ? "subscription"
        : creditBalanceMicros > 0
          ? "credits"
          : "none";

  const priceId =
    typeof row?.billing_price_id === "string" && row.billing_price_id
      ? row.billing_price_id
      : null;

  return {
    accessKind,
    cancelAtPeriodEnd: Boolean(row?.billing_cancel_at_period_end),
    creditBalanceMicros,
    currentPeriodEnd: serializeBillingPeriodEnd(row?.billing_current_period_end),
    hasAccess: row?.role === "admin" || creditBalanceMicros > 0,
    hasCustomer: Boolean(row?.stripe_customer_id),
    plan: billingPlanForPriceId(priceId, env),
    priceId,
    status,
    trialCallsLimit,
    trialCallsRemaining,
    trialCallsUsed,
  };
}
