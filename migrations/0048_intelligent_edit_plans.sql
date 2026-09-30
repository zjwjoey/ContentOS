create table if not exists intelligent_edit_plans (
  id text primary key,
  project_id text not null references content_projects(id) on delete cascade,
  status text not null default 'READY' check (status in ('READY','FAILED','SUPERSEDED')),
  config jsonb not null,
  source_analysis_run_ids jsonb not null default '[]'::jsonb,
  manifest jsonb not null,
  quality jsonb not null,
  created_at timestamptz not null default now()
);
create index if not exists intelligent_edit_plans_project_idx on intelligent_edit_plans(project_id, created_at desc);

create table if not exists intelligent_edit_candidates (
  id text primary key,
  plan_id text not null references intelligent_edit_plans(id) on delete cascade,
  sentence_id text not null,
  asset_id text not null references assets(id) on delete restrict,
  score numeric not null,
  selected boolean not null default false,
  reasons jsonb not null default '[]'::jsonb,
  features jsonb not null default '{}'::jsonb
);
create index if not exists intelligent_edit_candidates_plan_idx on intelligent_edit_candidates(plan_id, sentence_id, score desc);

create table if not exists intelligent_edit_evaluations (
  id text primary key,
  plan_id text not null references intelligent_edit_plans(id) on delete cascade,
  evaluator_version text not null,
  quality jsonb not null,
  created_at timestamptz not null default now()
);
