create table publisher_fake_simulations (
  account_id text primary key references publisher_accounts(id) on delete cascade,
  outcome text not null check (outcome in ('SUCCESS', 'AUTH_EXPIRED', 'VERIFICATION', 'DOM_DRIFT', 'BROWSER_CRASH', 'UNKNOWN_SIDE_EFFECT', 'UNKNOWN_NO_SIDE_EFFECT', 'RATE_LIMIT', 'NETWORK')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
