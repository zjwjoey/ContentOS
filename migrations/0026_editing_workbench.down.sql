drop table if exists edit_exports;
drop table if exists edit_batch_items;
drop table if exists edit_batches;
drop table if exists edit_workbench_sessions;
drop index if exists local_media_scans_workspace_idx;
alter table local_media_scans drop constraint if exists local_media_scans_owner_check;
alter table local_media_scans add constraint local_media_scans_project_id_workspace_id_check
  check ((project_id is not null and workspace_id is null) or (project_id is null and workspace_id is not null));
alter table local_media_scans drop column if exists workspace_id;
alter table video_quick_edit_sessions drop column if exists source_roots;
alter table video_quick_edit_sessions drop column if exists script;
