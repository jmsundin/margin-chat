import { randomUUID } from "node:crypto";
import { HttpError } from "../lib/errors.mjs";

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
        hosted_credit_balance_micros,
        billing_revision
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
        billing_cancel_at_period_end,
        hosted_credit_balance_micros,
        billing_revision
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
        billing_revision = billing_revision + 1,
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
        billing_cancel_at_period_end,
        hosted_credit_balance_micros,
        billing_revision
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
    expectedStripeSubscriptionId,
    expectedBillingRevision,
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
        billing_revision = billing_revision + 1,
        updated_at = now()
      where id = $7 and (not $8::boolean or stripe_subscription_id is not distinct from $9::text)
        and (not $10::boolean or billing_revision = $11::bigint)
      returning
        id,
        email,
        display_name,
        stripe_customer_id,
        stripe_subscription_id,
        billing_status,
        billing_price_id,
        billing_current_period_end,
        billing_cancel_at_period_end,
        hosted_credit_balance_micros,
        billing_revision
    `,
    [
      stripeCustomerId,
      stripeSubscriptionId,
      billingStatus,
      billingPriceId,
      billingCurrentPeriodEnd,
      billingCancelAtPeriodEnd,
      userId,
      expectedStripeSubscriptionId !== undefined,
      expectedStripeSubscriptionId ?? null,
      expectedBillingRevision !== undefined,
      expectedBillingRevision ?? 0,
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

function requireMicros(amount, { allowZero = false } = {}) {
  if (!Number.isSafeInteger(amount) || amount < (allowZero ? 0 : 1)) {
    throw new HttpError(400, "Credit amounts must be safe integers in millionths of a dollar.");
  }
}

async function transaction(client, operation) {
  await client.query("begin");
  try {
    const result = await operation();
    await client.query("commit");
    return result;
  } catch (error) {
    await client.query("rollback");
    throw error;
  }
}

async function lockAccount(client, userId) {
  const result = await client.query(
    "select hosted_credit_balance_micros from marginchat_users where id = $1 for update", [userId],
  );
  if (!result.rowCount) throw new HttpError(404, "User account not found.");
  return Number(result.rows[0].hosted_credit_balance_micros);
}

export async function creditHostedBalance(client, {
  amountMicros, ledgerId, stripeCheckoutSessionId = null, stripeInvoiceId = null,
  userId, description = null, receiptUrl = null, metadata = {},
}) {
  requireMicros(amountMicros);
  if (Boolean(stripeCheckoutSessionId) === Boolean(stripeInvoiceId)) {
    throw new HttpError(400, "Exactly one verified Stripe payment source is required.");
  }
  return transaction(client, async () => {
    await lockAccount(client, userId);
    const sourceColumn = stripeInvoiceId ? "stripe_invoice_id" : "stripe_checkout_session_id";
    const sourceId = stripeInvoiceId ?? stripeCheckoutSessionId;
    const prior = await client.query(`select user_id, amount_micros from marginchat_billing_ledger where ${sourceColumn} = $1`, [sourceId]);
    if (prior.rowCount) {
      if (prior.rows[0].user_id !== userId || Number(prior.rows[0].amount_micros) !== amountMicros) {
        throw new HttpError(409, "This Stripe payment has already been credited to a different purchase.");
      }
      // A receipt may become available after the initial webhook.
      if (receiptUrl) await client.query(`update marginchat_billing_ledger set receipt_url = coalesce(receipt_url, $1) where ${sourceColumn} = $2`, [receiptUrl, sourceId]);
      return false;
    }
    await client.query(`insert into marginchat_billing_ledger
      (id, user_id, amount_micros, entry_type, stripe_checkout_session_id, stripe_invoice_id, description, receipt_url, metadata)
      values ($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`, [
      ledgerId, userId, amountMicros, stripeInvoiceId ? "stripe_subscription_credit" : "stripe_credit_purchase",
      stripeCheckoutSessionId, stripeInvoiceId, description, receiptUrl, JSON.stringify(metadata),
    ]);
    await client.query(`update marginchat_users set hosted_credit_balance_micros = hosted_credit_balance_micros + $1, updated_at = now() where id = $2`, [amountMicros, userId]);
    return true;
  });
}

/** Place a hold before any provider request; serialize competing requests per account. */
export async function chargeHostedRequest(client, { amountMicros, requestId, userId, metadata = {} }) {
  requireMicros(amountMicros);
  if (!requestId) throw new HttpError(400, "A usage request ID is required.");
  return transaction(client, async () => {
    const balance = await lockAccount(client, userId);
    const prior = await client.query("select * from marginchat_usage_reservations where request_id = $1", [requestId]);
    if (prior.rowCount) {
      const hold = prior.rows[0];
      if (hold.user_id !== userId || Number(hold.reserved_micros) !== amountMicros || hold.settled_at) {
        throw new HttpError(409, "This usage request ID has already been used.");
      }
      return balance;
    }
    if (balance < amountMicros) return null;
    await client.query(`insert into marginchat_usage_reservations (request_id, user_id, reserved_micros, metadata)
      values ($1,$2,$3,$4::jsonb)`, [requestId, userId, amountMicros, JSON.stringify(metadata)]);
    const updated = await client.query(`update marginchat_users
      set hosted_credit_balance_micros = hosted_credit_balance_micros - $1, updated_at = now()
      where id = $2 and hosted_credit_balance_micros >= $1 returning hosted_credit_balance_micros`, [amountMicros, userId]);
    if (!updated.rowCount) throw new HttpError(409, "Credit balance changed while reserving usage.");
    return Number(updated.rows[0].hosted_credit_balance_micros);
  });
}

/** Settle exactly once, preserving the prepaid boundary even if a provider misreports usage. */
export async function settleHostedRequest(client, { amountMicros, requestId, userId, metadata = {} }) {
  requireMicros(amountMicros, { allowZero: true });
  return transaction(client, async () => {
    const balance = await lockAccount(client, userId);
    const result = await client.query("select * from marginchat_usage_reservations where request_id = $1 and user_id = $2 for update", [requestId, userId]);
    if (!result.rowCount) throw new HttpError(404, "Usage reservation not found.");
    const hold = result.rows[0];
    if (hold.settled_at) return { settled: false, amountMicros: Number(hold.charged_micros), balanceMicros: balance };
    const reserved = Number(hold.reserved_micros);
    if (amountMicros > reserved) throw new HttpError(409, "Usage exceeds its prepaid reservation.");
    const details = { ...hold.metadata, ...metadata };
    await client.query(`update marginchat_usage_reservations set charged_micros=$1, settled_at=now(), metadata=$2::jsonb where request_id=$3`, [amountMicros, JSON.stringify(details), requestId]);
    if (amountMicros > 0) {
      await client.query(`insert into marginchat_billing_ledger (id,user_id,amount_micros,entry_type,request_id,description,metadata)
        values ($1,$2,$3,'hosted_request',$4,$5,$6::jsonb)`, [randomUUID(), userId, -amountMicros, requestId,
        details.model ? `${details.operation ?? "AI usage"} · ${details.model}` : "AI usage", JSON.stringify(details)]);
    }
    await client.query(`update marginchat_users set hosted_credit_balance_micros=hosted_credit_balance_micros+$1, updated_at=now() where id=$2`, [reserved - amountMicros, userId]);
    return { settled: true, amountMicros, balanceMicros: balance + reserved - amountMicros };
  });
}

export async function refundHostedRequest(client, { amountMicros, ledgerId, requestId, userId }) {
  const hold = await client.query("select request_id from marginchat_usage_reservations where request_id=$1 and user_id=$2", [requestId, userId]);
  if (hold.rowCount) return settleHostedRequest(client, { amountMicros: 0, requestId, userId, metadata: { refunded: true } });
  // Compatibility for requests debited by the previous application release.
  requireMicros(amountMicros);
  return transaction(client, async () => {
    await lockAccount(client, userId);
    const charge = await client.query("select amount_micros from marginchat_billing_ledger where user_id=$1 and request_id=$2 and entry_type='hosted_request'", [userId, requestId]);
    if (!charge.rowCount || Number(charge.rows[0].amount_micros) !== -amountMicros) throw new HttpError(409, "Original usage charge does not match this refund.");
    const refund = await client.query(`insert into marginchat_billing_ledger (id,user_id,amount_micros,entry_type,request_id)
      values ($1,$2,$3,'hosted_request_refund',$4)
      on conflict (request_id) where request_id is not null and entry_type='hosted_request_refund' do nothing returning id`, [ledgerId, userId, amountMicros, requestId]);
    if (refund.rowCount) await client.query("update marginchat_users set hosted_credit_balance_micros=hosted_credit_balance_micros+$1, updated_at=now() where id=$2", [amountMicros, userId]);
    return Boolean(refund.rowCount);
  });
}

export async function getBillingDashboard(client, userId) {
  // One transaction provides a coherent balance, holds, and history snapshot.
  return transaction(client, async () => {
    await lockAccount(client, userId);
    const account = await getUserBillingAccount(client, userId);
    const summary = await client.query(`select
      coalesce(sum(amount_micros) filter (where entry_type in ('stripe_credit_purchase','stripe_subscription_credit')),0) as purchased,
      coalesce(-sum(amount_micros) filter (where entry_type in ('hosted_request','hosted_request_refund') and created_at >= date_trunc('month', now() at time zone 'UTC') at time zone 'UTC'),0) as usage
      from marginchat_billing_ledger where user_id=$1`, [userId]);
    const holds = await client.query("select coalesce(sum(reserved_micros),0) as reserved from marginchat_usage_reservations where user_id=$1 and settled_at is null", [userId]);
    const history = await client.query(`select id,amount_micros,entry_type,created_at,description,receipt_url,metadata
      from marginchat_billing_ledger where user_id=$1 order by created_at desc,id desc limit 100`, [userId]);
    return {
      balanceMicros: account.creditBalanceMicros,
      reservedMicros: Number(holds.rows[0].reserved),
      totalPurchasedMicros: Number(summary.rows[0].purchased),
      usageThisMonthMicros: Math.max(0, Number(summary.rows[0].usage)),
      subscription: { status: account.billingStatus, cancelAtPeriodEnd: account.billingCancelAtPeriodEnd,
        currentPeriodEnd: account.billingCurrentPeriodEnd instanceof Date ? account.billingCurrentPeriodEnd.toISOString() : account.billingCurrentPeriodEnd },
      transactions: history.rows.map((row) => ({ id: row.id, amountMicros: Number(row.amount_micros), type: row.entry_type,
        createdAt: row.created_at instanceof Date ? row.created_at.toISOString() : row.created_at,
        description: row.description ?? ({ stripe_credit_purchase: "Credit top-up", stripe_subscription_credit: "Monthly subscription credit", hosted_request: "AI usage", hosted_request_refund: "Usage refund" }[row.entry_type]),
        receiptUrl: row.receipt_url, metadata: row.metadata,
      })),
    };
  });
}

function mapBillingAccountRow(row) {
  return {
    billingCancelAtPeriodEnd: Boolean(row.billing_cancel_at_period_end),
    billingCurrentPeriodEnd: row.billing_current_period_end ?? null,
    billingPriceId: row.billing_price_id ?? null,
    billingStatus: row.billing_status ?? "inactive",
    creditBalanceMicros: Number(row.hosted_credit_balance_micros ?? 0),
    billingRevision: Number(row.billing_revision ?? 0),
    displayName: row.display_name,
    email: row.email,
    id: row.id,
    stripeCustomerId: row.stripe_customer_id ?? null,
    stripeSubscriptionId: row.stripe_subscription_id ?? null,
  };
}
