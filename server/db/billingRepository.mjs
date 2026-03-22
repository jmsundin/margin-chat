export async function getUserBillingAccount(client, userId) {
  const result = await client.query(
    `
      select
        id,
        email,
        display_name,
        stripe_customer_id,
        stripe_subscription_id,
        billing_status,
        billing_price_id,
        billing_current_period_end,
        billing_cancel_at_period_end
      from marginchat_user_accounts
      where id = $1
    `,
    [userId],
  );

  if (!result.rowCount) {
    return null;
  }

  return mapBillingAccountRow(result.rows[0]);
}

export async function updateStripeCustomerId(
  client,
  { stripeCustomerId, userId },
) {
  const result = await client.query(
    `
      update marginchat_user_accounts
      set
        stripe_customer_id = $1,
        updated_at = now()
      where id = $2
      returning
        id,
        email,
        display_name,
        stripe_customer_id,
        stripe_subscription_id,
        billing_status,
        billing_price_id,
        billing_current_period_end,
        billing_cancel_at_period_end
    `,
    [stripeCustomerId, userId],
  );

  return result.rowCount ? mapBillingAccountRow(result.rows[0]) : null;
}

export async function syncUserBillingByCustomerId(
  client,
  {
    billingCancelAtPeriodEnd,
    billingCurrentPeriodEnd,
    billingPriceId,
    billingStatus,
    stripeCustomerId,
    stripeSubscriptionId,
  },
) {
  const result = await client.query(
    `
      update marginchat_user_accounts
      set
        stripe_customer_id = $1,
        stripe_subscription_id = $2,
        billing_status = $3,
        billing_price_id = $4,
        billing_current_period_end = $5,
        billing_cancel_at_period_end = $6,
        updated_at = now()
      where stripe_customer_id = $1
      returning
        id,
        email,
        display_name,
        stripe_customer_id,
        stripe_subscription_id,
        billing_status,
        billing_price_id,
        billing_current_period_end,
        billing_cancel_at_period_end
    `,
    [
      stripeCustomerId,
      stripeSubscriptionId,
      billingStatus,
      billingPriceId,
      billingCurrentPeriodEnd,
      billingCancelAtPeriodEnd,
    ],
  );

  return result.rowCount ? mapBillingAccountRow(result.rows[0]) : null;
}

export async function syncUserBillingById(
  client,
  {
    billingCancelAtPeriodEnd,
    billingCurrentPeriodEnd,
    billingPriceId,
    billingStatus,
    stripeCustomerId,
    stripeSubscriptionId,
    userId,
  },
) {
  const result = await client.query(
    `
      update marginchat_user_accounts
      set
        stripe_customer_id = $1,
        stripe_subscription_id = $2,
        billing_status = $3,
        billing_price_id = $4,
        billing_current_period_end = $5,
        billing_cancel_at_period_end = $6,
        updated_at = now()
      where id = $7
      returning
        id,
        email,
        display_name,
        stripe_customer_id,
        stripe_subscription_id,
        billing_status,
        billing_price_id,
        billing_current_period_end,
        billing_cancel_at_period_end
    `,
    [
      stripeCustomerId,
      stripeSubscriptionId,
      billingStatus,
      billingPriceId,
      billingCurrentPeriodEnd,
      billingCancelAtPeriodEnd,
      userId,
    ],
  );

  return result.rowCount ? mapBillingAccountRow(result.rows[0]) : null;
}

export async function incrementTrialApiCallsUsed(client, userId) {
  const result = await client.query(
    `
      update marginchat_user_accounts
      set
        trial_api_calls_used = least(trial_api_calls_used + 1, trial_api_calls_limit),
        updated_at = now()
      where id = $1
      returning
        trial_api_calls_used,
        trial_api_calls_limit
    `,
    [userId],
  );

  if (!result.rowCount) {
    return null;
  }

  return {
    trialCallsLimit: result.rows[0].trial_api_calls_limit,
    trialCallsUsed: result.rows[0].trial_api_calls_used,
  };
}

function mapBillingAccountRow(row) {
  return {
    billingCancelAtPeriodEnd: Boolean(row.billing_cancel_at_period_end),
    billingCurrentPeriodEnd: row.billing_current_period_end ?? null,
    billingPriceId: row.billing_price_id ?? null,
    billingStatus: row.billing_status ?? "inactive",
    displayName: row.display_name,
    email: row.email,
    id: row.id,
    stripeCustomerId: row.stripe_customer_id ?? null,
    stripeSubscriptionId: row.stripe_subscription_id ?? null,
  };
}
