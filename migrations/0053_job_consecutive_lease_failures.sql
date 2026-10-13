alter table jobs add column consecutive_lease_failures integer not null default 0 check (consecutive_lease_failures >= 0);
