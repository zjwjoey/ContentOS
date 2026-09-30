alter table intelligent_edit_plans
  add column if not exists render_job_id text references jobs(id) on delete set null;
create index if not exists intelligent_edit_plans_render_job_idx on intelligent_edit_plans(render_job_id);
