create table if not exists local_path_grants (
  id uuid primary key default gen_random_uuid(),
  path text not null,
  canonical_path text not null,
  kind text not null check (kind in ('MEDIA_ROOT','OUTPUT_ROOT','VOICE_FILE','MUSIC_ROOT','PRIORITY_ASSET')),
  mode text not null check (mode in ('READ','WRITE','READ_WRITE')),
  source text not null check (source in ('NATIVE_PICKER','ENV')),
  created_at timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  unique (canonical_path, kind)
);
create index if not exists local_path_grants_kind_idx on local_path_grants(kind, last_used_at desc);

