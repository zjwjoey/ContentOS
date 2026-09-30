drop index if exists intelligent_edit_candidates_selected_idx;
alter table intelligent_edit_plans drop constraint if exists intelligent_edit_plans_revision_check;
alter table intelligent_edit_plans drop column if exists revision;
alter table media_analysis_runs drop column if exists analysis_fingerprint;
alter table media_analysis_runs drop column if exists config_snapshot;
