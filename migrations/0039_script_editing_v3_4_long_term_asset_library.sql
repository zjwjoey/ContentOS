alter table local_media_index
  add column if not exists source_fingerprint text,
  add column if not exists gold boolean not null default false;

create index if not exists local_media_index_fingerprint_idx
  on local_media_index(source_fingerprint);

update local_media_index
set source_fingerprint = concat(coalesce(file_size, 0), ':', coalesce(to_char(modified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'), ''), ':', greatest(duration_ms, 0))
where source_fingerprint is null;

alter table script_editing_v3_asset_relinks
  alter column snapshot_id drop not null;

alter table script_editing_v3_asset_relinks
  drop constraint if exists script_editing_v3_asset_relinks_snapshot_id_fkey;

alter table script_editing_v3_asset_relinks
  add constraint script_editing_v3_asset_relinks_snapshot_id_fkey
  foreign key (snapshot_id) references material_pool_snapshots(id) on delete cascade;
