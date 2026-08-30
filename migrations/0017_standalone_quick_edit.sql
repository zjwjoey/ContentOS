create table video_quick_edit_sessions (
  id text primary key,
  workspace_id text not null unique references video_workspaces(id) on delete cascade,
  planner_type text not null check (planner_type = 'RANDOM_MONTAGE'),
  seed integer not null,
  target_duration_ms integer check (target_duration_ms is null or target_duration_ms > 0),
  min_clip_duration_ms integer not null default 2000 check (min_clip_duration_ms > 0),
  max_clip_duration_ms integer not null default 5000 check (max_clip_duration_ms >= min_clip_duration_ms),
  width integer not null default 1080 check (width = 1080),
  height integer not null default 1920 check (height = 1920),
  fps integer not null default 30 check (fps = 30),
  transition_policy text not null default 'CUT' check (transition_policy = 'CUT'),
  voice_asset_id text references assets(id),
  current_manifest_id text references edit_manifests(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index video_quick_edit_sessions_voice_idx on video_quick_edit_sessions (voice_asset_id);
