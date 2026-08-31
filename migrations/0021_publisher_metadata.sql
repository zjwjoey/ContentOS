alter table publisher_request_revisions
  add column hashtags jsonb not null default '[]'::jsonb,
  add column cover_asset_id text;

create index publisher_request_revisions_cover_asset_idx on publisher_request_revisions (cover_asset_id) where cover_asset_id is not null;
