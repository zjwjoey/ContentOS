alter table avatar_generations drop constraint if exists avatar_generations_source_range_check;
alter table avatar_generations drop constraint if exists avatar_generations_target_duration_check;
alter table avatar_generations drop column if exists target_duration_ms;
alter table avatar_generations drop column if exists source_out_ms;
alter table avatar_generations drop column if exists source_in_ms;
alter table avatar_generations drop column if exists source_video_asset_id;
