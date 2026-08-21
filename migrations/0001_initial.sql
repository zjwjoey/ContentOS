create table content_projects (
  id text primary key,
  status text not null check (status in ('DRAFT','IN_PRODUCTION','READY_TO_PUBLISH','PUBLISHED','REVIEWED','ARCHIVED')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table assets (
  id text primary key,
  project_id text references content_projects(id),
  kind text not null,
  checksum text not null,
  byte_size bigint not null check (byte_size >= 0),
  storage_key text not null,
  lifecycle text not null check (lifecycle in ('STAGED','READY','FAILED','ARCHIVED')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (checksum)
);

create table project_assets (
  project_id text not null references content_projects(id),
  asset_id text not null references assets(id),
  role text not null,
  created_at timestamptz not null default now(),
  primary key (project_id, asset_id, role)
);

create table jobs (
  id text primary key,
  project_id text references content_projects(id),
  type text not null,
  state text not null check (state in ('QUEUED','RUNNING','RETRY_WAIT','FAILED','SUCCEEDED','CANCEL_REQUESTED','CANCELLED','BLOCKED')),
  idempotency_key text not null unique,
  payload jsonb not null default '{}'::jsonb,
  result jsonb,
  error jsonb,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  max_attempts integer not null default 3 check (max_attempts > 0),
  lease_owner text,
  lease_expires_at timestamptz,
  scheduled_at timestamptz not null default now(),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table job_attempts (
  id text primary key,
  job_id text not null references jobs(id),
  attempt_number integer not null check (attempt_number > 0),
  worker_id text not null,
  status text not null check (status in ('RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  error jsonb,
  started_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (job_id, attempt_number)
);

create table job_dependencies (
  job_id text not null references jobs(id),
  depends_on_job_id text not null references jobs(id),
  created_at timestamptz not null default now(),
  primary key (job_id, depends_on_job_id),
  check (job_id <> depends_on_job_id)
);

create table job_events (
  id bigserial primary key,
  job_id text not null references jobs(id),
  event_type text not null,
  correlation_id text,
  details jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create table edit_manifests (
  id text primary key,
  project_id text not null references content_projects(id),
  revision integer not null check (revision > 0),
  schema_version text not null check (schema_version = 'EDIT_MANIFEST_V0'),
  manifest jsonb not null,
  status text not null check (status in ('PERSISTED','SUPERSEDED')),
  created_at timestamptz not null default now(),
  unique (project_id, revision)
);

create table renders (
  id text primary key,
  project_id text not null references content_projects(id),
  manifest_id text not null references edit_manifests(id),
  job_id text references jobs(id),
  output_asset_id text references assets(id),
  status text not null check (status in ('PLANNED','QUEUED','RUNNING','VALIDATING','SUCCEEDED','FAILED','CANCELLED')),
  diagnostics jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz
);

create index jobs_ready_idx on jobs (state, scheduled_at);
create index jobs_project_idx on jobs (project_id, created_at);
create index assets_project_idx on assets (project_id, created_at);
create index job_events_job_idx on job_events (job_id, created_at);
