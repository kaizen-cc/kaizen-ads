-- The client's plan approved on its own after 72 business hours without their answer
alter table public.client_presentations add column if not exists auto_approved boolean not null default false;
