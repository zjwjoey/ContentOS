alter table local_media_scan_files
  add column if not exists orientation text not null default 'UNKNOWN' check (orientation in ('VERTICAL','HORIZONTAL','SQUARE','UNKNOWN')),
  add column if not exists file_size bigint,
  add column if not exists modified_at timestamptz,
  add column if not exists tags jsonb not null default '[]'::jsonb,
  add column if not exists category text,
  add column if not exists thumbnail_key text,
  add column if not exists thumbnail_status text not null default 'PENDING' check (thumbnail_status in ('PENDING','READY','FAILED'));

create table if not exists local_media_index (
  file_id text primary key,
  source_root_id text not null,
  relative_path text not null,
  file_name text not null,
  duration_ms integer not null default 0,
  width integer not null default 0,
  height integer not null default 0,
  orientation text not null default 'UNKNOWN' check (orientation in ('VERTICAL','HORIZONTAL','SQUARE','UNKNOWN')),
  format text not null,
  codec text,
  file_size bigint,
  modified_at timestamptz,
  tags jsonb not null default '[]'::jsonb,
  category text,
  usage_count integer not null default 0 check (usage_count >= 0),
  last_used_at timestamptz,
  availability text not null default 'AVAILABLE' check (availability in ('AVAILABLE','MISSING','UNAVAILABLE')),
  thumbnail_key text,
  thumbnail_status text not null default 'PENDING' check (thumbnail_status in ('PENDING','READY','FAILED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (source_root_id, relative_path)
);
create index if not exists local_media_index_root_idx on local_media_index(source_root_id, availability, updated_at desc);
create index if not exists local_media_index_usage_idx on local_media_index(usage_count desc, last_used_at desc nulls last);

create table if not exists local_media_usage (
  id text primary key,
  media_id text not null references local_media_index(file_id) on delete restrict,
  project_id text not null references content_projects(id) on delete cascade,
  manifest_id text not null,
  render_id text not null,
  used_at timestamptz not null default now(),
  unique (media_id, render_id)
);
create index if not exists local_media_usage_media_idx on local_media_usage(media_id, used_at desc);
create index if not exists local_media_usage_project_idx on local_media_usage(project_id, used_at desc);
