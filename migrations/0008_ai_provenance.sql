create table ai_prompt_versions (
  id text primary key,
  key text not null,
  version integer not null check (version > 0),
  template_hash text not null,
  template text not null,
  required_variables jsonb not null default '[]'::jsonb,
  created_at timestamptz not null default now(),
  constraint ai_prompt_versions_key_version_key unique (key, version)
);

create table ai_model_profiles (
  id text primary key,
  provider_id text not null,
  model_id text not null,
  display_name text not null,
  capabilities jsonb not null default '[]'::jsonb,
  max_input_characters integer not null check (max_input_characters between 1 and 100000),
  max_output_tokens integer not null check (max_output_tokens between 1 and 16000),
  enabled boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint ai_model_profiles_provider_model_key unique (provider_id, model_id)
);

create table ai_runs (
  id text primary key,
  project_id text not null references content_projects(id),
  job_id text not null references jobs(id),
  attempt_id text not null references job_attempts(id),
  run_number integer not null check (run_number > 0),
  request_id text not null,
  correlation_id text not null,
  operation text not null check (operation in ('DIRECTOR_GENERATE_SCRIPT', 'DIRECTOR_GENERATE_STORYBOARD')),
  provider_id text not null,
  model_profile_id text not null references ai_model_profiles(id),
  prompt_version_id text not null references ai_prompt_versions(id),
  input_hash text not null,
  input_snapshot jsonb not null default '{}'::jsonb,
  output_hash text,
  output_snapshot jsonb,
  status text not null check (status in ('RUNNING', 'SUCCEEDED', 'FAILED')),
  usage jsonb not null default '{}'::jsonb,
  error jsonb,
  created_at timestamptz not null default now(),
  finished_at timestamptz,
  constraint ai_runs_job_attempt_number_key unique (job_id, attempt_id, run_number)
);

alter table director_script_revisions
  add constraint director_script_revisions_ai_run_fk foreign key (ai_run_id) references ai_runs(id),
  add constraint director_script_revisions_prompt_version_fk foreign key (prompt_version_id) references ai_prompt_versions(id);

alter table director_storyboard_revisions
  add constraint director_storyboard_revisions_ai_run_fk foreign key (ai_run_id) references ai_runs(id),
  add constraint director_storyboard_revisions_prompt_version_fk foreign key (prompt_version_id) references ai_prompt_versions(id);

create index ai_runs_project_idx on ai_runs (project_id, created_at desc);
create index ai_runs_job_idx on ai_runs (job_id, attempt_id, run_number);
