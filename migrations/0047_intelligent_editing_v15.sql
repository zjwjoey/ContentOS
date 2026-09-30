create table if not exists media_analysis_runs (
  id text primary key,
  project_id text not null references content_projects(id) on delete cascade,
  asset_id text not null references assets(id) on delete cascade,
  status text not null default 'QUEUED' check (status in ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED')),
  capabilities text[] not null,
  provider_mode text not null default 'FAKE' check (provider_mode in ('FAKE','REAL')),
  analysis_version text not null,
  idempotency_key text not null,
  job_id text references jobs(id) on delete set null,
  attempt_count integer not null default 0 check (attempt_count >= 0),
  error jsonb,
  created_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz,
  unique (project_id, idempotency_key)
);
create index if not exists media_analysis_runs_asset_idx on media_analysis_runs(project_id, asset_id, created_at desc);
create index if not exists media_analysis_runs_status_idx on media_analysis_runs(status, created_at);

create table if not exists media_analysis_technical (
  run_id text primary key references media_analysis_runs(id) on delete cascade,
  asset_id text not null references assets(id) on delete cascade,
  duration_ms integer not null check (duration_ms >= 0),
  width integer not null check (width >= 0),
  height integer not null check (height >= 0),
  fps numeric,
  format text,
  video_codec text,
  audio_codec text,
  has_audio boolean not null default false,
  provider text not null,
  model_version text not null,
  created_at timestamptz not null default now()
);

create table if not exists media_analysis_shots (
  id text primary key,
  run_id text not null references media_analysis_runs(id) on delete cascade,
  asset_id text not null references assets(id) on delete cascade,
  shot_index integer not null check (shot_index >= 0),
  source_in_ms integer not null check (source_in_ms >= 0),
  source_out_ms integer not null check (source_out_ms > source_in_ms),
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  detection_version text not null,
  unique (run_id, shot_index)
);
create index if not exists media_analysis_shots_asset_idx on media_analysis_shots(asset_id, source_in_ms);

create table if not exists media_analysis_keyframes (
  id text primary key,
  run_id text not null references media_analysis_runs(id) on delete cascade,
  asset_id text not null references assets(id) on delete cascade,
  shot_id text not null references media_analysis_shots(id) on delete cascade,
  timestamp_ms integer not null check (timestamp_ms >= 0),
  storage_key text not null,
  frame_hash text not null,
  status text not null check (status in ('REFERENCED','READY','FAILED')),
  unique (run_id, shot_id, timestamp_ms)
);

create table if not exists media_analysis_asr_segments (
  id text primary key,
  run_id text not null references media_analysis_runs(id) on delete cascade,
  asset_id text not null references assets(id) on delete cascade,
  start_ms integer not null check (start_ms >= 0),
  end_ms integer not null check (end_ms > start_ms),
  text text not null,
  speaker text,
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  provider text not null,
  model_version text not null
);
create index if not exists media_analysis_asr_search_idx on media_analysis_asr_segments(asset_id, start_ms);

create table if not exists media_analysis_vision_results (
  id text primary key,
  run_id text not null references media_analysis_runs(id) on delete cascade,
  asset_id text not null references assets(id) on delete cascade,
  shot_id text references media_analysis_shots(id) on delete set null,
  summary text not null,
  tags jsonb not null default '[]'::jsonb,
  provider text not null,
  model_version text not null,
  prompt_version text not null
);
create index if not exists media_analysis_vision_asset_idx on media_analysis_vision_results(asset_id, run_id);

create table if not exists media_analysis_embeddings (
  id text primary key,
  run_id text not null references media_analysis_runs(id) on delete cascade,
  asset_id text not null references assets(id) on delete cascade,
  content_type text not null check (content_type in ('ASSET','ASR','VISION')),
  content_id text not null,
  text_snapshot text not null,
  vector jsonb not null,
  dimensions integer not null check (dimensions > 0),
  provider text not null,
  model_version text not null,
  unique (run_id, content_type, content_id)
);
create index if not exists media_analysis_embeddings_asset_idx on media_analysis_embeddings(asset_id, content_type);
