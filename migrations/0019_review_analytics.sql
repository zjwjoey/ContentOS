create table review_metric_snapshots (
  id text primary key,
  project_id text not null references content_projects(id) on delete cascade,
  external_post_id text not null,
  platform_id text not null,
  captured_at timestamptz not null,
  published_at timestamptz,
  metrics jsonb not null,
  source text not null check (source in ('FAKE', 'IMPORT')),
  source_reference text not null,
  schema_version text not null check (schema_version = 'METRIC_SNAPSHOT_V1'),
  created_at timestamptz not null default now(),
  constraint review_metric_snapshots_external_source_capture_key unique (external_post_id, source, captured_at),
  constraint review_metric_snapshots_metrics_check check (
    jsonb_typeof(metrics) = 'object'
    and metrics ?& array['plays', 'likes', 'comments', 'saves', 'shares']
    and jsonb_typeof(metrics->'plays') = 'number'
    and jsonb_typeof(metrics->'likes') = 'number'
    and jsonb_typeof(metrics->'comments') = 'number'
    and jsonb_typeof(metrics->'saves') = 'number'
    and jsonb_typeof(metrics->'shares') = 'number'
    and (metrics->>'plays')::numeric >= 0 and (metrics->>'plays')::numeric = trunc((metrics->>'plays')::numeric)
    and (metrics->>'likes')::numeric >= 0 and (metrics->>'likes')::numeric = trunc((metrics->>'likes')::numeric)
    and (metrics->>'comments')::numeric >= 0 and (metrics->>'comments')::numeric = trunc((metrics->>'comments')::numeric)
    and (metrics->>'saves')::numeric >= 0 and (metrics->>'saves')::numeric = trunc((metrics->>'saves')::numeric)
    and (metrics->>'shares')::numeric >= 0 and (metrics->>'shares')::numeric = trunc((metrics->>'shares')::numeric)
  )
);

create table review_analysis_reports (
  id text primary key,
  project_id text not null references content_projects(id) on delete cascade,
  external_post_id text not null,
  metric_snapshot_ids text[] not null check (cardinality(metric_snapshot_ids) > 0),
  schema_version text not null check (schema_version = 'REVIEW_ANALYSIS_REPORT_V1'),
  summary text not null,
  highlights jsonb not null default '[]'::jsonb,
  risks jsonb not null default '[]'::jsonb,
  recommendations jsonb not null default '[]'::jsonb,
  ai_run_id text not null references ai_runs(id),
  created_at timestamptz not null default now()
);

create index review_metric_snapshots_project_post_idx on review_metric_snapshots (project_id, external_post_id, captured_at desc);
create index review_analysis_reports_project_post_idx on review_analysis_reports (project_id, external_post_id, created_at desc);

alter table ai_runs drop constraint if exists ai_runs_operation_check;
alter table ai_runs add constraint ai_runs_operation_check check (operation in ('DIRECTOR_GENERATE_SCRIPT', 'DIRECTOR_GENERATE_STORYBOARD', 'REVIEW_GENERATE_ANALYSIS'));
