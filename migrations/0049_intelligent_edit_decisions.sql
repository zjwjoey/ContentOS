create table if not exists intelligent_edit_presets (
  id text primary key,
  project_id text references content_projects(id) on delete cascade,
  name text not null,
  config jsonb not null,
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  unique (project_id, name)
);

create table if not exists intelligent_edit_recommendations (
  id text primary key,
  project_id text not null references content_projects(id) on delete cascade,
  plan_id text not null references intelligent_edit_plans(id) on delete cascade,
  preset_id text references intelligent_edit_presets(id) on delete set null,
  profile text not null,
  confidence numeric not null check (confidence >= 0 and confidence <= 1),
  alternatives jsonb not null default '[]'::jsonb,
  limitations jsonb not null default '[]'::jsonb,
  evidence jsonb not null default '{}'::jsonb,
  status text not null default 'PROPOSED' check (status in ('PROPOSED','ACCEPTED','DISMISSED')),
  created_at timestamptz not null default now()
);
create index if not exists intelligent_edit_recommendations_plan_idx on intelligent_edit_recommendations(project_id, plan_id, created_at desc);
