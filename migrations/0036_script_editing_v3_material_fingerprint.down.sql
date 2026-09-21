drop index if exists material_pool_items_source_fingerprint_idx;
alter table material_pool_items drop column if exists source_fingerprint;
alter table script_editing_v3_sessions drop column if exists voice_path;
