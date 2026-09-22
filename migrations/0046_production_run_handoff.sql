alter table production_run_steps add column if not exists stale_at timestamptz;
create index if not exists production_run_steps_stale_idx on production_run_steps(production_run_id, stage, stale_at);
