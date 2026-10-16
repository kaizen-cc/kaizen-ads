-- The Hall of Fame: our ads that hit or beat their client's KPI target (or their sub-vertical's benchmark) over 30+
-- days live, kept for six months after they last qualified, with a saved copy of the creative.
create table public.hall_of_fame (
  ad_id            text primary key,
  client_id        uuid not null references public.clients(id) on delete cascade,
  vertical_id      uuid references public.verticals(id) on delete set null,
  ad_name          text,
  campaign_name    text,
  first_date       date not null,
  last_date        date not null,
  days_live        int not null,
  spend            numeric not null,
  results          numeric not null,
  value            numeric not null,     -- cost per result, or ROAS
  roas             boolean not null default false,
  conversion       text not null,        -- what a result is ("Purchases", "Meta Lead Form"…)
  target           numeric not null,
  target_source    text not null check (target_source in ('kpi', 'benchmark')),
  beat_by          numeric not null,     -- 0.25 = 25% better than the target
  creative         jsonb not null default '{}', -- { headline, text, cta, link, image, video, poster, page }
  qualified_at     timestamptz not null default now(),
  last_qualified_at timestamptz not null default now(),
  expires_at       timestamptz not null,
  updated_at       timestamptz not null default now()
);
create index hall_of_fame_vertical on public.hall_of_fame (vertical_id, expires_at desc);
alter table public.hall_of_fame enable row level security;
create policy "staff read hall of fame" on public.hall_of_fame for select to authenticated using (private.is_staff());

-- Saved creative for the Hall of Fame (Meta's own links expire)
insert into storage.buckets (id, name, public) values ('hall-of-fame', 'hall-of-fame', true) on conflict (id) do nothing;
