create table video_workspaces (
  id text primary key,
  type text not null check (type in ('PROJECT','STANDALONE')),
  project_id text unique references content_projects(id) on delete cascade,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check ((type = 'PROJECT' and project_id is not null) or (type = 'STANDALONE' and project_id is null))
);

insert into video_workspaces (id, type, project_id)
select 'workspace-project-' || id, 'PROJECT', id from content_projects
on conflict (project_id) do nothing;

alter table jobs add column workspace_id text references video_workspaces(id);
alter table edit_manifests alter column project_id drop not null;
alter table edit_manifests add column workspace_id text references video_workspaces(id);
alter table renders alter column project_id drop not null;
alter table renders add column workspace_id text references video_workspaces(id);

update jobs set workspace_id = 'workspace-project-' || project_id where project_id is not null;
update edit_manifests set workspace_id = 'workspace-project-' || project_id where project_id is not null;
update renders set workspace_id = 'workspace-project-' || project_id where project_id is not null;

create table video_workspace_assets (
  workspace_id text not null references video_workspaces(id) on delete cascade,
  asset_id text not null references assets(id) on delete cascade,
  role text not null check (role in ('SOURCE','VOICE','OUTPUT')),
  created_at timestamptz not null default now(),
  primary key (workspace_id, asset_id, role)
);

insert into video_workspace_assets (workspace_id, asset_id, role)
select
  'workspace-project-' || project_id,
  asset_id,
  case role
    when 'RENDER' then 'OUTPUT'
    else role
  end
from project_assets
where role in ('SOURCE', 'VOICE', 'OUTPUT', 'RENDER')
on conflict do nothing;

create index jobs_workspace_idx on jobs (workspace_id, created_at);
create index edit_manifests_workspace_revision_idx on edit_manifests (workspace_id, revision);
create index renders_workspace_idx on renders (workspace_id, created_at);
