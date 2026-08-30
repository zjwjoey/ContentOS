alter table director_storyboard_revisions
  drop constraint director_storyboard_revisions_prompt_version_fk,
  drop constraint director_storyboard_revisions_ai_run_fk;

alter table director_script_revisions
  drop constraint director_script_revisions_prompt_version_fk,
  drop constraint director_script_revisions_ai_run_fk;

-- ai_run_id/prompt_version_id are nullable provenance fields declared with the
-- Director rows; a down migration must not leave dangling references after the
-- AI catalog is removed.
update director_script_revisions set ai_run_id = null, prompt_version_id = null;
update director_storyboard_revisions set ai_run_id = null, prompt_version_id = null;

drop table ai_runs;
drop table ai_model_profiles;
drop table ai_prompt_versions;
