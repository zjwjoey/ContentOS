create table asset_imports (
  id text primary key,
  project_id text not null references content_projects(id) on delete cascade,
  job_id text unique references jobs(id) on delete set null,
  original_name text not null check (length(original_name) between 1 and 255),
  kind text not null check (kind in ('VIDEO', 'AUDIO')),
  byte_size bigint not null check (byte_size > 0),
  staged_path text not null,
  state text not null check (state in ('STAGED', 'QUEUED', 'PROCESSING', 'READY', 'DEDUPED', 'FAILED', 'CANCELLED')),
  output_asset_id text references assets(id) on delete set null,
  error_code text,
  error_message text,
  correlation_id text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint asset_imports_staged_job_check check (state <> 'STAGED' or job_id is null)
);

create index asset_imports_project_created_idx on asset_imports (project_id, created_at desc);
create index asset_imports_runnable_idx on asset_imports (state, updated_at) where state in ('QUEUED', 'PROCESSING');
