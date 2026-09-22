alter table avatar_generations
  add column if not exists source_video_asset_id text references assets(id),
  add column if not exists source_in_ms integer not null default 0 check (source_in_ms >= 0),
  add column if not exists source_out_ms integer,
  add column if not exists target_duration_ms integer;

alter table avatar_generations
  add constraint avatar_generations_source_range_check check (
    source_out_ms is null or (source_out_ms > source_in_ms and target_duration_ms is not null and target_duration_ms > 0 and source_out_ms = source_in_ms + target_duration_ms)
  ),
  add constraint avatar_generations_target_duration_check check (target_duration_ms is null or target_duration_ms > 0);
