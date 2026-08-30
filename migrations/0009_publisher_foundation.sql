create table publisher_accounts (
  id text primary key,
  project_id text not null references content_projects(id),
  platform_id text not null,
  display_name text not null,
  credential_ref text not null,
  profile_key text not null,
  status text not null check (status in ('UNVERIFIED', 'READY', 'REAUTH_REQUIRED', 'SUSPENDED', 'DISABLED')),
  capability_snapshot jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint publisher_accounts_project_platform_name_key unique (project_id, platform_id, display_name)
);

create table publisher_requests (
  id text primary key,
  project_id text not null references content_projects(id),
  account_id text not null references publisher_accounts(id),
  current_revision_id text,
  status text not null check (status in ('DRAFT', 'SCHEDULED', 'QUEUED', 'PUBLISHING', 'RECONCILING', 'PUBLISHED', 'FAILED', 'CANCELLED')),
  idempotency_key text not null,
  desired_publish_at timestamptz,
  next_retry_at timestamptz,
  failure_code text check (failure_code is null or failure_code in ('AUTH_EXPIRED', 'REQUIRES_VERIFICATION', 'PLATFORM_CHANGED', 'RATE_LIMIT', 'UPLOAD_FAILED', 'NETWORK_ERROR', 'UNKNOWN_EXTERNAL_STATE', 'UNKNOWN')),
  failure_message text,
  correlation_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  published_at timestamptz,
  constraint publisher_requests_idempotency_key unique (idempotency_key)
);

create table publisher_request_revisions (
  id text primary key,
  request_id text not null references publisher_requests(id),
  revision integer not null check (revision > 0),
  asset_id text not null references assets(id),
  asset_checksum text not null,
  title text not null,
  description text not null default '',
  desired_publish_at timestamptz,
  created_by text not null,
  created_at timestamptz not null default now(),
  constraint publisher_request_revisions_request_revision_key unique (request_id, revision)
);

alter table publisher_requests
  add constraint publisher_requests_current_revision_fk foreign key (current_revision_id) references publisher_request_revisions(id);

create table publisher_attempts (
  id text primary key,
  request_id text not null references publisher_requests(id),
  revision_id text not null references publisher_request_revisions(id),
  job_id text references jobs(id),
  job_attempt_id text references job_attempts(id),
  attempt_number integer not null check (attempt_number > 0),
  operation text not null check (operation in ('PUBLISH', 'RECONCILE')),
  status text not null check (status in ('RUNNING', 'SUCCEEDED', 'FAILED', 'UNKNOWN')),
  failure_code text check (failure_code is null or failure_code in ('AUTH_EXPIRED', 'REQUIRES_VERIFICATION', 'PLATFORM_CHANGED', 'RATE_LIMIT', 'UPLOAD_FAILED', 'NETWORK_ERROR', 'UNKNOWN_EXTERNAL_STATE', 'UNKNOWN')),
  failure_classification text check (failure_classification is null or failure_classification in ('HUMAN_ACTION_REQUIRED', 'PERMANENT', 'RETRYABLE', 'RECONCILIATION_REQUIRED', 'TERMINAL')),
  diagnostics jsonb not null default '{}'::jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint publisher_attempts_request_attempt_key unique (request_id, attempt_number)
);

create table publisher_external_posts (
  id text primary key,
  request_id text not null references publisher_requests(id),
  account_id text not null references publisher_accounts(id),
  platform_id text not null,
  external_post_id text not null,
  external_url text,
  first_observed_at timestamptz not null default now(),
  last_reconciled_at timestamptz,
  constraint publisher_external_posts_account_external_key unique (account_id, platform_id, external_post_id)
);

create index publisher_accounts_project_idx on publisher_accounts (project_id, created_at desc);
create index publisher_requests_project_idx on publisher_requests (project_id, created_at desc);
create index publisher_requests_runnable_idx on publisher_requests (status, next_retry_at, desired_publish_at);
create index publisher_request_revisions_request_idx on publisher_request_revisions (request_id, revision desc);
create index publisher_attempts_request_idx on publisher_attempts (request_id, attempt_number desc);
create index publisher_external_posts_request_idx on publisher_external_posts (request_id, first_observed_at desc);
