alter table material_pool_items
  add column if not exists source_fingerprint text;

alter table script_editing_v3_sessions
  add column if not exists voice_path text;

update material_pool_items
set source_fingerprint = concat(
  coalesce(file_size, 0),
  ':',
  case when modified_at is null then '' else to_char(modified_at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"') end,
  ':',
  duration_ms
)
where source_fingerprint is null;

alter table material_pool_items
  alter column source_fingerprint set not null;

create index if not exists material_pool_items_source_fingerprint_idx
  on material_pool_items(asset_id, source_fingerprint);
