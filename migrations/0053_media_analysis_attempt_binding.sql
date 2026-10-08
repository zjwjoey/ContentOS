alter table media_analysis_runs
  add column active_job_attempt_id text,
  add column active_job_attempt_number integer,
  add constraint media_analysis_attempt_binding_valid check (
    (active_job_attempt_id is null and active_job_attempt_number is null)
    or (active_job_attempt_id is not null and active_job_attempt_number is not null and active_job_attempt_number > 0)
  );
alter table jobs add column requires_owner_recovery boolean not null default false;
