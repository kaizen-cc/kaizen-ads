-- The monthly target each email and organic social client is judged against (Nov 2026), one per client and line:
--   email   metric 'attributed_revenue'  target = Klaviyo-attributed revenue for the calendar month, in the account's currency
--   social  metric 'engagement_rate'     target = interactions / reach as a fraction (0.035 is 3.5%)
-- The Email and Social KPI boards and the email and social team's Overview read it; the reports read it to show target
-- against actual. A client with the service and no row (or a null target) shows every number neutral until one is set.
--
-- Reads follow the client (private.staff_can_see_client). There is no write policy: people set a target through a
-- server action, which checks they may (an exec, a lead, the line's head, or someone seated on that client in that
-- line) and writes with the server's rights. A target is replaced, never deleted: nothing here deletes anything.
--
-- Additive and idempotent: safe to run more than once.

create table if not exists public.channel_targets (
  client_id   uuid not null references public.clients (id) on delete cascade,
  line        text not null check (line in ('email', 'social')),
  metric      text,
  target      numeric,
  notes       text,
  owner_id    uuid references public.profiles (id) on delete set null,
  updated_by  uuid references public.profiles (id) on delete set null,
  updated_at  timestamptz not null default now(),
  primary key (client_id, line)
);

alter table public.channel_targets enable row level security;

drop policy if exists "staff read channel targets" on public.channel_targets;
create policy "staff read channel targets" on public.channel_targets for select to authenticated
  using (private.staff_can_see_client(client_id));

comment on table public.channel_targets is 'Monthly target per client and line (email: Klaviyo-attributed revenue; social: engagement rate as a fraction). Written by server actions only.';
comment on column public.channel_targets.metric is 'email: attributed_revenue · social: engagement_rate';
comment on column public.channel_targets.target is 'email: revenue for the calendar month · social: interactions / reach as a fraction (0.035 = 3.5%)';
