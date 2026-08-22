create table approval_decisions (
  id text primary key,
  project_id text not null references content_projects(id),
  target_type text not null check (target_type in ('SCRIPT', 'STORYBOARD', 'RENDER', 'PUBLISH')),
  target_id text not null,
  target_revision_id text not null,
  revision integer not null check (revision > 0),
  schema_version text not null check (schema_version = 'APPROVAL_V0'),
  status text not null check (status in ('PENDING', 'APPROVED', 'REJECTED')),
  approver text not null,
  reason text,
  evidence jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  unique (project_id, target_type, target_id, target_revision_id, revision)
);

create index approval_decision_current_idx on approval_decisions (project_id, target_type, target_id, target_revision_id, revision desc);

