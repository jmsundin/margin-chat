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
        billing_cancel_at_period_end,
        hosted_credit_balance_micros
      from marginchat_users
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
      update marginchat_users
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
      update marginchat_users
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
      update marginchat_users
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
      update marginchat_users
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

export async function creditHostedBalance(
  client,
  { amountMicros, ledgerId, stripeCheckoutSessionId, userId },
) {
  await client.query("begin");

  try {
    const ledgerResult = await client.query(
      `
        insert into marginchat_billing_ledger (
          id,
          user_id,
          amount_micros,
          entry_type,
          stripe_checkout_session_id
        )
        values ($1, $2, $3, 'stripe_credit_purchase', $4)
        on conflict (stripe_checkout_session_id) where stripe_checkout_session_id is not null
        do nothing
        returning id
      `,
      [ledgerId, userId, amountMicros, stripeCheckoutSessionId],
    );

    if (ledgerResult.rowCount) {
      await client.query(
        `
          update marginchat_users
          set hosted_credit_balance_micros = hosted_credit_balance_micros + $1,
              updated_at = now()
          where id = $2
        `,
        [amountMicros, userId],
      );
    }

    await client.query("commit");
    return Boolean(ledgerResult.rowCount);
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

export async function chargeHostedRequest(
  client,
  { amountMicros, ledgerId, requestId, userId },
) {
  await client.query("begin");

  try {
    const balanceResult = await client.query(
      `
        update marginchat_users
        set hosted_credit_balance_micros = hosted_credit_balance_micros - $1,
            updated_at = now()
        where id = $2 and hosted_credit_balance_micros >= $1
        returning hosted_credit_balance_micros
      `,
      [amountMicros, userId],
    );

    if (!balanceResult.rowCount) {
      await client.query("rollback");
      return null;
    }

    await client.query(
      `
        insert into marginchat_billing_ledger (
          id,
          user_id,
          amount_micros,
          entry_type,
          request_id
        )
        values ($1, $2, $3 * -1, 'hosted_request', $4)
      `,
      [ledgerId, userId, amountMicros, requestId],
    );
    await client.query("commit");

    return Number(balanceResult.rows[0].hosted_credit_balance_micros);
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

export async function refundHostedRequest(
  client,
  { amountMicros, ledgerId, requestId, userId },
) {
  await client.query("begin");

  try {
    const refundResult = await client.query(
      `
        insert into marginchat_billing_ledger (
          id, user_id, amount_micros, entry_type, request_id
        ) values ($1, $2, $3, 'hosted_request_refund', $4)
        on conflict (request_id)
          where request_id is not null and entry_type = 'hosted_request_refund'
        do nothing
        returning id
      `,
      [ledgerId, userId, amountMicros, requestId],
    );

    if (refundResult.rowCount) {
      await client.query(
        `
          update marginchat_users
          set hosted_credit_balance_micros = hosted_credit_balance_micros + $1,
              updated_at = now()
          where id = $2
        `,
        [amountMicros, userId],
      );
    }

    await client.query("commit");
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
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
