drop index if exists local_media_index_fingerprint_idx;
alter table local_media_index drop column if exists source_fingerprint, drop column if exists gold;

-- Long-term relink rows intentionally remain history. Rollback is only valid
-- before any workspace relink rows have been written.
alter table script_editing_v3_asset_relinks alter column snapshot_id set not null;
