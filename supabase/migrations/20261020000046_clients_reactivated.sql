-- When a client last went live again and who did it, so the readiness check opens for that person.
-- restore_client also stamps them (see 20261020000045 for the rest of its body).
alter table public.clients add column if not exists reactivated_at timestamptz, add column if not exists reactivated_by uuid references public.profiles(id) on delete set null;
