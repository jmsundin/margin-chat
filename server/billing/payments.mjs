import { stripeId } from "./plan.mjs";

export async function verifyPaymentIntent(stripe, reference, { customerId, amountCents, exact = false }) {
  const id = stripeId(reference);
  if (!id) return null;
  const intent = await stripe.paymentIntents.retrieve(id, { expand: ["latest_charge"] });
  const charge = intent.latest_charge;
  if (intent.status !== "succeeded" || intent.currency !== "usd" || stripeId(intent.customer) !== customerId
    || !Number.isSafeInteger(intent.amount_received) || intent.amount_received < amountCents
    || (exact && intent.amount_received !== amountCents)
    || !charge || typeof charge !== "object" || charge.paid !== true || charge.captured !== true
    || charge.refunded || charge.disputed || (charge.amount_refunded ?? 0) !== 0) return null;
  return { intent, receiptUrl: charge.receipt_url ?? null };
}

/** Use amounts allocated to this invoice, not a reusable PaymentIntent's total. */
export async function verifyInvoicePayments(stripe, invoice, customerId) {
  if (!invoice.payments && invoice.payment_intent) {
    return verifyPaymentIntent(stripe, invoice.payment_intent, { customerId, amountCents: invoice.amount_paid, exact: true });
  }
  let payments = invoice.payments;
  if (!payments || payments.has_more) {
    payments = await stripe.invoicePayments.list({ invoice: invoice.id, status: "paid", limit: 100 });
  }
  if (payments.has_more || !Array.isArray(payments.data)) return null;
  const paid = payments.data.filter((payment) => payment.status === "paid");
  if (!paid.length) return null;
  let allocated = 0;
  let receiptUrl = null;
  const ids = new Set();
  for (const payment of paid) {
    if (!payment.id || ids.has(payment.id) || payment.payment?.type !== "payment_intent"
      || payment.currency !== "usd" || stripeId(payment.invoice) !== invoice.id
      || !Number.isSafeInteger(payment.amount_paid) || payment.amount_paid <= 0) return null;
    ids.add(payment.id);
    const verified = await verifyPaymentIntent(stripe, payment.payment.payment_intent, {
      customerId, amountCents: payment.amount_paid,
    });
    if (!verified) return null;
    allocated += payment.amount_paid;
    receiptUrl ??= verified.receiptUrl;
  }
  return allocated === invoice.amount_paid ? { receiptUrl } : null;
}
