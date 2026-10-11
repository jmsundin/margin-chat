import { HttpError } from "../lib/errors.mjs";

export const MONTHLY_PLAN_CENTS = 2_000;
export const MONTHLY_PLAN_MICROS = 20_000_000;
export const MONTHLY_PLAN_KEY = "margin-chat-prepaid-monthly-v1";
export const MIN_TOP_UP_CENTS = 500;
export const MAX_TOP_UP_CENTS = 50_000;
export const CLOUD_PLAN_CENTS = 1_000;
export const CLOUD_PLAN_KEY = "margin-chat-cloud-monthly-v1";
export const BILLING_PLAN = Object.freeze({ monthlyAmountMicros: MONTHLY_PLAN_MICROS, currency: "usd", rollover: true });
// Cloud is storage and sync only: it grants no hosted AI credit.
export const CLOUD_PLAN = Object.freeze({ monthlyPriceCents: CLOUD_PLAN_CENTS, currency: "usd", includesCreditMicros: 0 });
export const SUBSCRIPTION_PLANS = Object.freeze(["plus", "cloud"]);

export function requireSubscriptionPlan(value = "plus") {
  if (!SUBSCRIPTION_PLANS.includes(value)) throw new HttpError(400, "Choose the Cloud or Plus plan.");
  return value;
}

export function stripeId(value) {
  return typeof value === "string" ? value : value?.id ?? null;
}

export function invoiceSubscriptionId(invoice) {
  return stripeId(invoice?.parent?.subscription_details?.subscription ?? invoice?.subscription);
}

export function invoiceLinePriceId(line) {
  return stripeId(line?.pricing?.price_details?.price ?? line?.price);
}

export function validateTopUpCents(value) {
  if (!Number.isSafeInteger(value) || value < MIN_TOP_UP_CENTS || value > MAX_TOP_UP_CENTS) {
    throw new HttpError(400, "Add between $5.00 and $500.00 in whole cents.");
  }
  return value;
}

function isFixedMonthlyPrice(price, unitAmount, requireActive) {
  return Boolean(price && (!requireActive || price.active === true)
    && price.currency === "usd" && price.unit_amount === unitAmount
    && price.type === "recurring" && price.recurring?.interval === "month"
    && price.recurring?.interval_count === 1 && price.recurring?.usage_type === "licensed"
    && price.billing_scheme === "per_unit" && !price.transform_quantity);
}

export function isMonthlyPrice(price, configuredPriceId, { requireActive = false } = {}) {
  return isFixedMonthlyPrice(price, MONTHLY_PLAN_CENTS, requireActive)
    && (configuredPriceId ? price.id === configuredPriceId
      : price.product?.metadata?.marginChatPlan === MONTHLY_PLAN_KEY);
}

/** The Cloud plan only exists with a configured Price, so its ID identifies the plan. */
export function isCloudPrice(price, cloudPriceId, { requireActive = false } = {}) {
  return Boolean(cloudPriceId) && isFixedMonthlyPrice(price, CLOUD_PLAN_CENTS, requireActive)
    && price.id === cloudPriceId;
}

export function monthlyInvoiceLine(invoice) {
  const lines = invoice?.lines;
  const line = lines?.data?.[0];
  const subscriptionId = invoiceSubscriptionId(invoice);
  const details = line?.parent?.subscription_item_details;
  const lineSubscription = stripeId(details?.subscription ?? line?.subscription);
  if (!invoice?.id || invoice.status !== "paid" || invoice.currency !== "usd"
    || !["subscription_create", "subscription_cycle", "subscription_update"].includes(invoice.billing_reason)
    || !Number.isSafeInteger(invoice.amount_paid) || invoice.amount_paid < MONTHLY_PLAN_CENTS
    || invoice.amount_paid !== invoice.total || invoice.amount_due !== invoice.total
    || invoice.amount_remaining !== 0 || invoice.paid_out_of_band === true
    || (invoice.starting_balance ?? 0) !== 0 || (invoice.ending_balance ?? 0) !== 0
    || (invoice.pre_payment_credit_notes_amount ?? 0) !== 0 || (invoice.post_payment_credit_notes_amount ?? 0) !== 0
    || invoice.subtotal !== MONTHLY_PLAN_CENTS || invoice.discounts?.length
    || invoice.total_discount_amounts?.some((discount) => discount.amount !== 0)
    || !subscriptionId || !line || !Array.isArray(lines.data) || lines.has_more || lines.data.length !== 1
    || line.currency !== "usd" || line.amount !== MONTHLY_PLAN_CENTS || line.quantity !== 1
    || lineSubscription !== subscriptionId || (line.parent ? line.parent.type !== "subscription_item_details" : line.type !== "subscription")
    || line.proration === true || details?.proration === true
    || line.discount_amounts?.some((discount) => discount.amount !== 0)
    || line.pretax_credit_amounts?.some((credit) => credit.amount !== 0)) return null;
  return line;
}

export function topUpAmount(session) {
  const amount = Number(session?.metadata?.amountCents);
  if (!Number.isSafeInteger(amount) || amount < MIN_TOP_UP_CENTS || amount > MAX_TOP_UP_CENTS
    || session.metadata?.creditAmountMicros !== String(amount * 10_000)
    || session.mode !== "payment" || session.status !== "complete" || session.payment_status !== "paid"
    || session.metadata?.purchaseKind !== "hosted_credits" || session.currency !== "usd"
    || session.amount_total !== amount || session.amount_subtotal !== amount
    || (session.total_details?.amount_discount ?? 0) !== 0 || (session.total_details?.amount_tax ?? 0) !== 0
    || (session.total_details?.amount_shipping ?? 0) !== 0) return null;
  const lines = session.line_items;
  const line = lines?.data?.[0];
  if (!line || lines.has_more || lines.data.length !== 1 || line.quantity !== 1
    || line.amount_total !== amount || line.amount_subtotal !== amount || line.currency !== "usd"
    || line.price?.currency !== "usd" || line.price?.unit_amount !== amount
    || line.price?.type !== "one_time" || line.price?.product?.metadata?.purchaseKind !== "hosted_credits") return null;
  return amount;
}
