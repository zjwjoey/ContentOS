drop index if exists edit_batch_items_prepare_idx;
drop index if exists edit_exports_job_idx;
alter table edit_exports drop column if exists job_id;
alter table edit_batch_items drop constraint if exists edit_batch_items_state_check;
update edit_batch_items
set state = 'RUNNING'
where state in ('PREPARING', 'RENDERING');
alter table edit_batch_items add constraint edit_batch_items_state_check
  check (state in ('QUEUED','RUNNING','SUCCEEDED','FAILED','CANCELLED'));
alter table edit_batch_items
  drop column if exists source_item_ordinal,
  drop column if exists variant_index,
  drop column if exists voice_path,
  drop column if exists prepare_job_id,
  drop column if exists settings_snapshot;
