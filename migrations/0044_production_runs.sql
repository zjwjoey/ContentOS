create table production_runs (
  id text primary key,
  project_id text not null references content_projects(id) on delete cascade,
  title text not null check (length(trim(title)) between 1 and 200),
  template text not null default 'STANDARD_SHORT_VIDEO' check (template in ('STANDARD_SHORT_VIDEO')),
  status text not null default 'DRAFT' check (status in ('DRAFT','RUNNING','WAITING_USER','FAILED','COMPLETED','COMPLETED_WITHOUT_PUBLISH','CANCELLED')),
  current_stage text not null default 'CONTENT' check (current_stage in ('CONTENT','VOICE','DIGITAL_HUMAN','MATERIALS','EDITING','PREVIEW','APPROVAL','RENDER','PUBLISH','REVIEW')),
  digital_human_mode text not null default 'NONE' check (digital_human_mode in ('NONE','INTRO_ONLY','OUTRO_ONLY','FULL_TALKING_HEAD','CUSTOM')),
  approval_required boolean not null default true,
  approval_bypassed boolean not null default false,
  metadata jsonb not null default '{}'::jsonb,
  started_at timestamptz,
  completed_at timestamptz,
  failed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

create table production_run_steps (
  id text primary key,
  production_run_id text not null references production_runs(id) on delete cascade,
  stage text not null check (stage in ('CONTENT','VOICE','DIGITAL_HUMAN','MATERIALS','EDITING','PREVIEW','APPROVAL','RENDER','PUBLISH','REVIEW')),
  status text not null default 'PENDING' check (status in ('PENDING','RUNNING','WAITING_USER','SUCCEEDED','FAILED','SKIPPED','CANCELLED')),
  attempt integer not null default 0 check (attempt >= 0),
  idempotency_key text not null unique,
  started_at timestamptz,
  completed_at timestamptz,
  error_code text,
  error_message text,
  input_refs jsonb not null default '{}'::jsonb,
  output_refs jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (production_run_id, stage)
);

create index production_runs_project_idx on production_runs(project_id, updated_at desc);
create index production_runs_status_idx on production_runs(status, updated_at desc);
create index production_run_steps_run_idx on production_run_steps(production_run_id, stage);
