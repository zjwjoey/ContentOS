alter table edit_batch_items
  add column if not exists source_item_ordinal integer,
  add column if not exists variant_index integer not null default 0,
  add column if not exists voice_path text,
  add column if not exists prepare_job_id text references jobs(id) on delete set null,
  add column if not exists settings_snapshot jsonb not null default '{}'::jsonb;

alter table edit_batch_items drop constraint if exists edit_batch_items_state_check;
alter table edit_batch_items add constraint edit_batch_items_state_check
  check (state in ('QUEUED','PREPARING','RENDERING','RUNNING','SUCCEEDED','FAILED','CANCELLED'));

create index if not exists edit_batch_items_prepare_idx on edit_batch_items(state, updated_at);
alter table edit_exports
  add column if not exists job_id text references jobs(id) on delete set null;
create index if not exists edit_exports_job_idx on edit_exports(job_id);
