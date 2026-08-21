create table director_plan_revisions (
  id text primary key,
  project_id text not null references content_projects(id),
  revision integer not null check (revision > 0),
  schema_version text not null check (schema_version = 'DIRECTOR_PLAN_V0'),
  brief jsonb not null,
  storyboard jsonb not null,
  provenance jsonb not null default '{}'::jsonb,
  status text not null check (status in ('DRAFT','ACCEPTED','APPROVED','SUPERSEDED')),
  created_at timestamptz not null default now(),
  unique (project_id, revision)
);

alter table content_projects add column current_director_revision_id text references director_plan_revisions(id);
create index director_plan_project_idx on director_plan_revisions (project_id, revision desc);
