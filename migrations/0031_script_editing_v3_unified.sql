create table if not exists material_pool_snapshots (
  id text primary key,
  workspace_id text not null references video_workspaces(id) on delete cascade,
  revision integer not null check (revision > 0),
  source_spec jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (workspace_id, revision)
);

create table if not exists material_pool_items (
  snapshot_id text not null references material_pool_snapshots(id) on delete cascade,
  asset_id text not null,
  canonical_path text not null,
  source_path text not null,
  file_name text not null,
  duration_ms integer not null check (duration_ms > 0),
  width integer not null default 0,
  height integer not null default 0,
  file_size bigint,
  modified_at timestamptz,
  tags jsonb not null default '[]'::jsonb,
  source_kind text not null check (source_kind in ('MANUAL','JIANYING_DRAFT')),
  source_ref jsonb not null default '{}'::jsonb,
  thumbnail_key text,
  gold boolean not null default false,
  created_at timestamptz not null default now(),
  primary key (snapshot_id, asset_id)
);
create index if not exists material_pool_items_snapshot_path_idx on material_pool_items(snapshot_id, canonical_path, file_size, duration_ms);

create table if not exists source_segments (
  id text primary key,
  snapshot_id text not null references material_pool_snapshots(id) on delete cascade,
  asset_id text not null,
  source_in_ms integer not null check (source_in_ms >= 0),
  source_out_ms integer not null check (source_out_ms > source_in_ms),
  evidence jsonb not null default '{}'::jsonb,
  unique (snapshot_id, asset_id, source_in_ms, source_out_ms)
);

create table if not exists asset_visual_profiles (
  asset_id text primary key,
  summary text not null,
  profile jsonb not null,
  provider text not null,
  model_name text not null,
  model_version text not null default 'unknown',
  prompt_version text not null,
  analysis_version text not null,
  status text not null default 'READY' check (status in ('PENDING','READY','FAILED')),
  error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists asset_tag_evidence (
  id text primary key,
  asset_id text not null,
  tag text not null,
  evidence_kind text not null check (evidence_kind in ('MANUAL','QWEN_VL','FOLDER','JIANYING_HISTORY')),
  confidence numeric,
  timestamps_ms jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  unique (asset_id, tag, evidence_kind)
);

create table if not exists jianying_draft_imports (
  id text primary key,
  workspace_id text not null references video_workspaces(id) on delete cascade,
  draft_id text not null,
  draft_name text not null,
  draft_path text not null,
  status text not null default 'IMPORTED' check (status in ('IMPORTED','FAILED')),
  error jsonb,
  imported_at timestamptz not null default now()
);

create table if not exists jianying_asset_usages (
  id text primary key,
  draft_import_id text not null references jianying_draft_imports(id) on delete cascade,
  asset_id text not null,
  material_id text,
  source_in_ms integer not null default 0,
  source_out_ms integer not null,
  timeline_start_ms integer not null default 0,
  timeline_end_ms integer not null,
  created_at timestamptz not null default now()
);

create table if not exists script_editing_v3_sessions (
  id text primary key,
  workspace_id text not null references video_workspaces(id) on delete cascade,
  material_pool_snapshot_id text not null references material_pool_snapshots(id),
  script text not null,
  sentences jsonb not null default '[]'::jsonb,
  current_manifest_id text references edit_manifests(id) on delete set null,
  revision integer not null default 1 check (revision > 0),
  status text not null default 'DRAFT' check (status in ('DRAFT','READY','RENDERING','RENDERED','FAILED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table if not exists visual_queries (
  id text primary key,
  session_id text not null references script_editing_v3_sessions(id) on delete cascade,
  sentence_id text not null,
  query text not null,
  model text not null,
  prompt_version text not null,
  created_at timestamptz not null default now()
);

create table if not exists candidate_rankings (
  id text primary key,
  session_id text not null references script_editing_v3_sessions(id) on delete cascade,
  sentence_id text not null,
  asset_id text not null,
  ranking jsonb not null,
  created_at timestamptz not null default now(),
  unique (session_id, sentence_id, asset_id)
);

create table if not exists clip_instances (
  id text primary key,
  session_id text not null references script_editing_v3_sessions(id) on delete cascade,
  manifest_id text not null references edit_manifests(id) on delete cascade,
  sentence_id text not null,
  asset_id text not null,
  source_segment_id text,
  source_in_ms integer not null check (source_in_ms >= 0),
  source_out_ms integer not null check (source_out_ms > source_in_ms),
  timeline_start_ms integer not null check (timeline_start_ms >= 0),
  duration_ms integer not null check (duration_ms > 0),
  locked boolean not null default false,
  selection_source text not null check (selection_source in ('AUTO','HISTORY','MANUAL')),
  revision integer not null check (revision > 0)
);

create table if not exists script_editing_v3_operations (
  id text primary key,
  session_id text not null references script_editing_v3_sessions(id) on delete cascade,
  manifest_id text not null references edit_manifests(id) on delete cascade,
  operation jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists clip_instances_session_idx on clip_instances(session_id, revision, sentence_id);
create index if not exists candidate_rankings_session_sentence_idx on candidate_rankings(session_id, sentence_id, created_at desc);
