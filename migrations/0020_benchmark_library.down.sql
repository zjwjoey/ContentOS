alter table ai_runs drop constraint if exists ai_runs_operation_check;
alter table ai_runs add constraint ai_runs_operation_check check (operation in ('DIRECTOR_GENERATE_SCRIPT', 'DIRECTOR_GENERATE_STORYBOARD', 'REVIEW_GENERATE_ANALYSIS'));
drop index if exists benchmark_analyses_content_idx;
drop index if exists benchmark_contents_project_idx;
drop index if exists benchmark_accounts_project_idx;
drop table if exists benchmark_references;
drop table if exists benchmark_analyses;
drop table if exists benchmark_contents;
drop table if exists benchmark_accounts;
