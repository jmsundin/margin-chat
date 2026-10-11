-- One row per desktop installer download from marginchat.com/download. The
-- location columns come from Vercel's edge headers and are approximate.
create table if not exists marginchat_desktop_downloads (
  id bigint generated always as identity primary key,
  created_at timestamptz not null default now(),
  target text not null,
  platform text not null,
  version text not null,
  asset_name text not null,
  user_id text references marginchat_users(id) on delete set null,
  ip_address text,
  user_agent text,
  os text,
  accept_language text,
  referer text,
  source text,
  country text,
  region text,
  city text,
  postal_code text,
  latitude double precision,
  longitude double precision,
  timezone text
);

create index if not exists marginchat_desktop_downloads_created_idx
  on marginchat_desktop_downloads (created_at desc);
