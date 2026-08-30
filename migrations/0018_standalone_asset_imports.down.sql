drop index if exists asset_imports_workspace_created_idx;
alter table asset_imports drop constraint if exists asset_imports_owner_check;
update asset_imports set workspace_id = null where workspace_id is not null;
alter table asset_imports drop column if exists workspace_id;
