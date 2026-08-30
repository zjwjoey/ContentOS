alter table asset_imports alter column project_id drop not null;
alter table asset_imports add column workspace_id text references video_workspaces(id) on delete cascade;
alter table asset_imports add constraint asset_imports_owner_check check ((project_id is not null) <> (workspace_id is not null));
create index asset_imports_workspace_created_idx on asset_imports (workspace_id, created_at desc);
