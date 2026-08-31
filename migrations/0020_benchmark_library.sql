create table benchmark_accounts (
  id text primary key,
  project_id text not null references content_projects(id) on delete cascade,
  platform text not null,
  account_name text not null,
  account_url text,
  positioning text not null,
  category text not null,
  keywords jsonb not null default '[]'::jsonb,
  notes text not null default '',
  created_at timestamptz not null default now(),
  constraint benchmark_accounts_id_project_key unique (id, project_id)
);

create table benchmark_contents (
  id text primary key,
  project_id text not null references content_projects(id) on delete cascade,
  benchmark_account_id text not null references benchmark_accounts(id) on delete cascade,
  platform text not null,
  title text not null,
  url text,
  copy text not null,
  publish_date timestamptz,
  metrics jsonb,
  notes text not null default '',
  created_at timestamptz not null default now(),
  constraint benchmark_contents_id_project_key unique (id, project_id),
  constraint benchmark_contents_account_project_fk foreign key (benchmark_account_id, project_id) references benchmark_accounts(id, project_id)
);

create table benchmark_analyses (
  id text primary key,
  project_id text not null references content_projects(id) on delete cascade,
  benchmark_content_id text not null references benchmark_contents(id) on delete cascade,
  ai_run_id text not null references ai_runs(id),
  analysis jsonb not null,
  created_at timestamptz not null default now(),
  constraint benchmark_analyses_content_project_fk foreign key (benchmark_content_id, project_id) references benchmark_contents(id, project_id)
);

create table benchmark_references (
  project_id text not null references content_projects(id) on delete cascade,
  benchmark_content_id text not null references benchmark_contents(id) on delete cascade,
  created_at timestamptz not null default now(),
  primary key (project_id, benchmark_content_id),
  constraint benchmark_references_content_project_fk foreign key (benchmark_content_id, project_id) references benchmark_contents(id, project_id)
);

create index benchmark_accounts_project_idx on benchmark_accounts (project_id, created_at desc);
create index benchmark_contents_project_idx on benchmark_contents (project_id, created_at desc);
create index benchmark_analyses_content_idx on benchmark_analyses (benchmark_content_id, created_at desc);

alter table ai_runs drop constraint if exists ai_runs_operation_check;
alter table ai_runs add constraint ai_runs_operation_check check (operation in ('DIRECTOR_GENERATE_SCRIPT', 'DIRECTOR_GENERATE_STORYBOARD', 'REVIEW_GENERATE_ANALYSIS', 'BENCHMARK_ANALYZE'));
