-- The Meta go-to-market strategy for each client (Kaizen's GTM Strategy Builder, Meta paid media only). Built at
-- onboarding once the intake form, call notes and website are all in; once reviewed it feeds every agent.
create table public.client_gtm_strategies (
  client_id        uuid primary key references public.clients(id) on delete cascade,
  status           text not null default 'waiting' check (status in ('waiting', 'building', 'draft', 'reviewed', 'failed')),
  missing          text[] not null default '{}',
  version          text not null default 'v1.0',
  markdown         text not null default '',
  read_this_first  text not null default '',
  open_items       jsonb not null default '[]',
  quality          jsonb not null default '[]',
  research         text not null default '',
  error            text,
  started_at       timestamptz,
  generated_at     timestamptz,
  generated_by     uuid references public.profiles(id) on delete set null,
  reviewed_at      timestamptz,
  reviewed_by      uuid references public.profiles(id) on delete set null
);
alter table public.client_gtm_strategies enable row level security;
create policy "staff read gtm strategies" on public.client_gtm_strategies for select to authenticated using (private.staff_can_see_client(client_id));
create policy "leads review gtm strategies" on public.client_gtm_strategies for update to authenticated
  using (private.is_exec_or_lead()) with check (private.is_exec_or_lead());

insert into public.ai_agents (key, label, description, model, effort, live, sort_order, icon, sources) values
  ('gtm', 'Go-to-market strategist', 'Builds each new client''s Meta go-to-market strategy once the intake form, call notes and website are in: business, customer, competitors, angles with ad copy, Meta campaign plan and a 90-day profitability roadmap. Never invents a number, offer or review; anything unconfirmed is an open item.', 'opus', 'high', true, 15, 'compass', '{}')
on conflict (key) do nothing;
