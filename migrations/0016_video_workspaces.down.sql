drop table if exists video_workspace_assets;
drop index if exists renders_workspace_idx;
drop index if exists edit_manifests_workspace_revision_idx;
drop index if exists jobs_workspace_idx;
-- Standalone rows cannot be represented after rollback; PostgreSQL must fail
-- this transaction rather than silently restoring a nullable legacy schema.
alter table renders alter column project_id set not null;
alter table edit_manifests alter column project_id set not null;
alter table renders drop column if exists workspace_id;
alter table edit_manifests drop column if exists workspace_id;
alter table jobs drop column if exists workspace_id;
drop table if exists video_workspaces;
