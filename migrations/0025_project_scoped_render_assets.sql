alter table assets drop constraint if exists assets_checksum_key;
create unique index if not exists assets_source_checksum_key on assets (checksum) where kind <> 'VIDEO_RENDER';
