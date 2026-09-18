-- Preserve existing credits and charges while adding monthly funding and usage holds.
alter table marginchat_users add column if not exists billing_revision bigint not null default 0;
alter table marginchat_billing_ledger
  add column if not exists stripe_invoice_id text,
  add column if not exists description text,
  add column if not exists receipt_url text,
  add column if not exists metadata jsonb not null default '{}'::jsonb;

alter table marginchat_billing_ledger
  drop constraint if exists marginchat_billing_ledger_entry_type_check;
alter table marginchat_billing_ledger
  add constraint marginchat_billing_ledger_entry_type_check check (
    entry_type in ('stripe_credit_purchase', 'stripe_subscription_credit', 'hosted_request', 'hosted_request_refund')
  );

create unique index if not exists marginchat_billing_ledger_stripe_invoice_idx
  on marginchat_billing_ledger (stripe_invoice_id) where stripe_invoice_id is not null;
create index if not exists marginchat_billing_ledger_user_history_idx
  on marginchat_billing_ledger (user_id, created_at desc, id desc);

-- Available credit is reduced when a hold is created. Only settled usage enters
-- the ledger; unused reserved funds return to available credit atomically.
create table if not exists marginchat_usage_reservations (
  request_id text primary key,
  user_id text not null references marginchat_users(id) on delete cascade,
  reserved_micros bigint not null check (reserved_micros > 0),
  charged_micros bigint,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  settled_at timestamptz,
  constraint marginchat_usage_reservation_settlement_check check (
    (charged_micros is null and settled_at is null)
    or (charged_micros is not null and charged_micros >= 0 and charged_micros <= reserved_micros and settled_at is not null)
  )
);
create index if not exists marginchat_usage_reservations_pending_idx
  on marginchat_usage_reservations (user_id) where settled_at is null;
