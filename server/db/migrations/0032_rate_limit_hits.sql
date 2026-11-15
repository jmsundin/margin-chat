-- Sign-in, sign-up and password-reset attempts counted in Postgres (thread "Get Margin
-- Chat ready for launch"). Counters kept in each server's memory were per Vercel
-- instance, so an attacker spread across instances was never really capped. One row
-- per limit, hashed key (never a raw email or address) and short time slot; rows
-- older than a day are pruned as new attempts are recorded.

create table if not exists marginchat_rate_limit_hits (
  bucket text not null,
  key_hash text not null,
  slot_start timestamptz not null,
  hits integer not null default 0 check (hits >= 0),
  primary key (bucket, key_hash, slot_start)
);

create index if not exists marginchat_rate_limit_hits_slot_idx
  on marginchat_rate_limit_hits (slot_start);
