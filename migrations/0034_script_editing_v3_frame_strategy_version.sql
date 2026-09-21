alter table asset_representative_frames
  add column if not exists frame_generation_version text not null default 'representative-frames-v1';

create index if not exists asset_representative_frames_cache_idx
  on asset_representative_frames(asset_id, source_fingerprint, frame_generation_version);
