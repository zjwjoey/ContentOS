drop table if exists local_media_usage;
drop table if exists local_media_index;
alter table local_media_scan_files
  drop column if exists thumbnail_status,
  drop column if exists thumbnail_key,
  drop column if exists category,
  drop column if exists tags,
  drop column if exists modified_at,
  drop column if exists file_size,
  drop column if exists orientation;
