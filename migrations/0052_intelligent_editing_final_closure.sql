-- Final V1.5 closure: one runtime database, immutable plan/manifest revisions,
-- provider provenance, and durable candidate selection integrity.
alter table media_analysis_runs
  add column if not exists analysis_fingerprint text,
  add column if not exists config_snapshot jsonb;

update media_analysis_runs
set analysis_fingerprint = coalesce(analysis_fingerprint, 'legacy:' || id),
    config_snapshot = coalesce(config_snapshot, jsonb_build_object('schemaVersion', 'ANALYSIS_CONFIG_SNAPSHOT_V1', 'legacy', true));

alter table intelligent_edit_plans
  add column if not exists revision integer not null default 1;
alter table intelligent_edit_plans drop constraint if exists intelligent_edit_plans_revision_check;
alter table intelligent_edit_plans add constraint intelligent_edit_plans_revision_check check (revision >= 1);

-- Repair historical duplicate selections deterministically before adding the invariant.
with ranked as (
  select id, row_number() over (partition by plan_id, sentence_id order by selected desc, score desc, id) as rank
  from intelligent_edit_candidates
  where selected
)
update intelligent_edit_candidates c
set selected = false
from ranked r
where c.id = r.id and r.rank > 1;

create unique index if not exists intelligent_edit_candidates_selected_idx
  on intelligent_edit_candidates(plan_id, sentence_id)
  where selected;
