alter table material_pool_items
  drop column if exists codec,
  drop column if exists fps;
alter table local_media_index
  drop column if exists fps;

alter table local_media_scan_files
  drop column if exists fps;
