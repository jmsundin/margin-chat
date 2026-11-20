-- Signing up on the web starts a free trial with a card (Cloud or Cloud + AI). Accounts made before
-- this keep using the web as they did; new ones pick a plan first. The desktop app needs no account.
alter table marginchat_users
  add column if not exists web_plan_required boolean not null default false;
-- A Cloud + AI trial comes with a small hosted AI allowance, once per account.
alter table marginchat_billing_ledger
  drop constraint if exists marginchat_billing_ledger_entry_type_check;
alter table marginchat_billing_ledger
  add constraint marginchat_billing_ledger_entry_type_check check (
    entry_type in ('stripe_credit_purchase', 'stripe_subscription_credit', 'hosted_request', 'hosted_request_refund', 'stripe_payment_reversal', 'trial_credit')
  );
create unique index if not exists marginchat_billing_ledger_trial_credit_idx
  on marginchat_billing_ledger (user_id) where entry_type = 'trial_credit';
