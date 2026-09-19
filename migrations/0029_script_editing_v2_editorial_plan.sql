create table if not exists edit_script_plans (
  id uuid primary key default gen_random_uuid(),
  workspace_id text not null,
  script text not null,
  voice_asset_id text,
  template_id text not null default 'COMMERCIAL_OPINION',
  settings jsonb not null default '{}'::jsonb,
  source_roots jsonb not null default '[]'::jsonb,
  editorial_plan jsonb,
  resolved_plan jsonb,
  revision integer not null default 1 check (revision > 0),
  status text not null default 'DRAFT' check (status in ('DRAFT','QUEUED','PLANNING','READY','FAILED','RENDERING','RENDERED')),
  job_id text,
  current_manifest_id text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create index if not exists edit_script_plans_workspace_idx on edit_script_plans(workspace_id, updated_at desc);
