alter table production_runs add column if not exists idempotency_key text;
create unique index if not exists production_runs_project_idempotency_key_uq
  on production_runs(project_id, idempotency_key)
  where idempotency_key is not null;
