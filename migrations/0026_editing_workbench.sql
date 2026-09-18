alter table video_quick_edit_sessions
  add column if not exists script text,
  add column if not exists source_roots jsonb not null default '[]'::jsonb;

alter table local_media_scans
  add column if not exists workspace_id text references video_workspaces(id) on delete cascade;

alter table local_media_scans drop constraint if exists local_media_scans_project_id_workspace_id_check;
alter table local_media_scans add constraint local_media_scans_owner_check
  check ((project_id is not null and workspace_id is null) or (project_id is null and workspace_id is not null));

create index if not exists local_media_scans_workspace_idx on local_media_scans(workspace_id, created_at desc);

create table edit_workbench_sessions (
  id text primary key,
  mode text not null check (mode in ('SCRIPT','MIX')),
  title text not null,
  script text,
  source_roots jsonb not null default '[]'::jsonb,
  output_root text,
  settings jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table edit_batches (
  id text primary key,
  session_id text not null references edit_workbench_sessions(id) on delete cascade,
  mode text not null check (mode in ('SCRIPT','MIX')),
  status text not null default 'QUEUED' check (status in ('QUEUED','RUNNING','SUCCEEDED','PARTIAL','FAILED','CANCELLED')),
  total_count integer not null default 0 check (total_count >= 0),
  succeeded_count integer not null default 0 check (succeeded_count >= 0),
  failed_count integer not null default 0 check (failed_count >= 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table edit_batch_items (
  id text primary key,
  batch_id text not null references edit_batches(id) on delete cascade,
  ordinal integer not null check (ordinal > 0),
  title text not null,
  script text not null,
  voice_asset_id text,
  workspace_id text not null references video_workspaces(id) on delete cascade,
  manifest_id text references edit_manifests(id) on delete set null,
  job_id text references jobs(id) on delete set null,
  state text not null default 'QUEUED' check (state in ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  output_asset_id text,
  output_path text,
  error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (batch_id, ordinal)
);

create table edit_exports (
  id text primary key,
  batch_item_id text not null references edit_batch_items(id) on delete cascade,
  asset_id text not null,
  output_path text not null,
  status text not null default 'QUEUED' check (status in ('QUEUED','RUNNING','SUCCEEDED','FAILED')),
  error jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  unique (batch_item_id, output_path)
);

create index edit_batches_session_idx on edit_batches(session_id, created_at desc);
create index edit_batch_items_batch_idx on edit_batch_items(batch_id, ordinal);
create index edit_batch_items_job_idx on edit_batch_items(job_id);
