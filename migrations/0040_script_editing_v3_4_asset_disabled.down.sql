drop index if exists local_media_index_disabled_idx;
alter table local_media_index drop column if exists disabled;
