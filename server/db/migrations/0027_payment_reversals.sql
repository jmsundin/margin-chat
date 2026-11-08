-- A refunded or disputed Stripe payment takes back the credit it bought.
alter table marginchat_billing_ledger
  drop constraint if exists marginchat_billing_ledger_entry_type_check;
alter table marginchat_billing_ledger
  add constraint marginchat_billing_ledger_entry_type_check check (
    entry_type in ('stripe_credit_purchase', 'stripe_subscription_credit', 'hosted_request', 'hosted_request_refund', 'stripe_payment_reversal')
  );
-- Finds the credits a refunded PaymentIntent paid for.
create index if not exists marginchat_billing_ledger_payment_intent_idx
  on marginchat_billing_ledger ((metadata->>'paymentIntentId')) where metadata ? 'paymentIntentId';
create index if not exists marginchat_billing_ledger_payment_intents_idx
  on marginchat_billing_ledger using gin ((metadata->'paymentIntentIds')) where metadata ? 'paymentIntentIds';
