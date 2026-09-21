alter table avatar_generations
  drop constraint if exists avatar_generations_billing_unit_check,
  drop constraint if exists avatar_generations_billing_quantity_check,
  drop column if exists billing_unit,
  drop column if exists billing_quantity;
