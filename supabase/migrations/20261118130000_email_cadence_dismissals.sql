-- Email design KPIs (Nov 2026): an exec or the Head of Email can set a client's sending cycle aside (a pause on the
-- client's side, billing dates out of step), with why. That cycle drops into "Dismissed" on the Email design KPIs and is
-- never flagged as "nothing sent", the way allotment_dismissals works for the creative team.
--
-- Reads: staff who can see the client, checked once per query. Writes: only the server (the action checks who's
-- asking, then writes with the service role). Additive and idempotent: safe to run more than once. Until it's applied
-- the KPI tab reads no dismissals and the Dismiss button says it couldn't save.

create table if not exists public.email_cadence_dismissals (
  client_id     uuid not null references public.clients (id) on delete cascade,
  period_start  date not null,
  reason        text,
  dismissed_by  uuid references public.profiles (id) on delete set null,
  dismissed_at  timestamptz not null default now(),
  primary key (client_id, period_start)
);

alter table public.email_cadence_dismissals enable row level security;
drop policy if exists "staff read email cadence dismissals" on public.email_cadence_dismissals;
create policy "staff read email cadence dismissals" on public.email_cadence_dismissals for select to authenticated
  using ((select private.staff_sees_all()) or coalesce(client_id = any ((select private.staff_client_ids())::uuid[]), false));

comment on table public.email_cadence_dismissals is 'A client''s email sending cycle set aside on the Email design KPIs (why, by whom), so it is not flagged as nothing sent';
