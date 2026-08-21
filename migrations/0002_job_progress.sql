alter table jobs add column progress jsonb not null default '{}'::jsonb;
alter table jobs add column retry_at timestamptz;
