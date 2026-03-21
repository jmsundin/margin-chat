import Stripe from "stripe";
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

export function createBillingService({ database, env }) {
  async function ensureCustomerForUser(user) {
    const stripe = getStripeClient(env);
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
        subscription.current_period_end,
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
    const stripe = getStripeClient(env);
    const subscription = await stripe.subscriptions.retrieve(subscriptionId);

    return syncSubscription({
      customerId: customerId ?? getSubscriptionCustomerId(subscription),
      fallbackUserId,
      subscription,
    });
  }

  async function createCheckoutSession({ request, user }) {
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

    const stripe = getStripeClient(env);
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
    const stripe = getStripeClient(env);
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

    const stripe = getStripeClient(env);
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
      const userId =
        typeof session.metadata?.userId === "string" && session.metadata.userId
          ? session.metadata.userId
          : typeof session.client_reference_id === "string" &&
              session.client_reference_id
            ? session.client_reference_id
            : null;

      if (userId && customerId) {
        await database.updateStripeCustomerId({
          stripeCustomerId: customerId,
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
      event.type === "customer.subscription.deleted"
    ) {
      const subscription = event.data.object;

      await syncSubscription({
        customerId: getSubscriptionCustomerId(subscription),
        subscription,
      });
    }

    return {
      received: true,
    };
  }

  return {
    createBillingPortalSession,
    createCheckoutSession,
    handleWebhook,
  };
}
