drop index if exists edit_manifests_quick_edit_idempotency_key;
alter table edit_manifests drop constraint if exists edit_manifests_created_by_check;
alter table edit_manifests
  drop column if exists parent_manifest_id,
  drop column if exists edit_operations,
  drop column if exists created_by,
  drop column if exists idempotency_key,
  drop column if exists input_digest;
