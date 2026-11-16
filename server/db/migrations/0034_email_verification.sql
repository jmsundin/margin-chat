-- Confirming the email address at sign-up (thread "Get Margin Chat ready for launch").
-- People still get in at once; the link only records that the address is theirs, so a
-- typo is caught before they need a password reset, and later free allowances can
-- require it. Changing the email clears it until the new address is confirmed.

alter table marginchat_users
  add column if not exists email_verified_at timestamptz;

create table if not exists marginchat_email_verification_tokens (
  token_hash text primary key,
  user_id text not null references marginchat_users(id) on delete cascade,
  email text not null,
  expires_at timestamptz not null,
  created_at timestamptz not null default now()
);

create index if not exists marginchat_email_verification_tokens_user_idx
  on marginchat_email_verification_tokens (user_id);
