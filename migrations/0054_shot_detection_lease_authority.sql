alter table script_editing_v3_shot_detection_runs add column lease_authority jsonb;
alter table script_editing_v3_shot_detection_runs add constraint shot_detection_lease_authority_object check (lease_authority is null or jsonb_typeof(lease_authority) = 'object');
