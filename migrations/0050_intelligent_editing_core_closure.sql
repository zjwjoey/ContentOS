-- V1.5 core closure is append-only. 0047-0049 are already published history.
alter table media_analysis_runs
  add column if not exists source_checksum text,
  add column if not exists pipeline_version text not null default 'intelligent-editing-v15-core-closure-1';

alter table media_analysis_runs drop constraint if exists media_analysis_runs_status_check;
alter table media_analysis_runs add constraint media_analysis_runs_status_check
  check (status in ('QUEUED','RUNNING','SUCCEEDED','PARTIAL','FAILED','CANCELLED','STALE'));

alter table media_analysis_keyframes
  add column if not exists error jsonb;

alter table media_analysis_asr_segments
  add column if not exists segment_index integer;
update media_analysis_asr_segments
set segment_index = ranked.segment_index
from (
  select id, row_number() over (partition by run_id order by start_ms, end_ms, id) - 1 as segment_index
  from media_analysis_asr_segments
) ranked
where media_analysis_asr_segments.id = ranked.id
  and media_analysis_asr_segments.segment_index is null;
alter table media_analysis_asr_segments alter column segment_index set not null;
alter table media_analysis_asr_segments drop constraint if exists media_analysis_asr_segments_segment_index_check;
alter table media_analysis_asr_segments add constraint media_analysis_asr_segments_segment_index_check check (segment_index >= 0);
create unique index if not exists media_analysis_asr_run_segment_idx on media_analysis_asr_segments(run_id, segment_index);

alter table media_analysis_vision_results
  add column if not exists normalized jsonb not null default '{}'::jsonb;
create unique index if not exists media_analysis_vision_run_shot_idx
  on media_analysis_vision_results(run_id, shot_id)
  where shot_id is not null;

alter table media_analysis_embeddings
  add column if not exists shot_id text references media_analysis_shots(id) on delete set null,
  add column if not exists input_digest text not null default '';
create index if not exists media_analysis_embeddings_shot_idx on media_analysis_embeddings(shot_id, content_type);

alter table intelligent_edit_candidates
  add column if not exists shot_id text references media_analysis_shots(id) on delete set null,
  add column if not exists source_in_ms integer,
  add column if not exists source_out_ms integer;
alter table intelligent_edit_candidates drop constraint if exists intelligent_edit_candidates_source_range_check;
alter table intelligent_edit_candidates add constraint intelligent_edit_candidates_source_range_check
  check (source_in_ms is null or (source_in_ms >= 0 and source_out_ms is not null and source_out_ms > source_in_ms));
create index if not exists intelligent_edit_candidates_shot_idx on intelligent_edit_candidates(plan_id, shot_id, sentence_id, score desc);

alter table intelligent_edit_plans
  add column if not exists manifest_id text references edit_manifests(id) on delete set null,
  add column if not exists video_revision_id text references edit_manifests(id) on delete set null,
  add column if not exists planner_version text not null default 'intelligent-planner-v1',
  add column if not exists analysis_version text;
create index if not exists intelligent_edit_plans_manifest_idx on intelligent_edit_plans(manifest_id);

create table if not exists editing_decision_events (
  id text primary key,
  project_id text not null references content_projects(id) on delete cascade,
  plan_id text not null references intelligent_edit_plans(id) on delete cascade,
  sentence_id text,
  event_type text not null check (event_type in ('SHOT_ACCEPTED','SHOT_REPLACED','SHOT_EXCLUDED','ASSET_EXCLUDED','DURATION_CHANGED')),
  previous_candidate_id text references intelligent_edit_candidates(id) on delete set null,
  next_candidate_id text references intelligent_edit_candidates(id) on delete set null,
  previous_shot_id text references media_analysis_shots(id) on delete set null,
  next_shot_id text references media_analysis_shots(id) on delete set null,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);
create index if not exists editing_decision_events_plan_idx on editing_decision_events(project_id, plan_id, created_at);
