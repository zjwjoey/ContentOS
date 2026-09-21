alter table script_editing_v3_sessions
  add column if not exists settings jsonb not null default '{}'::jsonb;
