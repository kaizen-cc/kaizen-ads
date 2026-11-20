-- The daily watchdogs (src/lib/watchdogs): same-day checks kept as account watch flags, once per issue, told to the
-- account owner and the line's head in Kaizen OS. Their kinds join the watch's; web design clients' sites are checked
-- hourly (up or down) and weekly (the page itself), kept a month in site_checks.

alter table public.watch_flags drop constraint if exists watch_flags_kind_check;
alter table public.watch_flags add constraint watch_flags_kind_check check (kind in (
  'idle', 'neglected', 'overtouched', 'spend_spike', 'spend_drop', 'spend_stopped', 'overspend', 'creative_behind', 'creative_quiet', 'creative_sprint', 'unrecognized',
  'client_changed', 'admin_removal', 'unapproved_change', 'over_budget', 'zero_results', 'past_event', 'special_category', 'lead_no_crm', 'access_lost',
  'integration_auth', 'payment_issue', 'delivery_issue', 'quiet_channel', 'creative_stuck', 'big_date', 'site_down', 'site_check'
));

create table if not exists public.site_checks (
  id          uuid primary key default gen_random_uuid(),
  client_id   uuid not null references public.clients(id) on delete cascade,
  url         text not null,
  kind        text not null check (kind in ('uptime', 'page')),
  ok          boolean not null,
  status      integer,
  ms          integer,
  error       text,
  checked_at  timestamptz not null default now()
);
create index if not exists site_checks_client on public.site_checks (client_id, kind, checked_at desc);
alter table public.site_checks enable row level security;
drop policy if exists "staff read site checks" on public.site_checks;
create policy "staff read site checks" on public.site_checks for select to authenticated
  using ((select private.staff_sees_all()) or coalesce(client_id = any ((select private.staff_client_ids())::uuid[]), false));
