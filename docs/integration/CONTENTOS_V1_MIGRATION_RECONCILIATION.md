# ContentOS V1 Migration Reconciliation

状态：`IMPLEMENTED`

## Final forward inventory

```text
0001–0046  main baseline
0047–0052  Intelligent Editing V1.5
```

Desktop V1's `0047_digital_human_duration.sql` is not a forward migration in
this integration because its Digital Human duration business capability is out
of scope. Its SQL semantics were not copied, renamed, or applied to new
installations.

## Existing Desktop V1 databases

Existing Desktop V1 databases may have this history row:

| Original filename | Source | Integrated forward filename | SQL semantics changed | Down pair |
| --- | --- | --- | --- | --- |
| `0047_digital_human_duration.sql` | Desktop V1 | Not included | No; not replayed | `0047_digital_human_duration.down.sql` retained only for history-compatible rollback |

The legacy down file is intentionally not an up migration: the migration loader
only scans non-`.down.sql` files for forward application. This preserves the
existing history record without making a clean integrated install apply two
different `0047` migrations.

## Gates

- Fresh DB: applies the single integrated forward inventory.
- Desktop V1 upgrade: retains `0047_digital_human_duration.sql` history and
  applies Intelligent Editing `0047`–`0052`.
- Down/reapply: uses the filename recorded in `schema_migrations`; legacy
  Desktop history has a matching compatibility down file.

The migration loader orders forward filenames lexically and writes the complete
filename to `schema_migrations`; it does not use a separate Desktop or
Intelligence migration loader.
