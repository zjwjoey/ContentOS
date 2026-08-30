alter table edit_manifests
  add column parent_manifest_id text references edit_manifests(id),
  add column edit_operations jsonb not null default '[]'::jsonb,
  add column created_by text,
  add column idempotency_key text,
  add column input_digest text;

alter table edit_manifests
  add constraint edit_manifests_created_by_check
  check (created_by is null or length(trim(created_by)) between 1 and 200);

create unique index edit_manifests_quick_edit_idempotency_key
  on edit_manifests(project_id, idempotency_key)
  where idempotency_key is not null;
