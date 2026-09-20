alter table material_pool_items
  drop constraint if exists material_pool_items_duration_ms_check,
  add column if not exists availability text not null default 'VALID' check (availability in ('VALID','MISSING','UNREADABLE','DUPLICATE')),
  add column if not exists error_message text,
  add column if not exists disabled boolean not null default false,
  add column if not exists duplicate_of_asset_id text;

alter table material_pool_items
  add constraint material_pool_items_duration_ms_check check (duration_ms >= 0);

alter table source_segments
  add column if not exists duration_ms integer,
  add column if not exists origin text not null default 'AI_RECOMMENDED' check (origin in ('MANUAL','JIANYING_HISTORY','AI_RECOMMENDED','SHOT_DETECTION'));

update source_segments set duration_ms = source_out_ms - source_in_ms where duration_ms is null;
alter table source_segments alter column duration_ms set not null;
alter table source_segments add constraint source_segments_duration_check check (duration_ms = source_out_ms - source_in_ms and duration_ms > 0);

alter table clip_instances
  add column if not exists review_status text not null default 'UNREVIEWED' check (review_status in ('UNREVIEWED','REVIEWED','REJECTED'));

alter table script_editing_v3_asset_usage_stats
  add column if not exists content_os_final_use_count integer not null default 0 check (content_os_final_use_count >= 0);
update script_editing_v3_asset_usage_stats set content_os_final_use_count = final_use_count where content_os_final_use_count = 0 and final_use_count > 0;

alter table asset_visual_profiles
  add column if not exists source_fingerprint text;

create table if not exists asset_semantic_embeddings (
  asset_id text primary key,
  source_fingerprint text not null,
  provider text not null,
  model_name text not null,
  dimensions integer not null check (dimensions > 0),
  vector jsonb not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create index if not exists material_pool_items_availability_idx on material_pool_items(snapshot_id, availability, disabled);
