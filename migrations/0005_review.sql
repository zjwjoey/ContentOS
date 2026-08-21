create table review_decisions (
  id text primary key,
  project_id text not null references content_projects(id),
  target_type text not null check (target_type in ('RENDER', 'PUBLISH')),
  target_id text not null,
  revision integer not null check (revision > 0),
  schema_version text not null check (schema_version = 'REVIEW_V0'),
  status text not null check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  reviewer text not null,
  reason text,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (project_id, target_type, target_id, revision)
);

create index review_decision_current_idx on review_decisions (project_id, target_type, target_id, revision desc);
