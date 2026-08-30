alter table ai_runs drop constraint if exists ai_runs_operation_check;
alter table ai_runs add constraint ai_runs_operation_check check (operation in ('DIRECTOR_GENERATE_SCRIPT', 'DIRECTOR_GENERATE_STORYBOARD'));
drop index if exists review_analysis_reports_project_post_idx;
drop index if exists review_metric_snapshots_project_post_idx;
drop table if exists review_analysis_reports;
drop table if exists review_metric_snapshots;
