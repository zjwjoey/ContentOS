drop index if exists intelligent_edit_plans_render_job_idx;
alter table intelligent_edit_plans drop column if exists render_job_id;
