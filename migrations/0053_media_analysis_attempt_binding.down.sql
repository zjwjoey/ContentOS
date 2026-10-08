alter table jobs drop column requires_owner_recovery;
alter table media_analysis_runs
  drop constraint media_analysis_attempt_binding_valid,
  drop column active_job_attempt_number,
  drop column active_job_attempt_id;
