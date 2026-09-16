create table local_media_scans (
  id text primary key,
  project_id text references content_projects(id) on delete cascade,
  workspace_id text references video_workspaces(id) on delete cascade,
  source_root text not null,
  source_root_id text not null,
  recursive boolean not null default true,
  status text not null default 'QUEUED' check (status in ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  progress jsonb not null default '{}'::jsonb,
  error jsonb,
  scanned_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((project_id is not null and workspace_id is null) or (project_id is null and workspace_id is not null))
);

create index local_media_scans_project_idx on local_media_scans(project_id, created_at desc);
create index local_media_scans_root_idx on local_media_scans(source_root_id, created_at desc);

create table local_media_scan_files (
  scan_id text not null references local_media_scans(id) on delete cascade,
  file_id text not null,
  file_name text not null,
  relative_path text not null,
  source_path text not null,
  duration_ms integer not null default 0,
  width integer not null default 0,
  height integer not null default 0,
  format text not null,
  codec text,
  available boolean not null default false,
  error_message text,
  primary key (scan_id, file_id),
  unique (scan_id, relative_path)
);

create index local_media_scan_files_file_idx on local_media_scan_files(file_id);
