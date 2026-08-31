drop index if exists publisher_request_revisions_cover_asset_idx;
alter table publisher_request_revisions
  drop column if exists cover_asset_id,
  drop column if exists hashtags;
