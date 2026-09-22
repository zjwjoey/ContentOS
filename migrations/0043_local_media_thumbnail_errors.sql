alter table local_media_index
  add column if not exists thumbnail_error text;
