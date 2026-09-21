alter table avatar_generations
  add column billing_quantity numeric(14,4),
  add column billing_unit text;

alter table avatar_generations
  add constraint avatar_generations_billing_quantity_check
  check (billing_quantity is null or billing_quantity >= 0);

alter table avatar_generations
  add constraint avatar_generations_billing_unit_check
  check (billing_unit is null or length(trim(billing_unit)) between 1 and 100);
