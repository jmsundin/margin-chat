import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { HttpError } from "../lib/errors.mjs";
import { billingStatusHasAccess, normalizeBillingStatus } from "./status.mjs";
import {
  BILLING_PLAN, MONTHLY_PLAN_CENTS, MONTHLY_PLAN_MICROS, MONTHLY_PLAN_KEY,
  invoiceLinePriceId, invoiceSubscriptionId, isMonthlyPrice, monthlyInvoiceLine,
  stripeId, topUpAmount, validateTopUpCents,
} from "./plan.mjs";
import { verifyInvoicePayments, verifyPaymentIntent } from "./payments.mjs";

function getPositiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function requireUsageAmount(amount, allowZero = false) {
  if (!Number.isSafeInteger(amount) || amount < (allowZero ? 0 : 1)) {
    throw new HttpError(400, "Usage must be a safe integer amount in millionths of a dollar.");
  }
}

function checkoutUserId(session) {
  const metadataId = session?.metadata?.userId;
  const referenceId = session?.client_reference_id;
  if (metadataId && referenceId && metadataId !== referenceId) return null;
  return metadataId || referenceId || null;
}

function subscriptionPeriodEnd(subscription) {
  const ends = (subscription?.items?.data ?? []).map((item) => item.current_period_end)
    .filter((value) => Number.isFinite(value));
  const timestamp = ends.length ? Math.max(...ends) : subscription?.current_period_end;
  return Number.isFinite(timestamp) ? new Date(timestamp * 1000) : null;
}

function subscriptionCancellation(subscription, periodEnd) {
  const cancelAt = Number.isSafeInteger(subscription.cancel_at)
    ? new Date(subscription.cancel_at * 1000) : null;
  // Portal cancellation can use cancel_at while cancel_at_period_end is false.
  // Only this period's scheduled stop suppresses the next-renewal message.
  const stopsThisPeriod = Boolean(cancelAt && periodEnd && cancelAt.getTime() > Date.now()
    && cancelAt.getTime() <= periodEnd.getTime());
  return {
    cancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end) || stopsThisPeriod,
    // If Stripe schedules an earlier stop, display its actual funding end.
    currentPeriodEnd: stopsThisPeriod ? cancelAt : periodEnd,
  };
}

function getRequestOrigin(request, env) {
  const configuredOrigin =
    env.APP_URL ?? env.PUBLIC_APP_URL ?? env.NEXT_PUBLIC_APP_URL ?? null;

  if (configuredOrigin) {
    return configuredOrigin.replace(/\/+$/u, "");
  }

  const forwardedProtocolHeader = request.headers["x-forwarded-proto"];
  const forwardedProtocol = Array.isArray(forwardedProtocolHeader)
    ? forwardedProtocolHeader[0]
    : forwardedProtocolHeader;
  const protocol = (forwardedProtocol ?? "http").split(",")[0].trim() || "http";
  const forwardedHostHeader = request.headers["x-forwarded-host"];
  const hostHeader = request.headers.host;
  const host = Array.isArray(forwardedHostHeader)
    ? forwardedHostHeader[0]
    : forwardedHostHeader ??
      (Array.isArray(hostHeader) ? hostHeader[0] : hostHeader);

  if (!host) {
    throw new HttpError(
      500,
      "Unable to resolve the app origin for Stripe redirects.",
    );
  }

  return `${protocol}://${host}`;
}

export function createBillingService({ database, env, stripeClient = null }) {
  const configuredPriceId = env.STRIPE_PRICE_ID || null;
  function getClient() {
    if (stripeClient) return stripeClient;
    if (!env.STRIPE_SECRET_KEY) throw new HttpError(503, "Stripe billing is not configured. Add STRIPE_SECRET_KEY first.");
    return new Stripe(env.STRIPE_SECRET_KEY);
  }

  function getHostedUsageLimits(payload, { validateInput = true } = {}) {
    const maxInputCharacters = getPositiveInteger(
      env.HOSTED_MAX_INPUT_CHARACTERS,
      60_000,
    );
    const maxOutputTokens = getPositiveInteger(
      env.HOSTED_MAX_OUTPUT_TOKENS,
      2_000,
    );
    const inputCharacters = JSON.stringify(payload).length;

    if (validateInput && inputCharacters > maxInputCharacters) {
      throw new HttpError(
        413,
        `This hosted request is too large (${inputCharacters.toLocaleString()} characters). The current limit is ${maxInputCharacters.toLocaleString()}. Use a personal API key or shorten the conversation.`,
      );
    }

    return { maxInputCharacters, maxOutputTokens };
  }


  async function reserveHostedRequest({ requestId, userId, amountMicros, metadata = {} }) {
    requireUsageAmount(amountMicros);
    const balanceMicros = await database.chargeHostedRequest({ amountMicros, ledgerId: randomUUID(), requestId, userId, metadata });
    if (balanceMicros === null) throw new HttpError(402, "Your prepaid balance is too low for this request. Add money or use a personal API key.");
    return { amountMicros, balanceMicros };
  }

  async function settleHostedRequest({ requestId, userId, amountMicros, metadata = {} }) {
    requireUsageAmount(amountMicros, true);
    return database.settleHostedRequest({ requestId, userId, amountMicros, metadata });
  }

  async function refundHostedRequest({ amountMicros, requestId, userId }) {
    requireUsageAmount(amountMicros);
    return database.refundHostedRequest({ amountMicros, ledgerId: randomUUID(), requestId, userId });
  }

  async function ensureCustomerForUser(user) {
    const stripe = getClient();
    const account = await database.getUserBillingAccount(user.id);
    if (!account) throw new HttpError(404, "User account not found.");
    const details = { email: account.email, name: account.displayName, metadata: { userId: account.id } };
    if (account.stripeCustomerId) {
      await stripe.customers.update(account.stripeCustomerId, details);
      return { ...account, customerId: account.stripeCustomerId };
    }
    const customer = await stripe.customers.create(details, { idempotencyKey: `margin-customer:${account.id}` });
    await database.updateStripeCustomerId({ stripeCustomerId: customer.id, userId: account.id });
    return { ...account, stripeCustomerId: customer.id, customerId: customer.id };
  }

  async function retrieveMonthlyPrice(priceId, requireActive = false) {
    if (!priceId || (configuredPriceId && priceId !== configuredPriceId)) return null;
    const price = await getClient().prices.retrieve(priceId, { expand: ["product"] });
    return isMonthlyPrice(price, configuredPriceId, { requireActive }) ? price : null;
  }

  async function isPlanSubscription(subscription) {
    const items = subscription?.items;
    if (!items || items.has_more || items.data?.length !== 1 || items.data[0].quantity !== 1) return false;
    if (!configuredPriceId && subscription.metadata?.planKey !== MONTHLY_PLAN_KEY) return false;
    return Boolean(await retrieveMonthlyPrice(stripeId(items.data[0].price)));
  }

  async function resolveOwner({ customerId, metadataUserId = null, expectedUserId = null }) {
    if (!customerId) throw new HttpError(409, "The Stripe payment has no customer.");
    if (expectedUserId && metadataUserId && expectedUserId !== metadataUserId) {
      throw new HttpError(403, "This Stripe payment belongs to another account.");
    }
    const stripe = getClient();
    let customer;
    let userId = expectedUserId ?? metadataUserId;
    if (!userId) {
      customer = await stripe.customers.retrieve(customerId);
      userId = customer?.metadata?.userId;
    }
    if (!userId) return null;
    const account = await database.getUserBillingAccount(userId);
    if (!account) throw new HttpError(404, "The Stripe payment's user account was not found.");
    if (account.stripeCustomerId && account.stripeCustomerId !== customerId) {
      throw new HttpError(403, "The Stripe customer does not match this account.");
    }
    if (!account.stripeCustomerId) {
      customer ??= await stripe.customers.retrieve(customerId);
      if (customer.deleted || customer.metadata?.userId !== account.id
        || typeof customer.email !== "string" || customer.email.toLowerCase() !== account.email.toLowerCase()) {
        throw new HttpError(403, "The Stripe customer could not be verified for this account.");
      }
      await database.updateStripeCustomerId({ stripeCustomerId: customerId, userId: account.id });
    }
    return { ...account, stripeCustomerId: customerId };
  }

  async function syncCurrentSubscription(subscription, account, attempt = 0) {
    const stripe = getClient();
    let current = subscription;
    // A late cancellation of an older subscription must not replace a newer one.
    if (account.stripeSubscriptionId && account.stripeSubscriptionId !== current.id) {
      const stored = await stripe.subscriptions.retrieve(account.stripeSubscriptionId);
      if (stripeId(stored.customer) !== account.stripeCustomerId) throw new HttpError(403, "Subscription customer mismatch.");
      if (!Number.isFinite(current.created) || (stored.created ?? Infinity) >= current.created) current = stored;
    }
    const validPlan = await isPlanSubscription(current);
    if (!validPlan && account.stripeSubscriptionId !== current.id) return account;
    const cancellation = subscriptionCancellation(current, subscriptionPeriodEnd(current));
    const updated = await database.syncUserBillingById({
      userId: account.id,
      expectedStripeSubscriptionId: account.stripeSubscriptionId ?? null,
      expectedBillingRevision: account.billingRevision,
      stripeCustomerId: account.stripeCustomerId,
      stripeSubscriptionId: current.id,
      billingStatus: validPlan ? normalizeBillingStatus(current.status) : "inactive",
      billingPriceId: stripeId(current.items?.data?.[0]?.price),
      billingCancelAtPeriodEnd: cancellation.cancelAtPeriodEnd,
      billingCurrentPeriodEnd: cancellation.currentPeriodEnd,
    });
    if (updated) return updated;
    if (attempt >= 2) throw new HttpError(409, "Subscription changed while syncing. Retry this request.");
    const latestAccount = await database.getUserBillingAccount(account.id);
    if (!latestAccount) throw new HttpError(404, "User account not found.");
    const latestSubscription = await stripe.subscriptions.retrieve(subscription.id);
    return syncCurrentSubscription(latestSubscription, latestAccount, attempt + 1);
  }

  async function retrieveAndSyncSubscription(subscriptionId, expectedUserId = null) {
    let subscription = await getClient().subscriptions.retrieve(subscriptionId);
    const account = await resolveOwner({
      customerId: stripeId(subscription.customer), metadataUserId: subscription.metadata?.userId, expectedUserId,
    });
    if (account) {
      // Read Stripe after the account revision snapshot. Otherwise a concurrent
      // cancellation could commit before we read the revision and escape CAS.
      subscription = await getClient().subscriptions.retrieve(subscriptionId);
      if (stripeId(subscription.customer) !== account.stripeCustomerId
        || (subscription.metadata?.userId && subscription.metadata.userId !== account.id)) {
        throw new HttpError(403, "Subscription ownership changed while syncing.");
      }
      await syncCurrentSubscription(subscription, account);
    }
    return { subscription, account };
  }

  async function createSubscriptionCheckoutSession({ request, user }) {
    if (user.role === "admin") throw new HttpError(409, "Admin accounts do not require a subscription.");
    const stripe = getClient();
    let lineItem;
    if (configuredPriceId) {
      if (!await retrieveMonthlyPrice(configuredPriceId, true)) {
        throw new HttpError(503, "STRIPE_PRICE_ID must be an active $20.00 USD monthly, licensed, single-unit price.");
      }
      lineItem = { price: configuredPriceId, quantity: 1 };
    } else {
      lineItem = { quantity: 1, price_data: {
        currency: "usd", unit_amount: MONTHLY_PLAN_CENTS, recurring: { interval: "month" },
        product_data: { name: "Margin Chat monthly balance", metadata: { marginChatPlan: MONTHLY_PLAN_KEY } },
      } };
    }
    const account = await database.getUserBillingAccount(user.id);
    if (!account) throw new HttpError(404, "User account not found.");
    if (billingStatusHasAccess(account.billingStatus)) throw new HttpError(409, "Your subscription is already active. Manage billing instead.");
    const { customerId } = await ensureCustomerForUser(user);
    const origin = getRequestOrigin(request, env);
    const session = await stripe.checkout.sessions.create({
      mode: "subscription", customer: customerId, client_reference_id: user.id,
      line_items: [lineItem], allow_promotion_codes: false, payment_method_types: ["card"],
      metadata: { purchaseKind: "subscription", planKey: MONTHLY_PLAN_KEY, userId: user.id },
      subscription_data: { metadata: { purchaseKind: "subscription", planKey: MONTHLY_PLAN_KEY, userId: user.id } },
      cancel_url: `${origin}/?checkout=subscription_canceled`,
      success_url: `${origin}/?checkout=subscription_success&session_id={CHECKOUT_SESSION_ID}`,
    });
    if (!session.url) throw new HttpError(500, "Stripe did not return a checkout URL.");
    return { url: session.url };
  }

  async function createTopUpCheckoutSession({ request, user, amountCents }) {
    validateTopUpCents(amountCents);
    const stripe = getClient();
    const { customerId, email } = await ensureCustomerForUser(user);
    const origin = getRequestOrigin(request, env);
    const metadata = { purchaseKind: "hosted_credits", userId: user.id, amountCents: String(amountCents), creditAmountMicros: String(amountCents * 10_000) };
    const session = await stripe.checkout.sessions.create({
      mode: "payment", customer: customerId, client_reference_id: user.id,
      allow_promotion_codes: false, payment_method_types: ["card"],
      line_items: [{ quantity: 1, price_data: {
        currency: "usd", unit_amount: amountCents,
        product_data: { name: "Margin Chat prepaid balance", metadata: { purchaseKind: "hosted_credits" } },
      } }],
      metadata, payment_intent_data: { metadata, receipt_email: email },
      cancel_url: `${origin}/?checkout=topup_canceled`,
      success_url: `${origin}/?checkout=topup_success&session_id={CHECKOUT_SESSION_ID}`,
    });
    if (!session.url) throw new HttpError(500, "Stripe did not return a checkout URL.");
    return { url: session.url };
  }

  async function creditPaidInvoice(invoiceId, expectedUserId = null, expectedSubscriptionId = null) {
    const stripe = getClient();
    const invoice = await stripe.invoices.retrieve(invoiceId, { expand: ["payments.data.payment.payment_intent"] });
    const line = monthlyInvoiceLine(invoice);
    const subscriptionId = invoiceSubscriptionId(invoice);
    if (!line || (expectedSubscriptionId && subscriptionId !== expectedSubscriptionId)) return null;
    if (!await retrieveMonthlyPrice(invoiceLinePriceId(line))) return null;
    const { subscription, account } = await retrieveAndSyncSubscription(subscriptionId, expectedUserId);
    if (!account || stripeId(invoice.customer) !== stripeId(subscription.customer)) return null;
    if (!configuredPriceId && subscription.metadata?.planKey !== MONTHLY_PLAN_KEY) return null;
    const payment = await verifyInvoicePayments(stripe, invoice, account.stripeCustomerId);
    if (!payment) return null;
    const credited = await database.creditHostedBalance({
      amountMicros: MONTHLY_PLAN_MICROS, ledgerId: randomUUID(), stripeInvoiceId: invoice.id,
      userId: account.id, description: "Monthly subscription balance", receiptUrl: payment.receiptUrl ?? invoice.hosted_invoice_url ?? null,
      metadata: { subscriptionId, invoiceNumber: invoice.number ?? null, billingReason: invoice.billing_reason },
    });
    return { credited, amountMicros: MONTHLY_PLAN_MICROS, status: normalizeBillingStatus(subscription.status) };
  }

  async function fulfillCheckout(session, expectedUserId = null) {
    const userId = checkoutUserId(session);
    if (!userId || (expectedUserId && userId !== expectedUserId)) throw new HttpError(403, "This Stripe Checkout Session does not belong to your purchase.");
    const customerId = stripeId(session.customer);
    const account = await resolveOwner({ customerId, metadataUserId: userId, expectedUserId });
    if (!account) throw new HttpError(403, "This Stripe Checkout Session has no verified owner.");
    if (session.mode === "subscription") {
      const subscriptionId = stripeId(session.subscription);
      if (!subscriptionId) return { confirmed: false, status: "incomplete" };
      const { subscription } = await retrieveAndSyncSubscription(subscriptionId, account.id);
      if (stripeId(subscription.customer) !== customerId || !await isPlanSubscription(subscription)) {
        throw new HttpError(409, "This Checkout Session does not contain the $20 Margin Chat monthly plan.");
      }
      if (session.status !== "complete" || session.payment_status !== "paid" || !stripeId(session.invoice)) {
        return { confirmed: false, status: normalizeBillingStatus(subscription.status) };
      }
      const credit = await creditPaidInvoice(stripeId(session.invoice), account.id, subscriptionId);
      if (!credit) return { confirmed: false, status: normalizeBillingStatus(subscription.status) };
      return { confirmed: true, purchaseKind: "subscription", ...credit };
    }
    if (session.mode !== "payment" || session.metadata?.purchaseKind !== "hosted_credits") {
      throw new HttpError(409, "This Checkout Session is not a Margin Chat purchase.");
    }
    const amountCents = topUpAmount(session);
    if (!amountCents) return { confirmed: false, status: session.payment_status ?? "unpaid" };
    const payment = await verifyPaymentIntent(getClient(), session.payment_intent, { customerId, amountCents, exact: true });
    if (!payment || payment.intent.metadata?.userId !== account.id
      || payment.intent.metadata?.purchaseKind !== "hosted_credits"
      || payment.intent.metadata?.creditAmountMicros !== String(amountCents * 10_000)) {
      return { confirmed: false, status: "unpaid" };
    }
    const credited = await database.creditHostedBalance({
      amountMicros: amountCents * 10_000, ledgerId: randomUUID(), stripeCheckoutSessionId: session.id,
      userId: account.id, description: "Added prepaid balance", receiptUrl: payment.receiptUrl,
      metadata: { paymentIntentId: payment.intent.id },
    });
    return { confirmed: true, purchaseKind: "hosted_credits", status: "paid", credited, amountMicros: amountCents * 10_000 };
  }

  async function retrieveCheckout(sessionId) {
    return getClient().checkout.sessions.retrieve(sessionId, { expand: ["line_items.data.price.product", "payment_intent.latest_charge"] });
  }

  async function confirmCheckout({ sessionId, user }) {
    if (typeof sessionId !== "string" || !/^cs_[a-zA-Z0-9_]+$/u.test(sessionId)) throw new HttpError(400, "A valid Stripe Checkout Session ID is required.");
    const session = await retrieveCheckout(sessionId);
    const result = await fulfillCheckout(session, user.id);
    if (!result.confirmed) throw new HttpError(409, "Stripe has not verified a paid, eligible purchase yet. Your balance has not been changed.");
    return result;
  }

  async function createBillingPortalSession({ request, user }) {
    const account = await database.getUserBillingAccount(user.id);
    if (!account?.stripeCustomerId) throw new HttpError(409, "No Stripe customer exists for this account yet. Start a plan or add money first.");
    const configuration = env.STRIPE_PORTAL_CONFIGURATION_ID?.trim();
    const session = await getClient().billingPortal.sessions.create({
      customer: account.stripeCustomerId,
      return_url: `${getRequestOrigin(request, env)}/?billing=return`,
      ...(configuration ? { configuration } : {}),
    });
    return { url: session.url };
  }

  async function getBillingDashboard(userId) {
    const dashboard = await database.getBillingDashboard(userId);
    if (!dashboard) throw new HttpError(404, "User account not found.");
    return { ...dashboard, plan: BILLING_PLAN };
  }

  async function handleWebhook({ rawBody, signature }) {
    if (!env.STRIPE_WEBHOOK_SECRET) throw new HttpError(503, "Stripe webhooks are not configured. Add STRIPE_WEBHOOK_SECRET first.");
    if (!signature) throw new HttpError(400, "Stripe-Signature header is required.");
    const stripe = getClient();
    let event;
    try { event = await stripe.webhooks.constructEventAsync(rawBody, signature, env.STRIPE_WEBHOOK_SECRET); }
    catch { throw new HttpError(400, "Unable to verify the Stripe webhook signature."); }
    const object = event.data.object;
    if (["checkout.session.completed", "checkout.session.async_payment_succeeded"].includes(event.type)) {
      const session = await retrieveCheckout(object.id);
      if (session.mode === "subscription" || session.metadata?.purchaseKind === "hosted_credits") await fulfillCheckout(session);
    } else if (["customer.subscription.created", "customer.subscription.updated", "customer.subscription.deleted", "customer.subscription.paused", "customer.subscription.resumed"].includes(event.type)) {
      await retrieveAndSyncSubscription(object.id);
    } else if (["invoice.paid", "invoice.payment_succeeded"].includes(event.type)) {
      await creditPaidInvoice(object.id);
    } else if (event.type === "invoice.payment_failed") {
      const invoice = await stripe.invoices.retrieve(object.id);
      const subscriptionId = invoiceSubscriptionId(invoice);
      if (subscriptionId) await retrieveAndSyncSubscription(subscriptionId);
    }
    return { received: true };
  }

  return {
    createBillingPortalSession, createSubscriptionCheckoutSession, createTopUpCheckoutSession,
    createCheckoutSession: createSubscriptionCheckoutSession,
    confirmCheckout, confirmSubscriptionCheckout: confirmCheckout,
    handleWebhook, getBillingDashboard, getHostedUsageLimits,
    reserveHostedRequest, settleHostedRequest, refundHostedRequest,
  };
}
