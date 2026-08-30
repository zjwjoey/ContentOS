create table publisher_publication_states (
  platform_id text not null check (platform_id in ('douyin', 'wechat-channels')),
  account_id text not null,
  idempotency_key text not null,
  status text not null check (status in ('PUBLISHED', 'UNKNOWN_EXTERNAL_STATE')),
  external_post_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  primary key (platform_id, account_id, idempotency_key)
);

create index publisher_publication_states_unknown_idx on publisher_publication_states (status, updated_at) where status = 'UNKNOWN_EXTERNAL_STATE';
