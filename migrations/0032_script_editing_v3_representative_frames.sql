create table if not exists asset_representative_frames (
  asset_id text not null,
  source_fingerprint text not null,
  frame_index smallint not null check (frame_index >= 0 and frame_index < 5),
  timestamp_ms integer not null check (timestamp_ms >= 0),
  frame_key text not null,
  created_at timestamptz not null default now(),
  primary key (asset_id, source_fingerprint, frame_index),
  unique (asset_id, source_fingerprint, frame_key)
);
create index if not exists asset_representative_frames_asset_idx on asset_representative_frames(asset_id, created_at desc);

create table if not exists script_editing_v3_asset_usage_stats (
  workspace_id text not null references video_workspaces(id) on delete cascade,
  asset_id text not null,
  jianying_use_count integer not null default 0 check (jianying_use_count >= 0),
  candidate_count integer not null default 0 check (candidate_count >= 0),
  selected_count integer not null default 0 check (selected_count >= 0),
  final_use_count integer not null default 0 check (final_use_count >= 0),
  replace_count integer not null default 0 check (replace_count >= 0),
  manual_select_count integer not null default 0 check (manual_select_count >= 0),
  recent_use_count integer not null default 0 check (recent_use_count >= 0),
  gold boolean not null default false,
  last_used_at timestamptz,
  updated_at timestamptz not null default now(),
  primary key (workspace_id, asset_id)
);

create table if not exists script_editing_v3_usage_events (
  id text primary key,
  workspace_id text not null references video_workspaces(id) on delete cascade,
  session_id text references script_editing_v3_sessions(id) on delete set null,
  manifest_id text not null,
  render_id text not null,
  asset_id text not null,
  created_at timestamptz not null default now(),
  unique (render_id, asset_id)
);
create index if not exists script_editing_v3_usage_events_asset_idx on script_editing_v3_usage_events(workspace_id, asset_id, created_at desc);
