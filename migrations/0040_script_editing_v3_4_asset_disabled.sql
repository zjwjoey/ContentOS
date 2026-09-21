alter table local_media_index
  add column if not exists disabled boolean not null default false;

create index if not exists local_media_index_disabled_idx
  on local_media_index(disabled, updated_at desc);
