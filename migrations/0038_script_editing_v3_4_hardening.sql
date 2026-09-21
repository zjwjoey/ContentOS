create table if not exists script_editing_v3_evaluation_sets (
  id text primary key,
  workspace_id text not null references video_workspaces(id) on delete cascade,
  name text not null,
  version integer not null default 1 check (version > 0),
  snapshot_id text references material_pool_snapshots(id) on delete set null,
  status text not null default 'DRAFT' check (status in ('DRAFT','READY','ARCHIVED')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (workspace_id, name, version)
);

create table if not exists script_editing_v3_evaluation_items (
  id text primary key,
  set_id text not null references script_editing_v3_evaluation_sets(id) on delete cascade,
  asset_id text not null,
  source_fingerprint text,
  file_name text not null,
  duration_ms integer not null default 0,
  tags jsonb not null default '[]'::jsonb,
  visual_profile jsonb,
  created_at timestamptz not null default now(),
  unique (set_id, asset_id)
);

create table if not exists script_editing_v3_evaluation_queries (
  id text primary key,
  set_id text not null references script_editing_v3_evaluation_sets(id) on delete cascade,
  visual_need text not null,
  usable_asset_ids jsonb not null default '[]'::jsonb,
  forbidden_asset_ids jsonb not null default '[]'::jsonb,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (set_id, id)
);

create table if not exists script_editing_v3_evaluation_judgments (
  id text primary key,
  set_id text not null references script_editing_v3_evaluation_sets(id) on delete cascade,
  query_id text not null references script_editing_v3_evaluation_queries(id) on delete cascade,
  asset_id text not null,
  label text not null check (label in ('BEST','USABLE','UNUSABLE','FORBIDDEN')),
  reason text,
  annotator text not null,
  created_at timestamptz not null default now(),
  unique (query_id, asset_id, annotator)
);
create index if not exists script_editing_v3_evaluation_queries_set_idx on script_editing_v3_evaluation_queries(set_id, created_at, id);

create table if not exists script_editing_v3_asset_relinks (
  id text primary key,
  workspace_id text not null references video_workspaces(id) on delete cascade,
  snapshot_id text not null references material_pool_snapshots(id) on delete cascade,
  asset_id text not null,
  old_fingerprint text,
  new_fingerprint text not null,
  old_path text,
  new_path text not null,
  reason text not null default 'MANUAL_RELINK',
  actor text not null default 'operator',
  created_at timestamptz not null default now()
);
create index if not exists script_editing_v3_asset_relinks_lookup_idx on script_editing_v3_asset_relinks(snapshot_id, asset_id, created_at desc);

create table if not exists script_editing_v3_shot_detection_runs (
  id text primary key,
  snapshot_id text not null references material_pool_snapshots(id) on delete cascade,
  asset_id text not null,
  source_fingerprint text not null,
  method text not null default 'FFMPEG_SCENE_V1',
  threshold numeric not null default 0.35,
  detector_version text not null default 'shot-detection-v1',
  status text not null default 'QUEUED' check (status in ('QUEUED','RUNNING','SUCCEEDED','FAILED')),
  error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (snapshot_id, asset_id, source_fingerprint, detector_version)
);

create table if not exists script_editing_v3_shots (
  id text primary key,
  run_id text not null references script_editing_v3_shot_detection_runs(id) on delete cascade,
  shot_index integer not null check (shot_index >= 0),
  source_in_ms integer not null check (source_in_ms >= 0),
  source_out_ms integer not null check (source_out_ms > source_in_ms),
  confidence numeric not null default 1 check (confidence >= 0 and confidence <= 1),
  evidence jsonb not null default '{}'::jsonb,
  unique (run_id, shot_index)
);

create table if not exists script_editing_v3_revision_actions (
  id text primary key,
  session_id text not null references script_editing_v3_sessions(id) on delete cascade,
  from_manifest_id text references edit_manifests(id) on delete set null,
  to_manifest_id text references edit_manifests(id) on delete set null,
  action text not null check (action in ('UNDO','REDO','RESTORE')),
  reason text,
  created_at timestamptz not null default now()
);

create table if not exists script_editing_v3_preview_fragments (
  id text primary key,
  workspace_id text not null references video_workspaces(id) on delete cascade,
  manifest_id text not null references edit_manifests(id) on delete cascade,
  fragment_key text not null,
  source_fingerprint text not null,
  source_in_ms integer not null check (source_in_ms >= 0),
  source_out_ms integer not null check (source_out_ms > source_in_ms),
  output_path text,
  status text not null default 'READY' check (status in ('QUEUED','READY','FAILED')),
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (manifest_id, fragment_key, source_fingerprint, source_in_ms, source_out_ms)
);
create index if not exists script_editing_v3_preview_fragments_manifest_idx on script_editing_v3_preview_fragments(manifest_id, fragment_key);

alter table source_segments
  add column if not exists kind text not null default 'CLIP' check (kind in ('CLIP','SHOT')),
  add column if not exists detection_method text,
  add column if not exists detection_threshold numeric,
  add column if not exists detector_version text;

alter table script_editing_v3_usage_events
  alter column manifest_id drop not null,
  alter column render_id drop not null,
  add column if not exists event_type text not null default 'FINAL_RENDER_USED' check (event_type in ('CANDIDATE_SHOWN','AUTO_SELECTED','MANUAL_SELECTED','REPLACED_OUT','FINAL_RENDER_USED','JIANYING_HISTORICAL_USE')),
  add column if not exists sentence_id text;
create index if not exists script_editing_v3_usage_events_semantics_idx on script_editing_v3_usage_events(workspace_id,event_type,created_at desc);
