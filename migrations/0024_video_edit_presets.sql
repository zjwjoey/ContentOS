create table if not exists video_edit_presets (
  id text primary key,
  name text not null,
  description text not null default '',
  edit_mode_default text not null default 'SCRIPT' check (edit_mode_default in ('SCRIPT','RANDOM')),
  min_clip_duration_ms integer not null default 2000 check (min_clip_duration_ms > 0),
  max_clip_duration_ms integer not null default 5000 check (max_clip_duration_ms >= min_clip_duration_ms),
  prefer_unused_media boolean not null default true,
  intro_asset_id text,
  outro_asset_id text,
  canvas jsonb not null default '{"width":1080,"height":1920,"aspectRatio":"9:16"}'::jsonb,
  fps integer not null default 30 check (fps > 0 and fps <= 120),
  is_default boolean not null default false,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);
create unique index if not exists video_edit_presets_name_idx on video_edit_presets(lower(name));
create unique index if not exists video_edit_presets_default_idx on video_edit_presets(is_default) where is_default;
alter table content_projects add column if not exists current_preset_id text references video_edit_presets(id) on delete set null;

insert into video_edit_presets (id, name, description, edit_mode_default, min_clip_duration_ms, max_clip_duration_ms, prefer_unused_media, is_default)
values ('preset-mizan-store', 'MIZAN 门店口播', '9:16 门店口播，优先近期未使用素材。', 'SCRIPT', 2000, 5000, true, true)
on conflict (id) do nothing;
insert into video_edit_presets (id, name, description, edit_mode_default, min_clip_duration_ms, max_clip_duration_ms, prefer_unused_media, is_default)
values ('preset-default-short', '默认短视频', '适合日常短视频的通用剪辑设置。', 'SCRIPT', 2000, 5000, true, false)
on conflict (id) do nothing;
insert into video_edit_presets (id, name, description, edit_mode_default, min_clip_duration_ms, max_clip_duration_ms, prefer_unused_media, is_default)
values ('preset-business-analysis', '商业分析', '信息密度较高的分析类短视频。', 'SCRIPT', 2500, 6000, true, false)
on conflict (id) do nothing;
insert into video_edit_presets (id, name, description, edit_mode_default, min_clip_duration_ms, max_clip_duration_ms, prefer_unused_media, is_default)
values ('preset-product-recommendation', '产品推荐', '突出产品画面与卖点的推荐视频。', 'RANDOM', 2000, 5000, true, false)
on conflict (id) do nothing;
