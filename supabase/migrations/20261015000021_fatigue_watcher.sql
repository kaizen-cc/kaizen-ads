-- The fatigue watcher: every live ad compared with its own last three weeks (and with how the whole account moved),
-- after each Meta sync. Tiring ads go to the buyer on Home and the client page, with a refresh brief one click away.
create table public.ad_fatigue (
  client_id uuid not null references public.clients (id) on delete cascade,
  ad_id text not null,
  ad_name text not null,
  campaign text,
  adset text,
  headline text,
  thumbnail text,
  severity text not null check (severity in ('tiring', 'tired')),
  signals jsonb not null, -- now vs before: ctr, cost per result, frequency, hook rate, spend, days running, the account's own move
  series jsonb not null default '[]', -- the last 28 days: { d, spend, ctr, cpr }
  state text not null default 'open' check (state in ('open', 'refreshing', 'dismissed', 'recovered')),
  first_flagged_at timestamptz not null default now(),
  last_seen_at timestamptz not null default now(),
  dismissed_by uuid references public.profiles (id),
  dismiss_reason text,
  request_numbers int[] not null default '{}',
  updated_at timestamptz not null default now(),
  primary key (client_id, ad_id)
);
create index ad_fatigue_open on public.ad_fatigue (state, severity) where state in ('open', 'refreshing');

alter table public.ad_fatigue enable row level security;
create policy "staff read fatigue" on public.ad_fatigue for select to authenticated using (private.staff_can_see_client(client_id));
create policy "staff update fatigue" on public.ad_fatigue for update to authenticated using (private.staff_can_see_client(client_id)) with check (private.staff_can_see_client(client_id));

-- A refresh brief for one tiring ad, drafted for whoever asked (like a brief from a winner)
alter table public.creative_suggestions drop constraint creative_suggestions_kind_check;
alter table public.creative_suggestions add constraint creative_suggestions_kind_check check (kind in ('fatigue', 'kpi', 'pacing', 'offer', 'unhappy', 'flop', 'lab', 'winner', 'refresh'));
drop index public.creative_suggestions_one_open;
create unique index creative_suggestions_one_open on public.creative_suggestions (client_id) where status = 'open' and kind not in ('lab', 'winner', 'refresh');
