create table if not exists external_media_search_cache (
  cache_key text primary key,
  provider text not null,
  query text not null,
  orientation text,
  locale text,
  page integer not null default 1,
  per_page integer not null default 8,
  response jsonb not null,
  rate_limit jsonb,
  created_at timestamptz not null default now(),
  expires_at timestamptz not null
);
create index if not exists external_media_search_cache_expiry_idx on external_media_search_cache(expires_at);

create table if not exists external_media_assets (
  id text primary key default ('external-' || md5(random()::text)),
  provider text not null,
  provider_asset_id text not null,
  provider_file_id text not null,
  asset_id text not null references assets(id) on delete cascade,
  provenance jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique(provider, provider_asset_id, provider_file_id)
);
create index if not exists external_media_assets_asset_idx on external_media_assets(asset_id);

create table if not exists media_provider_status (
  provider text primary key,
  configured boolean not null default false,
  healthy boolean,
  message text,
  rate_limit jsonb,
  last_checked_at timestamptz
);
