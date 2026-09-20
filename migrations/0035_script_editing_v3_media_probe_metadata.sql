alter table local_media_scan_files
  add column if not exists fps numeric;

alter table local_media_index
  add column if not exists fps numeric;

alter table material_pool_items
  add column if not exists fps numeric,
  add column if not exists codec text;
