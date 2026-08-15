import Stripe from "stripe";
import { randomUUID } from "node:crypto";
import { HttpError } from "../lib/errors.mjs";
import { billingStatusHasAccess, normalizeBillingStatus } from "./status.mjs";

function getStripeSecretKey(env) {
  return env.STRIPE_SECRET_KEY ?? null;
}

function getStripeWebhookSecret(env) {
  return env.STRIPE_WEBHOOK_SECRET ?? null;
}

function getStripePriceId(env) {
  return env.STRIPE_PRICE_ID ?? null;
}

function getStripeCreditPriceId(env) {
  return env.STRIPE_CREDIT_PRICE_ID ?? null;
}

function getCreditAmountMicros(env) {
  const amount = Number(env.STRIPE_CREDIT_AMOUNT_MICROS);

  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function getCreditPurchaseAmountCents(env) {
  const amountMicros = getCreditAmountMicros(env);

  return amountMicros && amountMicros % 10_000 === 0
    ? amountMicros / 10_000
    : null;
}

function getHostedRequestPriceMicros(env) {
  const amount = Number(env.HOSTED_API_REQUEST_PRICE_MICROS);

  return Number.isSafeInteger(amount) && amount > 0 ? amount : null;
}

function getPositiveInteger(value, fallback) {
  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

function getStripeClient(env) {
  const secretKey = getStripeSecretKey(env);

  if (!secretKey) {
    throw new HttpError(
      503,
      "Stripe billing is not configured. Add STRIPE_SECRET_KEY first.",
    );
  }

  return new Stripe(secretKey);
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

function serializePeriodEnd(unixTimestamp) {
  if (typeof unixTimestamp !== "number" || Number.isNaN(unixTimestamp)) {
    return null;
  }

  return new Date(unixTimestamp * 1000);
}

function getSubscriptionCustomerId(subscription) {
  if (!subscription?.customer) {
    return null;
  }

  return typeof subscription.customer === "string"
    ? subscription.customer
    : subscription.customer.id;
}

function getSubscriptionPriceId(subscription) {
  return subscription?.items?.data?.[0]?.price?.id ?? null;
}

function getSubscriptionPeriodEnd(subscription) {
  const itemPeriodEnds = (subscription?.items?.data ?? [])
    .map((item) => item?.current_period_end)
    .filter((value) => typeof value === "number" && !Number.isNaN(value));

  if (itemPeriodEnds.length) {
    return Math.max(...itemPeriodEnds);
  }

  return subscription?.current_period_end ?? null;
}

function getCheckoutSessionUserId(session) {
  if (typeof session?.metadata?.userId === "string" && session.metadata.userId) {
    return session.metadata.userId;
  }

  return typeof session?.client_reference_id === "string" &&
    session.client_reference_id
    ? session.client_reference_id
    : null;
}

function getInvoiceSubscriptionId(invoice) {
  const subscription =
    invoice?.subscription ??
    invoice?.parent?.subscription_details?.subscription ??
    null;

  if (!subscription) {
    return null;
  }

  return typeof subscription === "string" ? subscription : subscription.id;
}

export function createBillingService({ database, env, stripeClient = null }) {
  function getClient() {
    return stripeClient ?? getStripeClient(env);
  }

  function getHostedUsageLimits(payload) {
    const maxInputCharacters = getPositiveInteger(
      env.HOSTED_MAX_INPUT_CHARACTERS,
      60_000,
    );
    const maxOutputTokens = getPositiveInteger(
      env.HOSTED_MAX_OUTPUT_TOKENS,
      2_000,
    );
    const inputCharacters = JSON.stringify(payload).length;

    if (inputCharacters > maxInputCharacters) {
      throw new HttpError(
        413,
        `This hosted request is too large (${inputCharacters.toLocaleString()} characters). The current limit is ${maxInputCharacters.toLocaleString()}. Use a personal API key or shorten the conversation.`,
      );
    }

    return { maxInputCharacters, maxOutputTokens };
  }

  async function reserveHostedRequest({ requestId, userId }) {
    const amountMicros = getHostedRequestPriceMicros(env);

    if (!amountMicros) {
      throw new HttpError(
        503,
        "Hosted credit usage requires HOSTED_API_REQUEST_PRICE_MICROS.",
      );
    }

    const balanceMicros = await database.chargeHostedRequest({
      amountMicros,
      ledgerId: randomUUID(),
      requestId,
      userId,
    });

    if (balanceMicros === null) {
      throw new HttpError(
        402,
        "Your hosted credit balance is too low for another request. Add credits or use a personal API key.",
      );
    }

    return { amountMicros, balanceMicros };
  }

  async function refundHostedRequest({ amountMicros, requestId, userId }) {
    await database.refundHostedRequest({
      amountMicros,
      ledgerId: randomUUID(),
      requestId,
      userId,
    });
  }

  async function ensureCustomerForUser(user) {
    const stripe = getClient();
    const billingAccount = await database.getUserBillingAccount(user.id);

    if (!billingAccount) {
      throw new HttpError(404, "User account not found.");
    }

    if (billingAccount.stripeCustomerId) {
      await stripe.customers.update(billingAccount.stripeCustomerId, {
        email: billingAccount.email,
        metadata: {
          userId: billingAccount.id,
        },
        name: billingAccount.displayName,
      });

      return billingAccount.stripeCustomerId;
    }

    const customer = await stripe.customers.create({
      email: billingAccount.email,
      metadata: {
        userId: billingAccount.id,
      },
      name: billingAccount.displayName,
    });

    await database.updateStripeCustomerId({
      stripeCustomerId: customer.id,
      userId: billingAccount.id,
    });

    return customer.id;
  }

  async function syncSubscription({
    customerId,
    fallbackUserId = null,
    subscription,
  }) {
    const normalizedStatus = normalizeBillingStatus(subscription.status);
    const syncArgs = {
      billingCancelAtPeriodEnd: Boolean(subscription.cancel_at_period_end),
      billingCurrentPeriodEnd: serializePeriodEnd(
        getSubscriptionPeriodEnd(subscription),
      ),
      billingPriceId: getSubscriptionPriceId(subscription),
      billingStatus: normalizedStatus,
      stripeCustomerId: customerId,
      stripeSubscriptionId: subscription.id,
    };

    if (fallbackUserId) {
      return database.syncUserBillingById({
        ...syncArgs,
        userId: fallbackUserId,
      });
    }

    if (!customerId) {
      return null;
    }

    return database.syncUserBillingByCustomerId(syncArgs);
  }

  async function retrieveAndSyncSubscription({
    customerId = null,
    fallbackUserId = null,
    subscriptionId,
  }) {
    const stripe = getClient();
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);

    return syncSubscription({
      customerId: customerId ?? getSubscriptionCustomerId(subscription),
      fallbackUserId,
      subscription,
    });
  }

  async function createSubscriptionCheckoutSession({ request, user }) {
    const priceId = getStripePriceId(env);

    if (!priceId) {
      throw new HttpError(
        503,
        "Stripe subscriptions are not configured. Add STRIPE_PRICE_ID first.",
      );
    }

    if (user.role === "admin") {
      throw new HttpError(
        409,
        "Admin accounts do not require a subscription to use the models.",
      );
    }

    if (billingStatusHasAccess(user.billing.status)) {
      throw new HttpError(
        409,
        "Your subscription is already active. Manage billing instead.",
      );
    }

    const stripe = getClient();
    const customerId = await ensureCustomerForUser(user);
    const origin = getRequestOrigin(request, env);
    const session = await stripe.checkout.sessions.create({
      allow_promotion_codes: true,
      cancel_url: `${origin}/?checkout=subscription_canceled`,
      client_reference_id: user.id,
      customer: customerId,
      line_items: [{ price: priceId, quantity: 1 }],
      metadata: {
        purchaseKind: "subscription",
        userId: user.id,
      },
      mode: "subscription",
      payment_method_types: ["card"],
      success_url: `${origin}/?checkout=subscription_success&session_id={CHECKOUT_SESSION_ID}`,
      subscription_data: {
        metadata: {
          userId: user.id,
        },
      },
    });

    if (!session.url) {
      throw new HttpError(500, "Stripe did not return a checkout URL.");
    }

    return { url: session.url };
  }

  async function confirmSubscriptionCheckout({ sessionId, user }) {
    if (typeof sessionId !== "string" || !sessionId.startsWith("cs_")) {
      throw new HttpError(400, "A valid Stripe Checkout Session ID is required.");
    }

    const stripe = getClient();
    const session = await stripe.checkout.sessions.retrieve(sessionId, {
      expand: ["subscription"],
    });

    if (
      session.mode !== "subscription" ||
      getCheckoutSessionUserId(session) !== user.id
    ) {
      throw new HttpError(
        403,
        "This Stripe Checkout Session does not belong to your subscription purchase.",
      );
    }

    if (session.status !== "complete" || !session.subscription) {
      throw new HttpError(409, "Stripe Checkout has not completed this subscription yet.");
    }

    const customerId =
      typeof session.customer === "string"
        ? session.customer
        : session.customer?.id ?? null;
    const subscription =
      typeof session.subscription === "string"
        ? await stripe.subscriptions.retrieve(session.subscription)
        : session.subscription;
    const configuredPriceId = getStripePriceId(env);

    if (!configuredPriceId || getSubscriptionPriceId(subscription) !== configuredPriceId) {
      throw new HttpError(
        409,
        "This Checkout Session does not contain the configured Margin Chat subscription.",
      );
    }

    if (customerId) {
      await database.updateStripeCustomerId({
        stripeCustomerId: customerId,
        userId: user.id,
      });
    }

    await syncSubscription({
      customerId: customerId ?? getSubscriptionCustomerId(subscription),
      fallbackUserId: user.id,
      subscription,
    });

    return {
      confirmed: billingStatusHasAccess(normalizeBillingStatus(subscription.status)),
      status: normalizeBillingStatus(subscription.status),
    };
  }

  async function createCheckoutSession({ request, user }) {
    const creditPriceId = getStripeCreditPriceId(env);
    const creditAmountMicros = getCreditAmountMicros(env);
    const creditPurchaseAmountCents = getCreditPurchaseAmountCents(env);

    if (creditPriceId || creditAmountMicros) {
      if (!creditPriceId || !creditAmountMicros || !creditPurchaseAmountCents) {
        throw new HttpError(
          503,
          "Stripe credits require STRIPE_CREDIT_PRICE_ID and a cent-aligned STRIPE_CREDIT_AMOUNT_MICROS.",
        );
      }

      const stripe = getClient();
      const customerId = await ensureCustomerForUser(user);
      const origin = getRequestOrigin(request, env);
      const session = await stripe.checkout.sessions.create({
        cancel_url: `${origin}/?checkout=canceled`,
        client_reference_id: user.id,
        customer: customerId,
        line_items: [{ price: creditPriceId, quantity: 1 }],
        metadata: {
          creditAmountMicros: String(creditAmountMicros),
          purchaseKind: "hosted_credits",
          userId: user.id,
        },
        mode: "payment",
        payment_method_types: ["card"],
        success_url: `${origin}/?checkout=success&session_id={CHECKOUT_SESSION_ID}`,
      });

      if (!session.url) {
        throw new HttpError(500, "Stripe did not return a checkout URL.");
      }

      return { url: session.url };
    }

    const priceId = getStripePriceId(env);

    if (!priceId) {
      throw new HttpError(
        503,
        "Stripe billing is not configured. Add STRIPE_PRICE_ID first.",
      );
    }

    if (user.role === "admin") {
      throw new HttpError(
        409,
        "Admin accounts do not require a subscription to use the models.",
      );
    }

    if (billingStatusHasAccess(user.billing.status)) {
      throw new HttpError(
        409,
        "Your paid plan is already active. Manage billing instead.",
      );
    }

    const stripe = getClient();
    const customerId = await ensureCustomerForUser(user);
    const origin = getRequestOrigin(request, env);
    const session = await stripe.checkout.sessions.create({
      allow_promotion_codes: true,
      cancel_url: `${origin}/?checkout=canceled`,
      client_reference_id: user.id,
      customer: customerId,
      line_items: [
        {
          price: priceId,
          quantity: 1,
        },
      ],
      metadata: {
        userId: user.id,
      },
      mode: "subscription",
      success_url: `${origin}/?checkout=success`,
      subscription_data: {
        metadata: {
          userId: user.id,
        },
      },
    });

    if (!session.url) {
      throw new HttpError(500, "Stripe did not return a checkout URL.");
    }

    return {
      url: session.url,
    };
  }

  async function createBillingPortalSession({ request, user }) {
    const stripe = getClient();
    const billingAccount = await database.getUserBillingAccount(user.id);

    if (!billingAccount?.stripeCustomerId) {
      throw new HttpError(
        409,
        "No Stripe customer exists for this account yet. Start a plan first.",
      );
    }

    const origin = getRequestOrigin(request, env);
    const session = await stripe.billingPortal.sessions.create({
      customer: billingAccount.stripeCustomerId,
      return_url: `${origin}/?billing=return`,
    });

    return {
      url: session.url,
    };
  }

  async function handleWebhook({ rawBody, signature }) {
    const webhookSecret = getStripeWebhookSecret(env);

    if (!webhookSecret) {
      throw new HttpError(
        503,
        "Stripe webhooks are not configured. Add STRIPE_WEBHOOK_SECRET first.",
      );
    }

    if (!signature) {
      throw new HttpError(400, "Stripe-Signature header is required.");
    }

    const stripe = getClient();
    let event;

    try {
      event = stripe.webhooks.constructEvent(rawBody, signature, webhookSecret);
    } catch {
      throw new HttpError(400, "Unable to verify the Stripe webhook signature.");
    }

    if (event.type === "checkout.session.completed") {
      const session = event.data.object;
      const customerId =
        typeof session.customer === "string" ? session.customer : null;
      const userId = getCheckoutSessionUserId(session);

      if (userId && customerId) {
        await database.updateStripeCustomerId({
          stripeCustomerId: customerId,
          userId,
        });
      }

      if (
        userId &&
        session.mode === "payment" &&
        session.payment_status === "paid" &&
        session.metadata?.purchaseKind === "hosted_credits"
      ) {
        const configuredAmount = getCreditAmountMicros(env);
        const configuredPurchaseAmountCents = getCreditPurchaseAmountCents(env);
        const sessionAmount = Number(session.metadata.creditAmountMicros);

        if (
          !configuredAmount ||
          !configuredPurchaseAmountCents ||
          sessionAmount !== configuredAmount ||
          session.amount_total !== configuredPurchaseAmountCents ||
          session.currency !== "usd"
        ) {
          throw new HttpError(
            400,
            "Stripe credit checkout metadata does not match server configuration.",
          );
        }

        await database.creditHostedBalance({
          amountMicros: configuredAmount,
          ledgerId: randomUUID(),
          stripeCheckoutSessionId: session.id,
          userId,
        });
      }

      if (typeof session.subscription === "string") {
        await retrieveAndSyncSubscription({
          customerId,
          fallbackUserId: userId,
          subscriptionId: session.subscription,
        });
      }
    }

    if (
      event.type === "customer.subscription.created" ||
      event.type === "customer.subscription.updated" ||
      event.type === "customer.subscription.deleted" ||
      event.type === "customer.subscription.paused" ||
      event.type === "customer.subscription.resumed"
    ) {
      const subscription = event.data.object;

      await syncSubscription({
        customerId: getSubscriptionCustomerId(subscription),
        subscription,
      });
    }

    if (event.type === "invoice.paid" || event.type === "invoice.payment_failed") {
      const invoice = event.data.object;
      const subscriptionId = getInvoiceSubscriptionId(invoice);

      if (subscriptionId) {
        await retrieveAndSyncSubscription({
          customerId:
            typeof invoice.customer === "string"
              ? invoice.customer
              : invoice.customer?.id ?? null,
          subscriptionId,
        });
      }
    }

    return {
      received: true,
    };
  }

  return {
    createBillingPortalSession,
    createCheckoutSession,
    createSubscriptionCheckoutSession,
    confirmSubscriptionCheckout,
    handleWebhook,
    getHostedUsageLimits,
    refundHostedRequest,
    reserveHostedRequest,
  };
}
