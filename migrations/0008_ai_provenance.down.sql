alter table director_storyboard_revisions
  drop constraint director_storyboard_revisions_prompt_version_fk,
  drop constraint director_storyboard_revisions_ai_run_fk;

alter table director_script_revisions
  drop constraint director_script_revisions_prompt_version_fk,
  drop constraint director_script_revisions_ai_run_fk;

drop table ai_runs;
drop table ai_model_profiles;
drop table ai_prompt_versions;
