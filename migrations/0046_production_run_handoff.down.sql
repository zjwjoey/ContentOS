drop index if exists production_run_steps_stale_idx;
alter table production_run_steps drop column if exists stale_at;
