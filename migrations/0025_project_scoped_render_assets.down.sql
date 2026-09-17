drop index if exists assets_source_checksum_key;
alter table assets add constraint assets_checksum_key unique (checksum);
