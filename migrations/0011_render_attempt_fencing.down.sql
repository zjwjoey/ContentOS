drop index renders_attempt_idx;

alter table renders drop constraint renders_attempt_pair_check;
alter table renders drop column attempt_number;
alter table renders drop column attempt_id;
