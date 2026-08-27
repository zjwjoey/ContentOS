alter table renders add column attempt_id text;
alter table renders add column attempt_number integer check (attempt_number > 0);
alter table renders add constraint renders_attempt_pair_check check ((attempt_id is null) = (attempt_number is null));

create index renders_attempt_idx on renders (job_id, attempt_number);
