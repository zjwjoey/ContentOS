create table director_briefs (
  id text primary key,
  project_id text not null references content_projects(id),
  revision integer not null check (revision > 0),
  schema_version text not null check (schema_version = 'CONTENT_BRIEF_V1'),
  topic text not null,
  target_platform text not null,
  channel_positioning text not null,
  target_duration_seconds integer not null check (target_duration_seconds between 1 and 600),
  content_type text not null,
  audience text not null,
  core_thesis text not null,
  tone text not null,
  cta_goal text,
  reference_material text not null default '',
  must_include jsonb not null default '[]'::jsonb,
  must_avoid jsonb not null default '[]'::jsonb,
  requirements jsonb not null default '{}'::jsonb,
  created_by text not null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint director_briefs_project_revision_key unique (project_id, revision),
  constraint director_briefs_id_project_key unique (id, project_id)
);

create table director_scripts (
  id text primary key,
  project_id text not null references content_projects(id),
  brief_id text not null,
  created_at timestamptz not null default now(),
  constraint director_scripts_id_project_key unique (id, project_id),
  constraint director_scripts_brief_project_fk foreign key (brief_id, project_id) references director_briefs(id, project_id)
);

create table director_script_revisions (
  id text primary key,
  aggregate_id text not null,
  project_id text not null references content_projects(id),
  brief_id text not null,
  revision integer not null check (revision > 0),
  schema_version text not null check (schema_version = 'SCRIPT_REVISION_V1'),
  parent_revision_id text,
  origin text not null check (origin in ('AI', 'MANUAL', 'IMPORTED')),
  status text not null check (status in ('DRAFT', 'ACCEPTED', 'SUPERSEDED')),
  title text not null,
  title_candidates jsonb not null,
  cover_text text not null,
  topic_keywords jsonb not null,
  hook text not null,
  body text not null,
  cta text,
  source_job_id text references jobs(id),
  ai_run_id text,
  prompt_version_id text,
  created_by text not null,
  created_at timestamptz not null default now(),
  constraint director_script_revisions_aggregate_revision_key unique (aggregate_id, revision),
  constraint director_script_revisions_source_job_key unique (source_job_id),
  constraint director_script_revisions_id_project_key unique (id, project_id),
  constraint director_script_revisions_aggregate_project_fk foreign key (aggregate_id, project_id) references director_scripts(id, project_id),
  constraint director_script_revisions_brief_project_fk foreign key (brief_id, project_id) references director_briefs(id, project_id),
  constraint director_script_revisions_parent_fk foreign key (parent_revision_id) references director_script_revisions(id)
);

create table director_storyboards (
  id text primary key,
  project_id text not null references content_projects(id),
  created_at timestamptz not null default now(),
  constraint director_storyboards_id_project_key unique (id, project_id)
);

create table director_storyboard_revisions (
  id text primary key,
  aggregate_id text not null,
  project_id text not null references content_projects(id),
  script_revision_id text not null,
  revision integer not null check (revision > 0),
  schema_version text not null check (schema_version = 'STORYBOARD_REVISION_V1'),
  origin text not null check (origin in ('AI', 'MANUAL', 'IMPORTED')),
  status text not null check (status in ('DRAFT', 'APPROVED', 'SUPERSEDED')),
  scenes jsonb not null,
  source_job_id text references jobs(id),
  ai_run_id text,
  prompt_version_id text,
  created_by text not null,
  created_at timestamptz not null default now(),
  constraint director_storyboard_revisions_aggregate_revision_key unique (aggregate_id, revision),
  constraint director_storyboard_revisions_source_job_key unique (source_job_id),
  constraint director_storyboard_revisions_id_project_key unique (id, project_id),
  constraint director_storyboard_revisions_aggregate_project_fk foreign key (aggregate_id, project_id) references director_storyboards(id, project_id),
  constraint director_storyboard_revisions_script_project_fk foreign key (script_revision_id, project_id) references director_script_revisions(id, project_id)
);

create table director_project_state (
  project_id text primary key references content_projects(id),
  active_brief_id text,
  active_script_aggregate_id text,
  active_script_revision_id text,
  active_storyboard_aggregate_id text,
  active_storyboard_revision_id text,
  next_brief_revision integer not null default 1 check (next_brief_revision > 0),
  next_script_revision integer not null default 1 check (next_script_revision > 0),
  next_storyboard_revision integer not null default 1 check (next_storyboard_revision > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint director_state_brief_project_fk foreign key (active_brief_id, project_id) references director_briefs(id, project_id),
  constraint director_state_script_aggregate_project_fk foreign key (active_script_aggregate_id, project_id) references director_scripts(id, project_id),
  constraint director_state_script_revision_project_fk foreign key (active_script_revision_id, project_id) references director_script_revisions(id, project_id),
  constraint director_state_storyboard_aggregate_project_fk foreign key (active_storyboard_aggregate_id, project_id) references director_storyboards(id, project_id),
  constraint director_state_storyboard_revision_project_fk foreign key (active_storyboard_revision_id, project_id) references director_storyboard_revisions(id, project_id)
);

create index director_briefs_project_idx on director_briefs (project_id, revision desc);
create index director_script_revisions_project_idx on director_script_revisions (project_id, aggregate_id, revision desc);
create index director_storyboard_revisions_project_idx on director_storyboard_revisions (project_id, aggregate_id, revision desc);
