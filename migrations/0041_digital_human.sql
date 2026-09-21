create table voice_profiles (
  id text primary key,
  project_id text not null references content_projects(id),
  name text not null check (length(trim(name)) between 1 and 200),
  provider text not null check (length(trim(provider)) between 1 and 100),
  reference_asset_id text references assets(id),
  provider_voice_id text,
  language text not null default 'zh',
  default_speed numeric(5,2) not null default 1.0 check (default_speed between 0.25 and 4),
  default_emotion text not null default 'natural',
  status text not null default 'DRAFT' check (status in ('DRAFT','READY','DISABLED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, project_id),
  unique (project_id, name)
);

create table avatar_profiles (
  id text primary key,
  project_id text not null references content_projects(id),
  name text not null check (length(trim(name)) between 1 and 200),
  owner_name text not null default '',
  status text not null default 'DRAFT' check (status in ('DRAFT','READY','DISABLED')),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (id, project_id),
  unique (project_id, name)
);

create table avatar_clips (
  id text primary key,
  project_id text not null references content_projects(id),
  avatar_profile_id text not null references avatar_profiles(id),
  asset_id text not null references assets(id),
  name text not null check (length(trim(name)) between 1 and 200),
  duration_ms integer check (duration_ms is null or duration_ms > 0),
  width integer check (width is null or width > 0),
  height integer check (height is null or height > 0),
  fps numeric(8,3) check (fps is null or fps > 0),
  scene_type text,
  gesture_level text,
  tags jsonb not null default '[]'::jsonb,
  status text not null default 'READY' check (status in ('DRAFT','READY','DISABLED')),
  usage_count integer not null default 0 check (usage_count >= 0),
  last_used_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (avatar_profile_id, asset_id),
  foreign key (avatar_profile_id, project_id) references avatar_profiles(id, project_id)
);

create table speech_generations (
  id text primary key,
  project_id text not null references content_projects(id),
  voice_profile_id text not null references voice_profiles(id),
  provider text not null,
  model text not null,
  model_version text,
  text text not null,
  text_hash text not null,
  parameters jsonb not null default '{}'::jsonb,
  status text not null default 'PENDING' check (status in ('PENDING','RUNNING','WAITING_EXTERNAL','SUCCEEDED','FAILED','CANCELLED')),
  job_id text not null references jobs(id),
  output_asset_id text references assets(id),
  duration_ms integer,
  latency_ms integer,
  provenance jsonb not null default '{}'::jsonb,
  error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, text_hash, voice_profile_id, provider, model)
);

create table avatar_generations (
  id text primary key,
  project_id text not null references content_projects(id),
  avatar_profile_id text not null references avatar_profiles(id),
  avatar_clip_id text not null references avatar_clips(id),
  speech_asset_id text not null references assets(id),
  provider text not null,
  model text,
  model_version text,
  external_task_id text,
  status text not null default 'PENDING' check (status in ('PENDING','RUNNING','WAITING_EXTERNAL','SUCCEEDED','FAILED','CANCELLED')),
  job_id text not null references jobs(id),
  output_asset_id text references assets(id),
  duration_ms integer,
  cost_amount numeric(14,4),
  cost_currency text,
  request_hash text not null,
  provenance jsonb not null default '{}'::jsonb,
  error jsonb,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (project_id, request_hash)
);

create index voice_profiles_project_idx on voice_profiles (project_id, updated_at desc);
create index avatar_profiles_project_idx on avatar_profiles (project_id, updated_at desc);
create index avatar_clips_profile_idx on avatar_clips (avatar_profile_id, status, usage_count);
create index speech_generations_project_idx on speech_generations (project_id, created_at desc);
create index avatar_generations_project_idx on avatar_generations (project_id, created_at desc);
create unique index avatar_generations_external_task_idx on avatar_generations (provider, external_task_id) where external_task_id is not null;
