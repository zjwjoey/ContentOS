drop index if exists asset_representative_frames_cache_idx;
alter table asset_representative_frames
  drop column if exists frame_generation_version;
