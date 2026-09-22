drop index if exists production_runs_project_idempotency_key_uq;
alter table production_runs drop column if exists idempotency_key;
